import { ProviderRegistry } from '../providers/provider-registry.js'
import { CacheService } from '../core/cache.js'
import { SourceResponse, ProviderResult, ResponseIdMapping, ProviderMediaObject, Diagnostic, Subtitle, Source, ProxyData, SourceDiscoveryEvent, SourceDiscoveryOptions } from '../core/types/index.js'
import { createTMDBValidator } from '../middleware/validation.js'
import { OMSSErrors } from '../core/errors.js'
import { TMDBService } from '../services/tmdb.service.js'
import { StremioService } from './stremio.service.js'
import { ProxyService } from './proxy.service.js'
import { SourceValidationQueue } from './source-validation-queue.js'

export class SourceService {
    private cleanupTimer: NodeJS.Timeout
    private tmdbValidator: ReturnType<typeof createTMDBValidator>
    private validationQueue = new SourceValidationQueue(() => this.validationSetting('SOURCE_VALIDATION_CONCURRENCY', 4, 1, 16))
    private responseIdMap: Map<string, ResponseIdMapping> = new Map()

    constructor(
        private registry: ProviderRegistry,
        private cache: CacheService,
        private tmdbService: TMDBService,
        private stremioService: StremioService,
        private cacheTTL = { sources: 7200, subtitles: 86400 }
    ) {
        this.cleanupTimer = setInterval(() => this.cleanupExpiredMappings(), 60 * 60 * 1000)
        this.cleanupTimer.unref()
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

    discoveryTimeoutMs(): number {
        return this.validationSetting('SOURCE_DISCOVERY_TIMEOUT_MS', 30000, 1000, 120000)
    }

    async streamMovieSources(tmdbId: string, emit: (event: SourceDiscoveryEvent) => Promise<void>, options: SourceDiscoveryOptions = {}): Promise<void> {
        return this.streamSources('movie', tmdbId, undefined, undefined, emit, options)
    }

    async streamTVSources(tmdbId: string, season: number, episode: number, emit: (event: SourceDiscoveryEvent) => Promise<void>, options: SourceDiscoveryOptions = {}): Promise<void> {
        return this.streamSources('tv', tmdbId, season, episode, emit, options)
    }

    private async streamSources(
        type: 'movie' | 'tv',
        tmdbId: string,
        season: number | undefined,
        episode: number | undefined,
        emit: (event: SourceDiscoveryEvent) => Promise<void>,
        options: SourceDiscoveryOptions
    ): Promise<void> {
        const controller = new AbortController(),
            signal = controller.signal
        let timedOut = false,
            completedProviders = 0,
            accepting = true
        const timeoutMs = Math.min(120000, Math.max(1, options.timeoutMs ?? this.discoveryTimeoutMs()))
        const timer = setTimeout(() => {
            timedOut = true
            controller.abort()
        }, timeoutMs)
        timer.unref()
        const abort = () => controller.abort()
        options.signal?.addEventListener('abort', abort, { once: true })
        if (options.signal?.aborted) controller.abort()
        const providers = this.registry.getProviders().filter((p) => p.enabled && p.capabilities.supportedContentTypes.includes(type === 'movie' ? 'movies' : 'tv'))
        const addons = this.stremioService?.hasEnabledAddons()
        const totalProviders = providers.length + (addons ? 1 : 0)
        const responseId = crypto.randomUUID()
        let expiresAt = new Date(Date.now() + this.cacheTTL.sources * 1000).toISOString()
        const sources = new Map<string, Source>(),
            subtitles = new Map<string, Subtitle>()
        const diagnostics: Diagnostic[] = []
        const cacheKey = type === 'movie' ? `movie:${tmdbId}` : `tv:${tmdbId}:s${season}:e${episode}`
        let mappingStored = false
        const ensureMapping = () => {
            if (mappingStored) return
            mappingStored = true
            this.storeResponseIdMapping(responseId, { cacheKey, type, tmdbId, ...(type === 'tv' ? { season, episode } : {}), createdAt: Date.now() })
        }
        let pendingEvent: SourceDiscoveryEvent | undefined
        let writer: Promise<void> | undefined
        const snapshot = (): SourceResponse => ({ responseId, expiresAt, sources: [...sources.values()], subtitles: [...subtitles.values()], diagnostics: [...diagnostics] })
        const event = (eventType: SourceDiscoveryEvent['type']): SourceDiscoveryEvent => ({
            type: eventType,
            response: snapshot(),
            completedProviders,
            totalProviders,
            ...(timedOut ? { timedOut: true } : {}),
        })
        const bounded = <T>(operation: Promise<T>): Promise<T> =>
            new Promise((resolve, reject) => {
                const cancelled = () => reject(new DOMException('Source discovery was cancelled', 'AbortError'))
                if (signal.aborted) {
                    operation.catch(() => {})
                    cancelled()
                    return
                }
                signal.addEventListener('abort', cancelled, { once: true })
                operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled))
            })
        const send = (value: SourceDiscoveryEvent): Promise<void> => {
            // One write in flight and one newest cumulative snapshot: slow clients
            // cannot accumulate a response-sized buffer for every discovered source.
            pendingEvent = value
            if (!writer) {
                writer = Promise.resolve().then(async () => {
                    try {
                        while (pendingEvent && accepting && !signal.aborted) {
                            const next = pendingEvent
                            pendingEvent = undefined
                            await emit(next)
                        }
                    } finally {
                        writer = undefined
                    }
                })
            }
            return bounded(writer)
        }
        const addResult = async (result: ProviderResult, group: string): Promise<void> => {
            if (!accepting || signal.aborted) return
            diagnostics.push(...(result.diagnostics ?? []))
            for (const subtitle of result.subtitles ?? []) subtitles.set(subtitle.url, subtitle)
            await Promise.allSettled(
                result.sources
                    .filter((source) => source.type !== 'embed')
                    .map(async (source) => {
                        if (signal.aborted) return
                        let proxyData: ProxyData
                        try {
                            const data = new URL(source.url, 'http://localhost').searchParams.get('data')
                            if (!data) return
                            proxyData = ProxyService.decodeProxyData(data)
                        } catch {
                            return
                        }
                        const outcome = await this.validationQueue.run(
                            `${responseId}:${group}`,
                            () => this.validateSourceUrl(proxyData, source, this.validationSetting('SOURCE_VALIDATION_TIMEOUT_MS', 8000, 1000, 30000), signal, true),
                            signal
                        )
                        if (outcome !== 'valid' || signal.aborted || !accepting) return
                        // Request context (especially audio preference) is part of playable identity.
                        const key = JSON.stringify([proxyData.url, proxyData.headers ?? {}, proxyData.preferredAudioLanguage ?? '', proxyData.responseTransform ?? ''])
                        if (sources.has(key)) return
                        sources.set(key, source)
                        ensureMapping()
                        await send(event('update'))
                    })
            )
        }
        try {
            await send(event('start'))
            if (type === 'movie') await bounded(this.tmdbValidator.validateMovie(tmdbId))
            else await bounded(this.tmdbValidator.validateTVEpisode(tmdbId, season!, episode!))
            const cached = options.refresh ? null : await bounded(this.cache.get<SourceResponse>(cacheKey))
            if (cached) {
                if (Number.isFinite(Date.parse(cached.expiresAt)) && Date.parse(cached.expiresAt) > Date.now()) {
                    expiresAt = cached.expiresAt
                    await bounded(addResult(cached, 'cache'))
                    if (sources.size) {
                        completedProviders = totalProviders
                        ensureMapping()
                        await send(event('complete'))
                        return
                    }
                }
                // Expired/signed links cannot keep an otherwise cacheable title empty.
                subtitles.clear()
                diagnostics.length = 0
                await bounded(this.cache.delete(cacheKey))
            }
            expiresAt = new Date(Date.now() + this.cacheTTL.sources * 1000).toISOString()
            const media = await bounded(this.tmdbService.getMediaObject(type, tmdbId, season, episode))
            media.imdbId = (await bounded(this.tmdbService.getImdbId(tmdbId, type))) ?? ''
            const run = async (group: string, task: () => Promise<ProviderResult>) => {
                try {
                    const result = await task()
                    if (signal.aborted || !accepting) return
                    await addResult(result, group)
                } catch {
                    if (!signal.aborted && accepting) diagnostics.push({ code: 'PROVIDER_ERROR', message: `Provider ${group} failed to resolve sources`, field: '', severity: 'warning' })
                } finally {
                    if (!signal.aborted && accepting) {
                        completedProviders++
                        await send(event('update'))
                    }
                }
            }
            const tasks = providers.map((provider) => run(provider.id, () => (type === 'movie' ? provider.getMovieSources(media) : provider.getTVSources(media))))
            if (addons) tasks.push(run('stremio', () => (type === 'movie' ? this.stremioService.getMovieSources(media) : this.stremioService.getTVSources(media))))
            await bounded(Promise.allSettled(tasks))
            if (!signal.aborted && sources.size) {
                const response = snapshot()
                ensureMapping()
                await bounded(this.cache.set(cacheKey, response, this.cacheTTL.sources))
            }
            await send(event('complete'))
        } catch (error) {
            if (!timedOut) throw error
            // A deadline ends this search, but keeps already verified partial results usable.
            accepting = false
            if (!options.signal?.aborted) await emit(event('complete'))
        } finally {
            accepting = false
            clearTimeout(timer)
            controller.abort()
            options.signal?.removeEventListener('abort', abort)
        }
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

