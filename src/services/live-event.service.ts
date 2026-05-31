import { CacheService } from '../core/cache.js'
import { OMSSErrors } from '../core/errors.js'
import {
    Diagnostic,
    LiveEventManifest,
    LiveEventProviderRef,
    LiveEventStatus,
    LiveProvider,
    LiveSourceResponse,
    ProviderLiveEventCandidate,
    ProviderResult,
    Source,
    Subtitle,
} from '../core/types/index.js'
import { ProviderRegistry } from '../providers/provider-registry.js'
import { BaseProvider } from '../providers/base-provider.js'
import { ProxyService } from './proxy.service.js'

export interface LiveEventCacheTTL {
    manifest: number
    sources: number
}

export interface LiveEventListOptions {
    refresh?: boolean
}

export interface LiveEventSourceOptions {
    refresh?: boolean
}

const LIVE_MANIFEST_CACHE_KEY = 'live:manifest'
const DEFAULT_EVENT_DURATION_MS = 4 * 60 * 60 * 1000

export class LiveEventService {
    constructor(
        private registry: ProviderRegistry,
        private cache: CacheService,
        private cacheTTL: LiveEventCacheTTL = { manifest: 6 * 60 * 60, sources: 30 }
    ) {}

    async getEvents(options: LiveEventListOptions = {}): Promise<LiveEventManifest[]> {
        if (!options.refresh) {
            const cached = await this.cache.get<LiveEventManifest[]>(LIVE_MANIFEST_CACHE_KEY)
            if (cached) {
                return cached.map((event) => this.withCurrentStatus(event))
            }
        }

        const events = await this.discoverEvents()
        await this.cache.set(LIVE_MANIFEST_CACHE_KEY, events, this.cacheTTL.manifest)
        return events.map((event) => this.withCurrentStatus(event))
    }

    async getEvent(eventId: string, options: LiveEventListOptions = {}): Promise<LiveEventManifest> {
        const events = await this.getEvents(options)
        const event = events.find((candidate) => candidate.id === eventId)
        if (event) {
            return event
        }

        if (!options.refresh) {
            return this.getEvent(eventId, { refresh: true })
        }

        throw OMSSErrors.eventNotFound(eventId)
    }

    async getLiveEventSources(eventId: string, options: LiveEventSourceOptions = {}): Promise<LiveSourceResponse> {
        const event = await this.getEvent(eventId, { refresh: options.refresh })
        if (event.status === 'ended' || event.status === 'postponed') {
            throw OMSSErrors.eventNotLive(event.id, event.status)
        }

        const cacheKey = `live:sources:${event.id}`
        if (!options.refresh) {
            const cached = await this.cache.get<LiveSourceResponse>(cacheKey)
            if (cached) {
                return cached
            }
        }

        const providerIds = new Set(event.providers.map((provider) => provider.providerId))
        const providers = this.registry.getLiveProviders().filter((provider) => providerIds.has(provider.id))

        if (!providers.length) {
            throw OMSSErrors.noSourcesAvailable(event.id, 0)
        }

        const results = await this.fetchLiveSources(providers, event)
        const sourceResponse = this.buildSourceResponse(results, this.cacheTTL.sources)

        if (sourceResponse.sources.length === 0) {
            throw OMSSErrors.noSourcesAvailable(event.id, providers.length)
        }

        const response: LiveSourceResponse = {
            ...sourceResponse,
            event,
        }

        await this.cache.set(cacheKey, response, this.cacheTTL.sources)
        return response
    }

    private async discoverEvents(): Promise<LiveEventManifest[]> {
        const providers = this.registry.getLiveDiscoveryProviders()
        const checkedAt = new Date().toISOString()
        const results = await Promise.allSettled(
            providers.map(async (provider) => ({
                provider,
                events: await provider.getLiveEvents(),
            }))
        )

        const manifests = new Map<string, LiveEventManifest>()

        for (const result of results) {
            if (result.status !== 'fulfilled') {
                continue
            }

            for (const candidate of result.value.events) {
                const manifest = this.normalizeCandidate(candidate, result.value.provider, checkedAt)
                const existing = manifests.get(manifest.id)

                if (!existing) {
                    manifests.set(manifest.id, manifest)
                    continue
                }

                manifests.set(manifest.id, this.mergeEvent(existing, manifest))
            }
        }

        const enriched = await this.enrichEvents(Array.from(manifests.values()), checkedAt)
        return enriched.sort((left, right) => left.startsAt.localeCompare(right.startsAt) || left.title.localeCompare(right.title))
    }

