import { ProviderRegistry } from '../providers/provider-registry.js'
import { CacheService } from '../core/cache.js'
import { SourceResponse, ProviderResult, ResponseIdMapping, ProviderMediaObject, Diagnostic, Subtitle, Source, ProxyData } from '../core/types/index.js'
import { createTMDBValidator } from '../middleware/validation.js'
import { OMSSErrors } from '../core/errors.js'
import { TMDBService } from '../services/tmdb.service.js'
import { StremioService } from './stremio.service.js'
import { ProxyService } from './proxy.service.js'

export class SourceService {
    private tmdbValidator: ReturnType<typeof createTMDBValidator>
    private responseIdMap: Map<string, ResponseIdMapping> = new Map()

    constructor(
        private registry: ProviderRegistry,
        private cache: CacheService,
        private tmdbService: TMDBService,
        private stremioService: StremioService,
        private cacheTTL = { sources: 7200, subtitles: 86400 }
    ) {
        setInterval(() => this.cleanupExpiredMappings(), 60 * 60 * 1000)
        this.tmdbValidator = createTMDBValidator(tmdbService)
    }

    /**
     * Get movie sources from all providers
     */
    async getMovieSources(tmdbId: string): Promise<SourceResponse> {
        await this.tmdbValidator.validateMovie(tmdbId)

        const cacheKey = `movie:${tmdbId}`

        // Check cache first
        const cached = await this.cache.get<SourceResponse>(cacheKey)
        if (cached) {
            console.log(`[SourceService] Cache HIT for ${cacheKey}`)
            return cached
        }

        console.log(`[SourceService] Cache MISS for ${cacheKey}`)

        // Build media object for providers
        const media = await this.tmdbService.getMediaObject('movie', tmdbId)

        // Try to get IMDB ID
        media.imdbId = (await this.tmdbService.getImdbId(tmdbId, 'movie')) ?? ''

        // Fetch from providers and Stremio addons concurrently
        const [providerResults, stremioResult] = await Promise.all([
            this.fetchFromProviders('movie', media),
            this.stremioService?.hasEnabledAddons()
                ? this.stremioService.getMovieSources(media).catch(
                      (err): ProviderResult => ({
                          sources: [],
                          subtitles: [],
                          diagnostics: [
                              {
                                  code: 'PROVIDER_ERROR',
                                  message: `Stremio integration failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                                  field: '',
                                  severity: 'error',
                              },
                          ],
                      })
                  )
                : Promise.resolve(null),
        ])

        const allResults: ProviderResult[] = [...providerResults]
        if (stremioResult) allResults.push(stremioResult)

        const response = this.buildResponse(allResults)

        // Throw error if no sources found
        if (response.sources.length === 0) {
            throw OMSSErrors.noSourcesAvailable(tmdbId, this.registry.getEnabledProviders().length)
        }

        // Store responseId mapping
        this.storeResponseIdMapping(response.responseId, {
            cacheKey,
            type: 'movie',
            tmdbId,
            createdAt: Date.now(),
        })

        // Cache the response
        await this.cache.set(cacheKey, response, this.cacheTTL.sources)

        return response
    }

    /**
     * Get TV episode sources from all providers
     */
    async getTVSources(tmdbId: string, season: number, episode: number): Promise<SourceResponse> {
        await this.tmdbValidator.validateTVEpisode(tmdbId, season, episode)

        const cacheKey = `tv:${tmdbId}:s${season}:e${episode}`

        // Check cache
        const cached = await this.cache.get<SourceResponse>(cacheKey)
        if (cached) {
            console.log(`[SourceService] Cache HIT for ${cacheKey}`)
            return cached
        }

        console.log(`[SourceService] Cache MISS for ${cacheKey}`)

        // Build media object for providers
        const media = await this.tmdbService.getMediaObject('tv', tmdbId, season, episode)

        // Try to get IMDB ID
        media.imdbId = (await this.tmdbService.getImdbId(tmdbId, 'tv')) ?? ''

        // Fetch from providers and Stremio addons concurrently
        const [providerResults, stremioResult] = await Promise.all([
            this.fetchFromProviders('tv', media),
            this.stremioService?.hasEnabledAddons()
                ? this.stremioService.getTVSources(media).catch(
                      (err): ProviderResult => ({
                          sources: [],
                          subtitles: [],
                          diagnostics: [
                              {
                                  code: 'PROVIDER_ERROR',
                                  message: `Stremio integration failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                                  field: '',
                                  severity: 'error',
                              },
                          ],
                      })
                  )
                : Promise.resolve(null),
        ])

        const allResults: ProviderResult[] = [...providerResults]
        if (stremioResult) allResults.push(stremioResult)

        const response = this.buildResponse(allResults)

        // Throw error if no sources found
        if (response.sources.length === 0) {
            throw OMSSErrors.noSourcesAvailable(`${tmdbId}/S${season}E${episode}`, this.registry.getEnabledProviders().length)
        }

        // Store responseId mapping
        this.storeResponseIdMapping(response.responseId, {
            cacheKey,
            type: 'tv',
            tmdbId,
            season,
            episode,
            createdAt: Date.now(),
        })

        // Cache the response
        await this.cache.set(cacheKey, response, this.cacheTTL.sources)

        return response
    }

