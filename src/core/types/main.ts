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
    type: 'movie' | 'tv'
    tmdbId: string
    season?: number
    episode?: number
    createdAt: number
}

export interface ProviderCapabilities {
    supportedContentTypes: Array<'movies' | 'tv' | 'sub'>
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
