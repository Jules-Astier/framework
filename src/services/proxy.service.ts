import { Readable } from 'stream'
import { ProxyData } from '../core/types/index.js'
import { OMSSError } from '../core/errors.js'

export interface ProxyResponse {
    data: Buffer | string
    contentType: string
    statusCode: number
    headers?: Record<string, string>
}

export interface StreamingProxyResponse {
    stream: Readable
    contentType: string
    statusCode: number
    headers: Record<string, string>
}

export type ProxyResult = ProxyResponse | StreamingProxyResponse

export function isStreamingResponse(response: ProxyResult): response is StreamingProxyResponse {
    return 'stream' in response && true
}

export class ProxyService {
    private isProd: boolean = process.env.NODE_ENV === 'production'
    private streamPatterns: RegExp[]

    constructor(streamPatterns?: RegExp[]) {
        const defaultPatterns: RegExp[] = [/\.mp4($|\?)/, /\.mkv($|\?)/, /\.webm($|\?)/, /\.avi($|\?)/, /\.mov($|\?)/]

        const patterns = streamPatterns ? [...streamPatterns, ...defaultPatterns] : [...defaultPatterns]

        this.streamPatterns = patterns
            .map((pattern) => {
                try {
                    return new RegExp(pattern, 'i')
                } catch (error) {
                    console.warn(`[ProxyService] Invalid regex pattern: ${pattern}`, error)
                    return null
                }
            })
            .filter((pattern): pattern is RegExp => pattern !== null)
    }

    /**
     * Proxy a request to an upstream provider
     * Returns either buffered response or streaming response based on file type
     */
    async proxyRequest(encodedData: string): Promise<ProxyResult> {
        const proxyData = ProxyService.decodeProxyData(encodedData)

        this.isProd ?? console.log(`[ProxyService] Proxying request to: ${proxyData.url}`)

        try {
            if (this.shouldStream(proxyData.url)) {
                return await this.handleStreamingRequest(proxyData)
            }

            return await this.handleBufferedRequest(proxyData)
        } catch (error) {
            // Preserve external OMSSError behavior that callers see
            if (error instanceof OMSSError) {
                throw error
            }

            const message = error instanceof Error ? error.message : 'Unknown error'

            throw new OMSSError('INTERNAL_ERROR', `Failed to proxy request: ${message}`, 500, { url: proxyData.url })
        }
    }

    /**
     * Determine if a URL should be streamed based on file type
     */
    private shouldStream(url: string): boolean {
        return this.streamPatterns.some((pattern) => pattern.test(url))
    }