    /**
     * Refresh cached sources by responseId
     */
    async refreshSource(responseId: string): Promise<void> {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(responseId)) {
            throw OMSSErrors.invalidResponseId(responseId)
        }

        const mapping = this.responseIdMap.get(responseId)

        if (!mapping) {
            console.warn(`[SourceService] No mapping found for responseId: ${responseId}`)
            throw OMSSErrors.responseIdNotFound(responseId)
        }

        console.log(`[SourceService] Refreshing cache for ${mapping.cacheKey} (responseId: ${responseId})`)

        await this.cache.delete(mapping.cacheKey)
        this.responseIdMap.delete(responseId)

        console.log(`[SourceService] Successfully refreshed cache for ${mapping.cacheKey}`)
    }

    /**
     * Store responseId to cacheKey mapping
     */
    private storeResponseIdMapping(responseId: string, mapping: ResponseIdMapping): void {
        this.responseIdMap.set(responseId, mapping)
        console.log(`[SourceService] Stored mapping: ${responseId} -> ${mapping.cacheKey}`)
    }

    /**
     * Cleanup expired responseId mappings
     */
    private cleanupExpiredMappings(): void {
        const now = Date.now()
        const maxAge = this.cacheTTL.sources * 1000
        let cleaned = 0

        for (const [responseId, mapping] of this.responseIdMap.entries()) {
            if (now - mapping.createdAt > maxAge) {
                this.responseIdMap.delete(responseId)
                cleaned++
            }
        }

        if (cleaned > 0) {
            console.log(`[SourceService] Cleaned up ${cleaned} expired responseId mapping(s)`)
        }
    }

    private async validateSourceUrl(proxyData: ProxyData, source: Source, timeoutMs: number): Promise<'valid' | 'invalid' | 'transient'> {
        if (process.env.INTERNAL_DEBUG === 'true') {
            return 'valid'
        }

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), timeoutMs)

        try {
            const res = await fetch(proxyData.url, {
                method: 'GET',
                headers: proxyData.headers ?? {},
                signal: controller.signal,
            })

            if (res.status === 429 || res.status >= 500) {
                await res.body?.cancel()
                return 'transient'
            }
            if (!res.ok) {
                await res.body?.cancel()
                return 'invalid'
            }
            if (source.type !== 'hls') {
                await res.body?.cancel()
                return 'valid'
            }
            if (!res.body) return 'invalid'

            const reader = res.body.getReader()
            const chunks: Uint8Array[] = []
            let length = 0
            try {
                while (length < 4096) {
                    const { value, done } = await reader.read()
                    if (done) break
                    if (value) {
                        chunks.push(value)
                        length += value.length
                    }
                }
            } finally {
                await reader.cancel().catch(() => undefined)
            }

            const prefix = Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk)),
                length
            )
                .subarray(0, 4096)
                .toString('utf8')
                .trimStart()
            return prefix.startsWith('#EXTM3U') ? 'valid' : 'invalid'
        } catch {
            return 'transient'
        } finally {
            clearTimeout(timeout)
        }
    }

    private validationSetting(name: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(process.env[name] ?? '', 10)
        return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
    }

    private async validateProviderResults(results: ProviderResult[]): Promise<void> {
        const tasks = results.flatMap((result, resultIndex) => result.sources.map((source, sourceIndex) => ({ resultIndex, sourceIndex, source })))
        if (tasks.length === 0) return

        const timeoutMs = this.validationSetting('SOURCE_VALIDATION_TIMEOUT_MS', 8000, 1000, 30000)
        const concurrency = this.validationSetting('SOURCE_VALIDATION_CONCURRENCY', 4, 1, 16)
        const outcomes = new Array<'valid' | 'invalid' | 'transient'>(tasks.length)
        let cursor = 0

        const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
            while (cursor < tasks.length) {
                const taskIndex = cursor++
                const task = tasks[taskIndex]
                try {
                    const data = new URL(task.source.url, 'http://localhost').searchParams.get('data')
                    if (!data) {
                        outcomes[taskIndex] = 'invalid'
                        continue
                    }
                    outcomes[taskIndex] = await this.validateSourceUrl(ProxyService.decodeProxyData(data), task.source, timeoutMs)
                } catch {
                    outcomes[taskIndex] = 'invalid'
                }
            }
        })
        await Promise.all(workers)

        results.forEach((result, resultIndex) => {
            const original = result.sources
            const providerTasks = tasks.map((task, taskIndex) => ({ task, outcome: outcomes[taskIndex] })).filter(({ task }) => task.resultIndex === resultIndex)
            const dropped = new Set(providerTasks.filter(({ outcome }) => outcome === 'invalid').map(({ task }) => task.sourceIndex))
            const transientCount = providerTasks.filter(({ outcome }) => outcome === 'transient').length
            result.sources = original.filter((_, sourceIndex) => !dropped.has(sourceIndex))

            if (dropped.size > 0) {
                result.diagnostics.push({
                    code: result.sources.length > 0 ? 'PARTIAL_SCRAPE' : 'PROVIDER_ERROR',
                    message: `Source validation rejected ${dropped.size} of ${original.length} source(s)`,
                    field: '',
                    severity: result.sources.length > 0 ? 'warning' : 'error',
                })
            }
            if (transientCount > 0) {
                result.diagnostics.push({
                    code: 'PARTIAL_SCRAPE',
                    message: `Source validation retained ${transientCount} source(s) after a transient upstream failure`,
                    field: '',
                    severity: 'warning',
                })
            }
        })
    }

    /**
     * Fetch results from all providers concurrently
     */
    private async fetchFromProviders(type: 'movie' | 'tv', media: ProviderMediaObject): Promise<ProviderResult[]> {
        const providers = this.registry.getProviders()

        if (providers.length === 0) {
            console.warn('[SourceService] No providers registered')
            return []
        }

        // Filter providers by capability
        const supportedProviders = providers.filter((p) => p.capabilities.supportedContentTypes.includes(type === 'movie' ? 'movies' : 'tv')).filter((p) => p.enabled)

        console.log(`[SourceService] Fetching from ${supportedProviders.length} provider(s) ` + `(${providers.length - supportedProviders.length} filtered out)`)

        const promises = supportedProviders.map(async (provider) => {
            try {
                const startTime = Date.now()
                let result: ProviderResult

                if (type === 'movie') {
                    result = await provider.getMovieSources(media)
                } else {
                    result = await provider.getTVSources(media)
                }

                const duration = Date.now() - startTime
                console.log(`[SourceService] Provider '${provider.name}' returned ${result.sources.length} source(s) in ${duration}ms`)

                return result
            } catch (error) {
                console.error(`[SourceService] Provider '${provider.name}' failed:`, error)

                return {
                    sources: [],
                    subtitles: [],
                    diagnostics: [
                        {
                            code: 'PROVIDER_ERROR' as const,
                            message: `Provider '${provider.name}' failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            field: '',
                            severity: 'error' as const,
                        },
                    ],
                }
            }
        })

        const results = await Promise.allSettled(promises)

        const fulfilled = results.filter((r): r is PromiseFulfilledResult<ProviderResult> => r.status === 'fulfilled').map((r) => r.value)

        if (process.env.NODE_ENV?.toLowerCase() !== 'test') {
            await this.validateProviderResults(fulfilled)
        }

        return fulfilled
    }

    /**
     * Build final response from provider results
     * Deduplicates sources and subtitles by URL
     */
    private buildResponse(results: ProviderResult[]): SourceResponse {
        const allSourcesMap = new Map<string, Source>()
        const allSubtitlesMap = new Map<string, Subtitle>()
        const allDiagnostics: Diagnostic[] = []

        // Deduplicate sources by URL
        results.forEach((r) => {
            r.sources.forEach((source) => {
                try {
                    const urlObj = new URL(source.url)
                    const data = urlObj.searchParams.get('data')
                    if (!data) throw new Error('Missing data parameter in source URL')

                    const proxyData = ProxyService.decodeProxyData(data)

                    // Use upstream URL as dedup key, but store the original source (with proxy URL)
                    if (!allSourcesMap.has(proxyData.url)) {
                        allSourcesMap.set(proxyData.url, source)
                    }
                } catch (error) {
                    console.warn(`[SourceService] Failed to decode source URL: ${source.url}`, error)
                    // Fallback: dedup by proxy URL itself
                    if (!allSourcesMap.has(source.url)) {
                        allSourcesMap.set(source.url, source)
                    }
                }
            })

            // Deduplicate subtitles by URL
            r.subtitles.forEach((subtitle) => {
                try {
                    const urlObj = new URL(subtitle.url)
                    const data = urlObj.searchParams.get('data')
                    if (!data) throw new Error('Missing data parameter in subtitle URL')

                    const proxyData = ProxyService.decodeProxyData(data)

                    if (!allSubtitlesMap.has(proxyData.url)) {
                        allSubtitlesMap.set(proxyData.url, subtitle)
                    }
                } catch (error) {
                    console.warn(`[SourceService] Failed to decode subtitle URL: ${subtitle.url}`, error)
                    if (!allSubtitlesMap.has(subtitle.url)) {
                        allSubtitlesMap.set(subtitle.url, subtitle)
                    }
                }
            })

            // Collect all diagnostics
            allDiagnostics.push(...r.diagnostics)
        })

        const uniqueSources = Array.from(allSourcesMap.values())
        const uniqueSubtitles = Array.from(allSubtitlesMap.values())

        const failedProviders = results.filter((r) => r.sources.length === 0).length
        if (failedProviders > 0 && uniqueSources.length > 0) {
            allDiagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `Only ${results.length - failedProviders} of ${results.length} providers returned results`,
                field: '',
                severity: 'warning',
            })
        }

        const expiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()

        return {
            responseId: crypto.randomUUID(),
            expiresAt,
            sources: uniqueSources,
            subtitles: uniqueSubtitles,
            diagnostics: allDiagnostics,
        }
    }

    /**
     * Get mapping info for debugging
     */
    getMappingInfo(responseId: string): ResponseIdMapping | undefined {
        return this.responseIdMap.get(responseId)
    }

    /**
     * Get all mappings count
     */
    getMappingsCount(): number {
        return this.responseIdMap.size
    }

    /**
     * Cleanup on service shutdown
     */
    destroy(): void {
        this.responseIdMap.clear()
        console.log('[SourceService] Destroyed and cleared all mappings')
    }
}
