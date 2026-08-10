import { FastifyCorsOptions } from '@fastify/cors'
import { MCPConfig } from './mcp-types.js'

// OMSS v1.0 standard types + some custom stuff

export interface OMSSConfig {
    name: string
    version: string
    port?: number
    host?: string
    publicUrl?: string // Full public URL (e.g., https://api.example.com)
    cache?: CacheConfig
    tmdb?: {
        apiKey: string
        cacheTTL?: number
    }
    proxyConfig?: {
        knownThirdPartyProxies: Record<string, RegExp[]>
        streamPatterns: RegExp[]
    }
    note?: string
    cors?: FastifyCorsOptions
    stremio?: StremioConfig
    mcp?: MCPConfig
}

export interface CacheConfig {
    type: 'memory' | 'redis'
    redis?: {
        host: string
        port: number
        password?: string
    }
    ttl?: {
        sources: number // seconds
        subtitles: number
        liveManifest?: number
        liveSources?: number
    }
}

export interface StremioConfig {
    enableNativeAddon: boolean
    stremioAddons: StremioAddonConfig[]
}

export interface StremioAddonConfig {
    id: string
    url: string
    enabled?: boolean
    timeoutMs?: number
}

// OMSS Response Types
export interface SourceResponse {
    responseId: string
    expiresAt: string
    sources: Source[]
    subtitles: Subtitle[]
    diagnostics: Diagnostic[]
}

export interface Source {
    url: string
    type: SourceType
    quality: string
    audioTracks: AudioTrack[]
    provider: Provider
}

export type SourceType = 'hls' | 'dash' | 'http' | 'mp4' | 'mkv' | 'webm' | 'embed'

export interface AudioTrack {
    language: string
    label: string
}

export interface Subtitle {
    url: string
    label: string
    format: SubtitleFormat
}

export type SubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml'

export interface Provider {
    id: string
    name: string
}

export interface Diagnostic {
    code: DiagnosticCode
    message: string
    field: string
    severity: 'info' | 'warning' | 'error'
}

export type DiagnosticCode = 'QUALITY_INFERRED' | 'LANGUAGE_INFERRED' | 'TYPE_INFERRED' | 'SUBTITLE_LABEL_INFERRED' | 'PROVIDER_ERROR' | 'PARTIAL_SCRAPE'

// Health Response
export interface HealthResponse {
    name: string
    version: string
    status: 'operational' | 'degraded' | 'maintenance' | 'offline'
    endpoints: {
        movie: string
        tv: string
        proxy: string
        refresh: string
        liveEvents?: string
        liveSources?: string
    }
    spec: 'omss'
    note?: string
}

// Error Response
export interface ErrorResponse {
    error: {
        code: ErrorCode
        message: string
        details?: Record<string, any>
    }
    traceId: string
}

export type ErrorCode =
    | 'INVALID_TMDB_ID'
    | 'INVALID_PARAMETER'
    | 'MISSING_PARAMETER'
    | 'INVALID_SEASON'
    | 'INVALID_EPISODE'
    | 'INVALID_RESPONSE_ID'
    | 'RESPONSE_ID_NOT_FOUND'
    | 'NO_SOURCES_AVAILABLE'
    | 'ENDPOINT_NOT_FOUND'
    | 'METHOD_NOT_ALLOWED'
    | 'INTERNAL_ERROR'
    | 'UNSUPPORTED_MEDIA_TYPE'
    | 'EVENT_NOT_FOUND'
    | 'EVENT_NOT_LIVE'
    | 'AUTH_REQUIRED'
    | 'REGION_BLOCKED'

// Provider Result
export interface ProviderResult {
    sources: Source[]
    subtitles: Subtitle[]
    diagnostics: Diagnostic[]
}

// Proxy Request
export interface ProxyData {
    url: string
    headers?: Record<string, string>
    responseTransform?: 'strip-png-ts-prefix'
}

export interface ContentRequest {
    tmdbId: string
    season?: number
    episode?: number
}

export interface ResponseIdMapping {
    cacheKey: string
    type: 'movie' | 'tv' | 'live'
    tmdbId?: string
    season?: number
    episode?: number
    eventId?: string
    createdAt: number
}

export interface ProviderCapabilities {
    supportedContentTypes: Array<'movies' | 'tv' | 'sub' | 'live'>
}

export interface ProviderMediaObject {
    type: 'movie' | 'tv'
    tmdbId: string
    s?: number
    e?: number
    releaseYear: string
    imdbId: string
    title: string
}

export type LiveEventStatus = 'scheduled' | 'live' | 'ended' | 'postponed'

export interface LiveEventProviderRef {
    providerId: string
    internalEventId?: string
    href?: string
    hrefs?: string[]
    lastChecked: string
    sourceCount: number
}

export interface LiveEventManifest {
    id: string
    title: string
    league: string
    sport: string
    startsAt: string
    endsAt?: string
    status: LiveEventStatus
    teams?: {
        home?: string
        away?: string
    }
    region?: string
    providers: LiveEventProviderRef[]
}

export interface ProviderLiveEventCandidate {
    providerId: string
    internalEventId?: string
    title: string
    league?: string
    sport?: string
    startsAt?: string
    endsAt?: string
    status?: LiveEventStatus
    teams?: {
        home?: string
        away?: string
    }
    region?: string
    href?: string
    hrefs?: string[]
    sourceCount?: number
}

export interface LiveSourceResponse extends SourceResponse {
    event: LiveEventManifest
}

export interface LiveProvider {
    getLiveEvents?(): Promise<ProviderLiveEventCandidate[]>
    matchLiveEvent?(event: LiveEventManifest): Promise<ProviderLiveEventCandidate | undefined>
    getLiveEventSources(event: LiveEventManifest): Promise<ProviderResult>
}
