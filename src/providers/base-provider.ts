import { ProviderCapabilities, ProviderMediaObject, ProviderResult, OMSSConfig, ProxyData } from '../core/types/index.js'

/**
 * Console wrapper for provider logging
 */
class ProviderLogger {
    constructor(
        private providerId: string,
        private providerName: string,
        private isProduction: boolean = process.env.NODE_ENV === 'production'
    ) {}

    /**
     * Format log prefix with context
     */
    private formatPrefix(media?: ProviderMediaObject): string {
        if (this.isProduction) {
            return `[${this.providerName}]`
        }

        const parts = [`[${this.providerName}]`, `[${this.providerId}]`]

        if (media) {
            if (media.type === 'movie') {
                parts.push(`[Movie: ${media.tmdbId}]`)
                if (media.title) parts.push(`[${media.title}]`)
            } else {
                parts.push(`[TV: ${media.tmdbId}]`, `[S${media.s}E${media.e}]`)
                if (media.title) parts.push(`[${media.title}]`)
            }
        }

        return parts.join(' ')
    }

    log(message: string, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.log(`${this.formatPrefix(media)} ${message}`)
    }

    info(message: string, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.info(`${this.formatPrefix(media)} ${message}`)
    }

    warn(message: string, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.warn(`${this.formatPrefix(media)} ⚠️  ${message}`)
    }

    error(message: string, error?: any, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.error(`${this.formatPrefix(media)} ❌ ${message}`, error || '')
    }

    debug(message: string, data?: any, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.debug(`${this.formatPrefix(media)} 🔍 ${message}`, data || '')
    }

    success(message: string, media?: ProviderMediaObject): void {
        if (this.isProduction) return
        console.log(`${this.formatPrefix(media)} ✅ ${message}`)
    }
}

/**
 * Proxy URL configuration
 */
interface ProxyConfig {
    baseUrl?: string
    host?: string
    port?: number
    protocol?: 'http' | 'https'
    proxyConfig?: OMSSConfig['proxyConfig']
}

export abstract class BaseProvider {
    abstract readonly id: string
    abstract readonly name: string
    abstract readonly enabled: boolean
    abstract readonly BASE_URL: string
    abstract readonly HEADERS: Record<string, string>
    abstract readonly capabilities: ProviderCapabilities
    private static globalProxyConfig: {
        knownThirdPartyProxies: Record<string, RegExp[]>
        streamPatterns: RegExp[]
    } | null = null

    /**
     * Protected console logger instance (lazy initialized)
     */
    private _console?: ProviderLogger

    /**
     * Proxy configuration (set by ProviderRegistry)
     */
    private static proxyConfig: ProxyConfig = {}

    /**
     * Get console logger (lazy initialization)
     */
    protected get console(): ProviderLogger {
        if (!this._console) {
            this._console = new ProviderLogger(this.id, this.name)
        }
        return this._console
    }

    /**
     * Set global proxy configuration
     */
    static setProxyConfig(config: ProxyConfig): void {
        BaseProvider.proxyConfig = config
    }

    static setGlobalProxyConfig(config: NonNullable<OMSSConfig['proxyConfig']>): void {
        BaseProvider.globalProxyConfig = config
    }

    private cleanThirdPartyProxy(proxyUrl: string): string {
        const config = BaseProvider.globalProxyConfig
        if (!config) return proxyUrl

        try {
            const urlObj = new URL(proxyUrl)
            const origin = urlObj.origin.toLowerCase()

            // Extract from patterns
            return this.extractFromPatterns(proxyUrl, origin, config)
        } catch {
            return proxyUrl
        }
    }

    private extractFromPatterns(proxyUrl: string, origin: string, config: NonNullable<OMSSConfig['proxyConfig']>): string {
        const patterns = [...(config.knownThirdPartyProxies[origin] || []), ...(config.knownThirdPartyProxies['*'] || [])]

        for (const pattern of patterns) {
            const match = proxyUrl.match(pattern)
            if (match) {
                let extracted = match[1]
                // Multi-level decode
                for (let i = 0; i < 5 && extracted.includes('%'); i++) {
                    try {
                        extracted = decodeURIComponent(extracted)
                    } catch {
                        break
                    }
                }
                // add protocol if missing
                if (!/^https?:\/\//i.test(extracted)) {
                    extracted = 'https://' + extracted
                }
                return extracted
            }
        }

        // Query param fallback
        const urlParams = new URLSearchParams(new URL(proxyUrl).search)
        const urlParam = urlParams.get('url')
        if (urlParam) {
            return decodeURIComponent(urlParam)
        }

        return proxyUrl
    }

    /**
     * Get proxy base URL
     */
    public static getProxyBaseUrl(): string {
        const config = BaseProvider.proxyConfig

        // If baseUrl is explicitly set, use it
        if (config.baseUrl) {
            return config.baseUrl
        }

        // Build from host, port, protocol
        const protocol = config.protocol || 'http'
        const host = config.host || 'localhost'
        const port = config.port

        // Only add port if it's not default for the protocol
        const needsPort = (protocol === 'http' && port && port !== 80) || (protocol === 'https' && port && port !== 443)

        if (needsPort) {
            return `${protocol}://${host}:${port}`
        }

        return `${protocol}://${host}`
    }

    /**
     * Fetch sources for a movie
     */
    abstract getMovieSources(media: ProviderMediaObject): Promise<ProviderResult>

    /**
     * Fetch sources for a TV episode
     */
    abstract getTVSources(media: ProviderMediaObject): Promise<ProviderResult>

    /**
     * Health check for provider availability
     */
    async healthCheck(): Promise<boolean> {
        return this.enabled
    }

    /**
     * Helper: Create proxy URL with full server address
     */
    public createProxyUrl(url: string, headers?: Record<string, string>, options?: Pick<ProxyData, 'responseTransform'>): string {
        const cleanUrl = this.cleanThirdPartyProxy(url)
        const data = JSON.stringify({ url: cleanUrl, headers, ...options })
        const encodedData = encodeURIComponent(data)
        const baseUrl = BaseProvider.getProxyBaseUrl()

        return `${baseUrl}/v1/proxy?data=${encodedData}`
    }

    /**
     * Helper: Create relative proxy URL (for same-origin requests)
     */
    protected createRelativeProxyUrl(url: string, headers?: Record<string, string>, options?: Pick<ProxyData, 'responseTransform'>): string {
        const data = JSON.stringify({ url, headers, ...options })
        return `/v1/proxy?data=${encodeURIComponent(data)}`
    }

    /**
     * Helper: Infer quality from URL or filename
     */
    protected inferQuality(filename: string): string {
        const patterns = [
            { regex: /2160p|4k/i, quality: '2160p' },
            { regex: /1080p/i, quality: '1080p' },
            { regex: /720p/i, quality: '720p' },
            { regex: /480p/i, quality: '480p' },
            { regex: /360p/i, quality: '360p' },
        ]

        for (const { regex, quality } of patterns) {
            if (regex.test(filename)) return quality
        }

        return 'unknown'
    }

    /**
     * Helper: Infer type from URL extension
     */
    protected inferType(url: string): string {
        if (url.includes('.m3u8')) return 'hls'
        if (url.includes('.mpd')) return 'dash'
        if (url.includes('.mp4')) return 'mp4'
        if (url.includes('.mkv')) return 'mkv'
        if (url.includes('.webm')) return 'webm'
        return 'embed'
    }

    /**
     * Check if provider supports given content type
     */
    protected supportsContentType(type: 'movies' | 'tv' | 'sub'): boolean {
        return this.capabilities.supportedContentTypes.includes(type)
    }
}