    private async enrichEvents(events: LiveEventManifest[], checkedAt: string): Promise<LiveEventManifest[]> {
        const matchers = this.registry
            .getLiveProviders()
            .filter((provider): provider is BaseProvider & LiveProvider & { matchLiveEvent: (event: LiveEventManifest) => Promise<ProviderLiveEventCandidate | undefined> } => typeof provider.matchLiveEvent === 'function')

        if (!matchers.length) {
            return events
        }

        const enriched: LiveEventManifest[] = []
        for (const event of events) {
            let nextEvent = event

            for (const provider of matchers) {
                if (nextEvent.providers.some((ref) => ref.providerId === provider.id)) {
                    continue
                }

                try {
                    const candidate = await provider.matchLiveEvent(nextEvent)
                    if (candidate) {
                        nextEvent = this.mergeProviderCandidate(nextEvent, candidate, provider, checkedAt)
                    }
                } catch {
                    continue
                }
            }

            enriched.push(nextEvent)
        }

        return enriched
    }

    private async fetchLiveSources(providers: Array<BaseProvider & LiveProvider>, event: LiveEventManifest): Promise<ProviderResult[]> {
        const results = await Promise.allSettled(
            providers.map(async (provider) => {
                try {
                    return await provider.getLiveEventSources(event)
                } catch (error) {
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
        )

        return results.filter((result): result is PromiseFulfilledResult<ProviderResult> => result.status === 'fulfilled').map((result) => result.value)
    }

    private normalizeCandidate(candidate: ProviderLiveEventCandidate, provider: BaseProvider, checkedAt: string): LiveEventManifest {
        const startsAt = this.validIsoString(candidate.startsAt) ?? checkedAt
        const endsAt = this.validIsoString(candidate.endsAt)
        const league = this.normalizeToken(candidate.league ?? 'live')
        const sport = this.normalizeToken(candidate.sport ?? league)
        const status = candidate.status ?? this.deriveStatus(startsAt, endsAt)
        const providerRef = this.providerRefFromCandidate(candidate, provider, checkedAt)

        return {
            id: this.eventIdFor(candidate.title, league, sport, startsAt),
            title: candidate.title.trim(),
            league,
            sport,
            startsAt,
            endsAt,
            status,
            teams: candidate.teams,
            region: candidate.region,
            providers: [providerRef],
        }
    }

    private mergeEvent(left: LiveEventManifest, right: LiveEventManifest): LiveEventManifest {
        const providerRefs = new Map(left.providers.map((provider) => [provider.providerId, provider]))

        for (const provider of right.providers) {
            const existing = providerRefs.get(provider.providerId)
            providerRefs.set(provider.providerId, this.mergeProviderRefs(existing, provider))
        }

        return {
            ...left,
            endsAt: left.endsAt ?? right.endsAt,
            status: this.highestPriorityStatus(left.status, right.status),
            teams: left.teams ?? right.teams,
            region: left.region ?? right.region,
            providers: Array.from(providerRefs.values()).sort((a, b) => a.providerId.localeCompare(b.providerId)),
        }
    }

    private mergeProviderCandidate(event: LiveEventManifest, candidate: ProviderLiveEventCandidate, provider: BaseProvider, checkedAt: string): LiveEventManifest {
        const providerRef = this.providerRefFromCandidate(candidate, provider, checkedAt)
        const providerRefs = new Map(event.providers.map((ref) => [ref.providerId, ref]))
        providerRefs.set(provider.id, this.mergeProviderRefs(providerRefs.get(provider.id), providerRef))

        return {
            ...event,
            teams: event.teams ?? candidate.teams,
            region: event.region ?? candidate.region,
            providers: Array.from(providerRefs.values()).sort((a, b) => a.providerId.localeCompare(b.providerId)),
        }
    }

    private providerRefFromCandidate(candidate: ProviderLiveEventCandidate, provider: BaseProvider, checkedAt: string): LiveEventProviderRef {
        const hrefs = this.unique([candidate.href, ...(candidate.hrefs ?? [])])

        return {
            providerId: provider.id,
            internalEventId: candidate.internalEventId,
            href: hrefs[0],
            hrefs: hrefs.length ? hrefs : undefined,
            lastChecked: checkedAt,
            sourceCount: candidate.sourceCount ?? hrefs.length,
        }
    }

    private mergeProviderRefs(existing: LiveEventProviderRef | undefined, provider: LiveEventProviderRef): LiveEventProviderRef {
        const hrefs = this.unique([existing?.href, ...(existing?.hrefs ?? []), provider.href, ...(provider.hrefs ?? [])])

        return {
            ...existing,
            ...provider,
            href: hrefs[0],
            hrefs: hrefs.length ? hrefs : undefined,
            sourceCount: Math.max(existing?.sourceCount ?? 0, provider.sourceCount, hrefs.length),
        }
    }

    private withCurrentStatus(event: LiveEventManifest): LiveEventManifest {
        if (event.status === 'ended' || event.status === 'postponed') {
            return event
        }

        return {
            ...event,
            status: this.deriveStatus(event.startsAt, event.endsAt),
        }
    }

    private buildSourceResponse(results: ProviderResult[], ttlSeconds: number): Omit<LiveSourceResponse, 'event'> {
        const allSourcesMap = new Map<string, Source>()
        const allSubtitlesMap = new Map<string, Subtitle>()
        const allDiagnostics: Diagnostic[] = []

        for (const result of results) {
            for (const source of result.sources) {
                const key = this.dedupKey(source.url)
                if (!allSourcesMap.has(key)) {
                    allSourcesMap.set(key, source)
                }
            }

            for (const subtitle of result.subtitles) {
                const key = this.dedupKey(subtitle.url)
                if (!allSubtitlesMap.has(key)) {
                    allSubtitlesMap.set(key, subtitle)
                }
            }

            allDiagnostics.push(...result.diagnostics)
        }

        const uniqueSources = Array.from(allSourcesMap.values())
        const failedProviders = results.filter((result) => result.sources.length === 0).length

        if (failedProviders > 0 && uniqueSources.length > 0) {
            allDiagnostics.push({
                code: 'PARTIAL_SCRAPE',
                message: `Only ${results.length - failedProviders} of ${results.length} providers returned results`,
                field: '',
                severity: 'warning',
            })
        }

        return {
            responseId: crypto.randomUUID(),
            expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
            sources: uniqueSources,
            subtitles: Array.from(allSubtitlesMap.values()),
            diagnostics: allDiagnostics,
        }
    }

    private dedupKey(url: string): string {
        try {
            const urlObj = new URL(url)
            const data = urlObj.searchParams.get('data')
            if (!data) return url
            return ProxyService.decodeProxyData(data).url
        } catch {
            return url
        }
    }

    private eventIdFor(title: string, league: string, sport: string, startsAt: string): string {
        const date = startsAt.slice(0, 10)
        return [league, sport, date, this.slug(title)].filter(Boolean).join('-').slice(0, 160)
    }

    private deriveStatus(startsAt: string, endsAt?: string): LiveEventStatus {
        const now = Date.now()
        const start = new Date(startsAt).getTime()
        const end = endsAt ? new Date(endsAt).getTime() : start + DEFAULT_EVENT_DURATION_MS

        if (Number.isFinite(start) && now < start) return 'scheduled'
        if (Number.isFinite(end) && now > end) return 'ended'
        return 'live'
    }

    private highestPriorityStatus(left: LiveEventStatus, right: LiveEventStatus): LiveEventStatus {
        const rank: Record<LiveEventStatus, number> = {
            live: 4,
            scheduled: 3,
            postponed: 2,
            ended: 1,
        }

        return rank[right] > rank[left] ? right : left
    }

    private validIsoString(value?: string): string | undefined {
        if (!value) return undefined
        const parsed = new Date(value)
        if (!Number.isFinite(parsed.getTime())) return undefined
        return parsed.toISOString()
    }

    private normalizeToken(value: string): string {
        return this.slug(value) || 'live'
    }

    private unique(values: Array<string | undefined>): string[] {
        return Array.from(new Set(values.filter((value): value is string => Boolean(value))))
    }

    private slug(value: string): string {
        return value
            .trim()
            .toLowerCase()
            .replace(/&/g, ' and ')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
    }
}
