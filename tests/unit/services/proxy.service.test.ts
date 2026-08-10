import { describe, it, expect, afterEach, vi } from 'vitest'
import { ProxyResult, ProxyService, isStreamingResponse } from '../../../src/services/proxy.service.js'

afterEach(() => vi.unstubAllGlobals())

function enc(url: string, headers?: Record<string, string>, responseTransform?: 'strip-png-ts-prefix') {
    return encodeURIComponent(JSON.stringify({ url, headers, responseTransform }))
}

function makeWebStream() {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(encoder.encode('x'))
            controller.close()
        },
    })
}

function mockFetchStream(body: ReadableStream<Uint8Array>, status = 200, headers: Record<string, string> = {}) {
    return {
        status,
        ok: status < 400,
        body,
        headers: {
            get: (k: string) => headers[k.toLowerCase()] ?? null,
        },
    }
}

function bufResp(body: string, contentType: string, status = 200, extra: Record<string, string> = {}) {
    const bytes = Buffer.from(body)
    const headersMap = new Map<string, string>()
    headersMap.set('content-type', contentType)

    for (const [k, v] of Object.entries(extra)) {
        headersMap.set(k.toLowerCase(), v)
    }

    return {
        status,
        ok: status < 400,
        headers: {
            get: (k: string) => headersMap.get(k.toLowerCase()) ?? null,
        },
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    }
}

function binaryResp(body: Buffer, contentType = 'image/png', status = 200) {
    const bytes = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
    return {
        status,
        ok: status < 400,
        headers: {
            get: (key: string) => (key.toLowerCase() === 'content-type' ? contentType : key.toLowerCase() === 'content-length' ? String(body.length) : null),
        },
        arrayBuffer: async () => bytes,
    }
}

describe('ProxyService - decodeProxyData', () => {
    it('decodes valid encoded proxy data', () => {
        const data = enc('https://example.com/stream.m3u8')
        expect(data).toBeTruthy()
    })
})

describe('ProxyService - constructor patterns', () => {
    it('uses default stream patterns', () => {
        expect(() => new ProxyService()).not.toThrow()
    })

    it('accepts custom stream patterns', () => {
        expect(() => new ProxyService([/\.custom$/i])).not.toThrow()
    })
})

describe('isStreamingResponse', () => {
    it('detects streaming response', () => {
        const fake = {
            stream: {},
            contentType: 'video/mp4',
            statusCode: 200,
            headers: {},
        }
        expect(isStreamingResponse(fake as ProxyResult)).toBe(true)
    })

    it('detects buffered response', () => {
        const fake = {
            data: Buffer.from(''),
            contentType: 'application/json',
            statusCode: 200,
        }
        expect(isStreamingResponse(fake as any)).toBe(false)
    })
})

describe('ProxyService streaming path', () => {
    it.each(['video.mp4', 'video.mkv', 'video.webm', 'video.avi', 'video.mov'])('streams %s', async (file) => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchStream(makeWebStream())))

        const result = await new ProxyService().proxyRequest(enc(`https://cdn.example.com/${file}`))

        expect(isStreamingResponse(result)).toBe(true)
    })

    it('forwards headers', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                mockFetchStream(makeWebStream(), 206, {
                    'content-length': '50000',
                    etag: '"abc"',
                })
            )
        )

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/v.mp4'))) as any

        expect(result.headers['Content-Length']).toBe('50000')
        expect(result.headers['ETag']).toBe('"abc"')
    })

    it('throws on 5xx', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchStream(makeWebStream(), 502)))

        await expect(new ProxyService().proxyRequest(enc('https://cdn.example.com/v.mp4'))).rejects.toThrow()
    })

    it('throws on empty body', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                status: 200,
                ok: true,
                headers: { get: () => null },
                body: null,
            })
        )

        await expect(new ProxyService().proxyRequest(enc('https://cdn.example.com/v.mp4'))).rejects.toThrow()
    })

    it('handles fetch rejection', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network failure')))

        try {
            await new ProxyService().proxyRequest(enc('https://cdn.example.com/x'))
            expect.fail()
        } catch (e: any) {
            expect(e.code).toBe('INTERNAL_ERROR')
        }
    })

    it('streams custom patterns', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockFetchStream(makeWebStream())))

        const result = await new ProxyService([/\.custom$/i]).proxyRequest(enc('https://cdn.example.com/file.custom'))

        expect(isStreamingResponse(result)).toBe(true)
    })
})

