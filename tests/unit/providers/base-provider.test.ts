import { describe, it, expect, beforeAll } from 'vitest'
import { BaseProvider } from '../../../src/providers/base-provider.js'
import type { ProviderCapabilities, ProviderMediaObject, ProviderResult } from '../../../src/core/types/index.js'

class TestProvider extends BaseProvider {
    readonly id = 'test'
    readonly name = 'Test Provider'
    readonly enabled = true
    readonly BASE_URL = 'https://test.example'
    readonly HEADERS = {}
    readonly capabilities: ProviderCapabilities = { supportedContentTypes: ['movies', 'tv'] }

    async getMovieSources(_: ProviderMediaObject): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] }
    }
    async getTVSources(_: ProviderMediaObject): Promise<ProviderResult> {
        return { sources: [], subtitles: [], diagnostics: [] }
    }

    // Expose protected helpers for testing
    public testInferQuality(filename: string) {
        return this.inferQuality(filename)
    }
    public testInferType(url: string) {
        return this.inferType(url)
    }
    public testSupportsContentType(type: 'movies' | 'tv' | 'sub') {
        return this.supportsContentType(type)
    }
}

describe('BaseProvider - inferQuality', () => {
    const p = new TestProvider()

    it.each([
        ['video.2160p.mp4', '2160p'],
        ['video.4K.mkv', '2160p'],
        ['video.1080p.mp4', '1080p'],
        ['video.720p.mp4', '720p'],
        ['video.480p.mp4', '480p'],
        ['video.360p.mp4', '360p'],
        ['video.unknown.mp4', 'unknown'],
    ])('infers quality from "%s" → "%s"', (input, expected) => {
        expect(p.testInferQuality(input)).toBe(expected)
    })
})

describe('BaseProvider - inferType', () => {
    const p = new TestProvider()

    it.each([
        ['https://cdn.example.com/video.m3u8', 'hls'],
        ['https://cdn.example.com/video.mpd', 'dash'],
        ['https://cdn.example.com/video.mp4', 'mp4'],
        ['https://cdn.example.com/video.mkv', 'mkv'],
        ['https://cdn.example.com/video.webm', 'webm'],
        ['https://embed.example.com/player', 'embed'],
    ])('infers type from "%s" → "%s"', (url, expected) => {
        expect(p.testInferType(url)).toBe(expected)
    })
})

describe('BaseProvider - supportsContentType', () => {
    const p = new TestProvider()

    it('returns true for supported types', () => {
        expect(p.testSupportsContentType('movies')).toBe(true)
        expect(p.testSupportsContentType('tv')).toBe(true)
    })

    it('returns false for unsupported types', () => {
        expect(p.testSupportsContentType('sub')).toBe(false)
    })
})

describe('BaseProvider - createProxyUrl', () => {
    beforeAll(() => {
        BaseProvider.setProxyConfig({ host: 'localhost', port: 3000, protocol: 'http' })
    })

    it('returns a /v1/proxy URL with encoded data', () => {
        const p = new TestProvider()
        const url = p.createProxyUrl('https://upstream.example/stream.m3u8')
        expect(url).toMatch(/^http:\/\/localhost:3000\/v1\/proxy\?data=/)
    })

    it('encodes the upstream url inside the data param', () => {
        const p = new TestProvider()
        const proxyUrl = p.createProxyUrl('https://upstream.example/stream.m3u8')
        const encoded = proxyUrl.split('data=')[1]
        const decoded = JSON.parse(decodeURIComponent(encoded))
        expect(decoded.url).toBe('https://upstream.example/stream.m3u8')
    })

    it('encodes an explicitly requested response transform', () => {
        const p = new TestProvider()
        const proxyUrl = p.createProxyUrl('https://upstream.example/stream.m3u8', {}, { responseTransform: 'strip-png-ts-prefix' })
        const encoded = proxyUrl.split('data=')[1]
        const decoded = JSON.parse(decodeURIComponent(encoded))
        expect(decoded.responseTransform).toBe('strip-png-ts-prefix')
    })
})

describe('BaseProvider - getProxyBaseUrl', () => {
    it('builds from host + port + protocol', () => {
        BaseProvider.setProxyConfig({ host: 'myserver.com', port: 8080, protocol: 'https' })
        expect(BaseProvider.getProxyBaseUrl()).toBe('https://myserver.com:8080')
    })

    it('uses baseUrl directly when provided', () => {
        BaseProvider.setProxyConfig({ baseUrl: 'https://proxy.example.com' })
        expect(BaseProvider.getProxyBaseUrl()).toBe('https://proxy.example.com')
    })

    it('omits port 80 for http', () => {
        BaseProvider.setProxyConfig({ host: 'localhost', port: 80, protocol: 'http' })
        expect(BaseProvider.getProxyBaseUrl()).toBe('http://localhost')
    })

    it('omits port 443 for https', () => {
        BaseProvider.setProxyConfig({ host: 'secure.example.com', port: 443, protocol: 'https' })
        expect(BaseProvider.getProxyBaseUrl()).toBe('https://secure.example.com')
    })
})