    private async validateSourceUrl(proxyData: ProxyData, source: Source, timeoutMs: number, signal?: AbortSignal, strict = false): Promise<'valid' | 'invalid' | 'transient'> {
        if (!strict && process.env.INTERNAL_DEBUG === 'true') {
            return 'valid'
        }

        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) controller.abort()
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
            if (!strict && source.type !== 'hls') {
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
                        if (strict && source.type !== 'hls' && source.type !== 'dash' && length >= 16) break
                    }
                }
            } finally {
                await reader.cancel().catch(() => undefined)
            }

            const bytes = Buffer.concat(
                chunks.map((chunk) => Buffer.from(chunk)),
                length
            ).subarray(0, 4096)
            const prefix = bytes.toString('utf8').trimStart()
            if (source.type === 'hls') return prefix.startsWith('#EXTM3U') ? 'valid' : 'invalid'
            if (source.type === 'dash') return /^(?:<\?xml[^>]*>\s*)?<(?:[A-Za-z0-9_]+:)?MPD(?:\s|>)/.test(prefix) ? 'valid' : 'invalid'
            // A 200 HTML/JSON error document must never become the first advertised video.
            if (/^(?:[<{\[]|#EXTM3U)/.test(prefix)) return 'invalid'
            const atom = bytes.subarray(4, 8).toString('ascii')
            const isoMedia = bytes.length >= 12 && ['ftyp', 'moov', 'mdat', 'free', 'wide', 'styp', 'moof'].includes(atom)
            const ebml = bytes.length >= 8 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
            const transport = bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47)
            const program = bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0xba
            return isoMedia || ebml || transport || program ? 'valid' : 'invalid'
        } catch {
            return 'transient'
        } finally {
            clearTimeout(timeout)
            signal?.removeEventListener('abort', abort)
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
                    outcomes[taskIndex] = await this.validationQueue.run('legacy:' + task.resultIndex, () => this.validateSourceUrl(ProxyService.decodeProxyData(data), task.source, timeoutMs))
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
        clearInterval(this.cleanupTimer)
        this.responseIdMap.clear()
        console.log('[SourceService] Destroyed and cleared all mappings')
    }
}