describe('buffered m3u8 rewriting', () => {
    it('rewrites absolute URLs', async () => {
        const manifest = ['#EXTM3U', 'https://cdn.example.com/seg0.ts', 'https://cdn.example.com/seg1.ts'].join('\n')

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp(manifest, 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/playlist.m3u8'))) as any

        expect(isStreamingResponse(result)).toBe(false)
        expect(result.data.toString()).toContain('seg0.ts')
    })

    it('rewrites relative URLs', async () => {
        const manifest = '#EXTM3U\nseg0.ts\nseg1.ts\n'

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp(manifest, 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/index.m3u8'))) as any

        expect(result.data.toString()).toContain('seg0.ts')
    })

    it('rewrites EXT-X-KEY URI', async () => {
        const manifest = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin"\nseg0.ts\n'

        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp(manifest, 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/index.m3u8'))) as any

        expect(result.data.toString()).toContain('URI="/v1/proxy?data=')
    })

    it('propagates a response transform through child playlists and segments', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp('#EXTM3U\nchild/playlist.m3u8\n', 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/master.m3u8', { Referer: 'https://player.example/' }, 'strip-png-ts-prefix'))) as any
        const proxyLine = result.data
            .toString()
            .split('\n')
            .find((line: string) => line.startsWith('/v1/proxy'))
        const payload = ProxyService.decodeProxyData(new URL(proxyLine, 'http://localhost').searchParams.get('data')!)

        expect(payload.url).toBe('https://cdn.example.com/child/playlist.m3u8')
        expect(payload.headers?.Referer).toBe('https://player.example/')
        expect(payload.responseTransform).toBe('strip-png-ts-prefix')
    })
})

describe('PNG-wrapped MPEG-TS normalization', () => {
    function wrappedSegment(): Buffer {
        const body = Buffer.alloc(70 + 188 * 2, 0)
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(body)
        body[70] = 0x47
        body[70 + 188] = 0x47
        return body
    }

    it('strips the verified wrapper and corrects response metadata', async () => {
        const body = wrappedSegment()
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResp(body)))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/segment.bin', { Range: 'bytes=0-99' }, 'strip-png-ts-prefix'))) as any

        expect(result.statusCode).toBe(200)
        expect(result.contentType).toBe('video/mp2t')
        expect(result.data).toHaveLength(body.length - 70)
        expect(result.data[0]).toBe(0x47)
        expect(result.data[188]).toBe(0x47)
        expect(result.headers['Content-Length']).toBe(String(body.length - 70))
        expect((fetch as any).mock.calls[0][1].headers.Range).toBeUndefined()
    })

    it('rejects payloads that do not match both wrapper signatures', async () => {
        const body = wrappedSegment()
        body[70 + 188] = 0
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(binaryResp(body)))

        await expect(new ProxyService().proxyRequest(enc('https://cdn.example.com/segment.bin', undefined, 'strip-png-ts-prefix'))).rejects.toMatchObject({ statusCode: 502 })
    })
})

describe('resolveUrl branches', () => {
    it('handles protocol-relative URL', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp('#EXTM3U\n//cdn.example.com/seg.ts', 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/index.m3u8'))) as any

        expect(result.data.toString()).toContain('seg.ts')
    })

    it('handles absolute-path URL', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(bufResp('#EXTM3U\n/hls/seg.ts', 'application/x-mpegURL')))

        const result = (await new ProxyService().proxyRequest(enc('https://cdn.example.com/index.m3u8'))) as any

        expect(result.data.toString()).toContain('seg.ts')
    })
})

describe('decodeProxyData errors', () => {
    it('invalid json', () => {
        expect(() => ProxyService.decodeProxyData('not%20json')).toThrow()
    })

    it('missing url', () => {
        expect(() => ProxyService.decodeProxyData(encodeURIComponent(JSON.stringify({ foo: 'bar' })))).toThrow()
    })

    it('malformed input', () => {
        expect(() => ProxyService.decodeProxyData('{')).toThrow()
    })

    it('rejects unknown response transforms', () => {
        expect(() =>
            ProxyService.decodeProxyData(
                encodeURIComponent(
                    JSON.stringify({
                        url: 'https://cdn.example.com/segment.bin',
                        responseTransform: 'unknown',
                    })
                )
            )
        ).toThrow()
    })
})