    /**
     * Fetch helper with timeout
     */
    private async fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 30000): Promise<Response> {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

        try {
            const response = await fetch(url, {
                ...init,
                signal: controller.signal,
                redirect: 'follow', // native redirect handling
            })
            return response
        } finally {
            clearTimeout(timeoutId)
        }
    }

    /**
     * Handle streaming request for large files
     */
    private async handleStreamingRequest(proxyData: ProxyData): Promise<StreamingProxyResponse> {
        const rangeHeader = proxyData.headers?.['range'] ?? proxyData.headers?.['Range']

        const headers: Record<string, string> = {
            ...(proxyData.headers ?? {}),
            ...(rangeHeader ? { Range: rangeHeader } : {}),
        }

        const response = await this.fetchWithTimeout(proxyData.url, {
            method: 'GET',
            headers,
        })

        if (response.status >= 500) {
            throw new OMSSError('INTERNAL_ERROR', `Upstream returned ${response.status}`, response.status, { url: proxyData.url })
        }

        if (!response.body) {
            throw new OMSSError('INTERNAL_ERROR', 'Upstream returned empty body for streaming request', 502, { url: proxyData.url })
        }

        const nodeStream = Readable.fromWeb(response.body as unknown as ReadableStream<Uint8Array>)

        const contentType = response.headers.get('content-type') ?? this.getMimeType(proxyData.url)

        const headersOut: Record<string, string> = {
            'Content-Disposition': 'inline; filename="stream"',
            'Cache-Control': response.headers.get('cache-control') ?? 'public, max-age=7200',
            'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length, Content-Range, Last-Modified, ETag',
        }

        const acceptRanges = response.headers.get('accept-ranges') ?? response.headers.get('accept-range')
        if (acceptRanges) {
            headersOut['Accept-Ranges'] = acceptRanges || 'bytes'
        }

        const contentLength = response.headers.get('content-length')
        if (contentLength) {
            headersOut['Content-Length'] = contentLength
        }
        const contentRange = response.headers.get('content-range')
        if (contentRange) {
            headersOut['Content-Range'] = contentRange
        }
        const lastModified = response.headers.get('last-modified')
        if (lastModified) {
            headersOut['Last-Modified'] = lastModified
        }
        const etag = response.headers.get('etag')
        if (etag) {
            headersOut['ETag'] = etag
        }

        return {
            stream: nodeStream,
            contentType,
            statusCode: response.status,
            headers: headersOut,
        }
    }

    /**
     * Handle buffered request for small files
     */
    private async handleBufferedRequest(proxyData: ProxyData): Promise<ProxyResponse> {
        const requestHeaders = { ...(proxyData.headers ?? {}) }
        if (proxyData.responseTransform === 'strip-png-ts-prefix') {
            delete requestHeaders.range
            delete requestHeaders.Range
        }
        const response = await this.fetchWithTimeout(proxyData.url, {
            method: 'GET',
            headers: {
                ...requestHeaders,
                'User-Agent': proxyData.headers?.['User-Agent'] ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.6912.95 Safari/537.36',
            },
        })

        if (response.status >= 500) {
            throw new OMSSError('INTERNAL_ERROR', `Upstream returned ${response.status}`, response.status, { url: proxyData.url })
        }

        const contentType = response.headers.get('content-type') ?? ''

        let responseData: Buffer = Buffer.from(await response.arrayBuffer())
        let responseContentType = contentType || this.getMimeType(proxyData.url)

        if (this.isManifestFile(contentType, proxyData.url)) {
            const manifestContent = responseData.toString('utf-8')
            const rewrittenContent = this.rewriteManifest(manifestContent, proxyData.url, proxyData.headers, proxyData.responseTransform)
            responseData = Buffer.from(rewrittenContent, 'utf-8')
        } else if (proxyData.responseTransform === 'strip-png-ts-prefix') {
            responseData = this.stripPngTsPrefix(responseData)
            responseContentType = 'video/mp2t'
        }

        const headersOut: Record<string, string> = {
            'Content-Disposition': 'inline',
            'Accept-Ranges': 'bytes',
            'Cache-Control': response.headers.get('cache-control') ?? 'public, max-age=7200',
        }

        headersOut['Content-Length'] = String(responseData.length)
        const contentRange = response.headers.get('content-range')
        if (contentRange && proxyData.responseTransform === undefined) {
            headersOut['Content-Range'] = contentRange
        }

        return {
            data: responseData,
            contentType: responseContentType,
            statusCode: proxyData.responseTransform === 'strip-png-ts-prefix' ? 200 : response.status,
            headers: headersOut,
        }
    }

    /**
     * Determine MIME type from URL or content
     */
    private getMimeType(url: string): string {
        if (url.match(/\.vtt$/i)) return 'text/vtt'
        if (url.match(/\.srt$/i)) return 'text/plain'
        if (url.match(/\.ass|\.ssa$/i)) return 'text/plain'
        if (url.match(/\.m3u8$/i)) return 'application/x-mpegURL'
        if (url.match(/\.mpd$/i)) return 'application/dash+xml'
        if (url.match(/\.mp4$/i)) return 'video/mp4'
        if (url.match(/\.mkv$/i)) return 'video/x-matroska'
        if (url.match(/\.webm$/i)) return 'video/webm'
        if (url.match(/\.avi$/i)) return 'video/x-msvideo'
        if (url.match(/\.mov$/i)) return 'video/quicktime'
        if (url.match(/\.ts$/i)) return 'video/mp2t'
        return 'application/octet-stream'
    }

    /**
     * Decode proxy data parameter
     */
    public static decodeProxyData(encodedData: string): ProxyData {
        try {
            const decoded = decodeURIComponent(encodedData)
            const data = JSON.parse(decoded) as ProxyData

            if (!data.url) {
                throw new Error('Missing url field in proxy data')
            }
            if (data.responseTransform !== undefined && data.responseTransform !== 'strip-png-ts-prefix') {
                throw new Error('Unsupported response transform')
            }

            return data
        } catch (error) {
            throw new OMSSError('INVALID_PARAMETER', 'Invalid data parameter format', 400, {
                parameter: 'data',
                error: error instanceof Error ? error.message : 'Unknown',
            })
        }
    }

    /**
     * Check if the response is a manifest file that needs rewriting.
     * Makes sure that it is text based, but NOT a subtitle file.
     */
    private isManifestFile(contentType: string, url: string): boolean {
        const TEXT_BASED_MIME_REGEX = /^(text\/.*|application\/(.*\+xml|.*\+json|json|xml|javascript|yaml|x-yaml|x-www-form-urlencoded))(;.*)?$/i
        const isTextLike = TEXT_BASED_MIME_REGEX.test(contentType)

        return (
            (isTextLike || /application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml)/i.test(contentType) || /\.m3u8(\?.*)?$/.test(url) || /\.mpd(\?.*)?$/.test(url)) &&
            !/\.(vtt|srt|ass|ssa|ttml)(\?.*)?$/i.test(url)
        )
    }

    /**
     * Rewrite manifest file URLs to go through proxy
     */
    private rewriteManifest(content: string, baseUrl: string, headers?: Record<string, string>, responseTransform?: ProxyData['responseTransform']): string {
        const lines = content.split('\n')
        const rewrittenLines: string[] = []

        for (const line of lines) {
            const trimmedLine = line.trim()

            if (line.startsWith('#') && this.hasUriAttribute(line)) {
                rewrittenLines.push(this.rewriteTagAttributes(line, baseUrl, headers))
                continue
            }

            if (line.startsWith('#') || trimmedLine === '') {
                rewrittenLines.push(line)
                continue
            }

            if (this.isUrlLine(trimmedLine)) {
                const resolvedUrl = this.resolveUrl(baseUrl, trimmedLine)
                const proxiedUrl = this.createProxyUrl(resolvedUrl, headers, {
                    responseTransform,
                })

                const indent = line.match(/^\s*/)?.[0] ?? ''
                rewrittenLines.push(indent + proxiedUrl)
            } else {
                rewrittenLines.push(line)
            }
        }

        return rewrittenLines.join('\n')
    }

    private hasUriAttribute(line: string): boolean {
        return /URI\s*=\s*["']([^"']+)["']/i.test(line)
    }

    private rewriteTagAttributes(line: string, baseUrl: string, headers?: Record<string, string>): string {
        return line.replace(/URI\s*=\s*["']([^"']+)["']/gi, (match, capturedUrl) => {
            const resolvedUrl = this.resolveUrl(baseUrl, capturedUrl)
            const proxiedUrl = this.createProxyUrl(resolvedUrl, headers)

            const quote = match.includes('"') ? '"' : "'"
            return `URI=${quote}${proxiedUrl}${quote}`
        })
    }

    private isUrlLine(line: string): boolean {
        if (line.startsWith('http://') || line.startsWith('https://')) {
            return true
        }

        if (line.startsWith('//')) {
            return true
        }

        if (line.startsWith('/')) {
            return true
        }

        return (
            line.includes('.ts') ||
            line.includes('.m3u8') ||
            line.includes('.mp4') ||
            line.includes('.m4s') ||
            line.includes('.webm') ||
            line.includes('.vtt') ||
            line.includes('.key') ||
            line.includes('/') ||
            /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+/.test(line)
        )
    }

    private resolveUrl(baseUrl: string, targetUrl: string): string {
        try {
            if (targetUrl.startsWith('http://') || targetUrl.startsWith('https://')) {
                return targetUrl
            }

            const baseUrlObj = new URL(baseUrl)

            if (targetUrl.startsWith('//')) {
                return `${baseUrlObj.protocol}${targetUrl}`
            }

            if (targetUrl.startsWith('/')) {
                return `${baseUrlObj.protocol}//${baseUrlObj.host}${targetUrl}`
            }

            const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)
            return new URL(targetUrl, baseDir).toString()
        } catch (error) {
            this.isProd ?? console.warn(`[ProxyService] Failed to resolve URL: ${targetUrl} against ${baseUrl}`)

            try {
                const baseDir = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1)
                return baseDir + targetUrl
            } catch {
                return targetUrl
            }
        }
    }

    /**
     * Create a proxy URL for a given upstream URL
     * ALWAYS includes headers from the original request
     */
    public createProxyUrl(url: string, headers?: Record<string, string>, options?: Pick<ProxyData, 'responseTransform'>): string {
        const data = JSON.stringify({ url, headers, ...options })
        return `/v1/proxy?data=${encodeURIComponent(data)}`
    }

    private stripPngTsPrefix(data: Buffer): Buffer {
        const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        const prefixLength = 70
        const secondPacketOffset = prefixLength + 188

        if (data.length <= secondPacketOffset || !data.subarray(0, pngSignature.length).equals(pngSignature) || data[prefixLength] !== 0x47 || data[secondPacketOffset] !== 0x47) {
            throw new OMSSError('INTERNAL_ERROR', 'Upstream segment normalization failed', 502, {
                reason: 'invalid_png_ts_wrapper',
            })
        }

        return data.subarray(prefixLength)
    }
}
