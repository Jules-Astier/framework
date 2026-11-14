import { afterEach, describe, expect, it, vi } from 'vitest'
import { SourceService } from '../../../src/services/source.service.js'
import { ProviderRegistry } from '../../../src/providers/provider-registry.js'
import { BaseProvider } from '../../../src/providers/base-provider.js'
import { MemoryCacheService } from '../../../src/core/cache.js'
import type { ProviderCapabilities, ProviderResult, Source, SourceDiscoveryEvent } from '../../../src/core/types/index.js'

const mediaBytes = () => new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0, 105, 115, 111, 109, 109, 112, 52, 50])
const deferred = <T>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((r) => {
        resolve = r
    })
    return { promise, resolve }
}
const empty = (): ProviderResult => ({ sources: [], subtitles: [], diagnostics: [] })
const source = (name: string, type: Source['type'] = 'mp4'): Source => ({
    url: '/v1/proxy?data=' + encodeURIComponent(JSON.stringify({ url: `https://cdn.example/${name}` })),
    type,
    quality: '1080p',
    audioTracks: [],
    provider: { id: 'fake', name: 'Fake' },
})
const result = (...sources: Source[]): ProviderResult => ({ ...empty(), sources })
class Provider extends BaseProvider {
    readonly enabled = true
    readonly name = 'Fake'
    readonly BASE_URL = ''
    readonly HEADERS = {}
    readonly capabilities: ProviderCapabilities = { supportedContentTypes: ['movies', 'tv'] }
    constructor(
        readonly id: string,
        private run: () => Promise<ProviderResult>
    ) {
        super()
    }
    getMovieSources() {
        return this.run()
    }
    getTVSources() {
        return this.run()
    }
}
const cleanups: (() => void)[] = []
function fixture(providers: Provider[], tmdbOverride = {}) {
    const registry = new ProviderRegistry()
    providers.forEach((p) => registry.register(p))
    const cache = new MemoryCacheService()
    const set = vi.spyOn(cache, 'set')
    const remove = vi.spyOn(cache, 'delete')
    const tmdb = {
        validateMovie: vi.fn().mockResolvedValue({ exists: true, released: true }),
        validateTVEpisode: vi.fn().mockResolvedValue({ exists: true, released: true }),
        getMediaObject: vi.fn().mockResolvedValue({ type: 'movie', title: 'Title', tmdbId: '123', imdbId: 'tt123', releaseYear: '2024' }),
        getImdbId: vi.fn().mockResolvedValue('tt123'),
        ...tmdbOverride,
    }
    const stremio = { hasEnabledAddons: () => false } as any
    const service = new SourceService(registry, cache, tmdb as any, stremio)
    cleanups.push(() => {
        service.destroy()
        cache.destroy()
    })
    const events: SourceDiscoveryEvent[] = []
    const emit = async (event: SourceDiscoveryEvent) => {
        events.push(event)
    }
    return { service, cache, set, remove, events, emit, tmdb }
}
afterEach(() => {
    cleanups.splice(0).forEach((fn) => fn())
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
})

describe('progressive verified source discovery', () => {
    it('emits a verified fast source before a slow provider finishes and keeps the response ID stable', async () => {
        const slow = deferred<ProviderResult>()
        const f = fixture([new Provider('fast', async () => result(source('fast.mp4'))), new Provider('slow', () => slow.promise)])
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(mediaBytes(), { headers: { 'content-type': 'video/mp4' } }))
        )
        const pending = f.service.streamMovieSources('123', f.emit)
        await vi.waitFor(() => expect(f.events.some((e) => e.type === 'update' && e.response?.sources.length === 1)).toBe(true))
        expect(f.events.some((e) => e.type === 'complete')).toBe(false)
        slow.resolve(empty())
        await pending
        expect(new Set(f.events.map((e) => e.response?.responseId)).size).toBe(1)
        expect(f.events.at(-1)?.type).toBe('complete')
        expect(f.set).toHaveBeenCalledTimes(1)
    })
    it('never advertises failed or transient validation, including when INTERNAL_DEBUG is enabled', async () => {
        const f = fixture([new Provider('mixed', async () => result(source('good.mp4'), source('html.m3u8', 'hls'), source('busy.mp4'), source('embed', 'embed')))])
        vi.stubEnv('INTERNAL_DEBUG', 'true')
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => (url.includes('busy') ? new Response('', { status: 503 }) : new Response(url.includes('html') ? '<html>blocked</html>' : mediaBytes())))
        )
        await f.service.streamMovieSources('123', f.emit)
        expect(f.events.at(-1)?.response?.sources).toEqual([source('good.mp4')])
    })
    it('rejects HTML and JSON disguised as MP4 while accepting recognizable media with a bad MIME header', async () => {
        const f = fixture([new Provider('mixed', async () => result(source('error.mp4'), source('json.mp4'), source('binary.mp4')))])
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async (url: string) =>
                    new Response(url.includes('error') ? '<html>Access denied</html>' : url.includes('json') ? '{"error":"not found"}' : mediaBytes(), {
                        headers: { 'content-type': url.includes('binary') ? 'text/html' : 'video/mp4' },
                    })
            )
        )
        await f.service.streamMovieSources('123', f.emit)
        expect(f.events.at(-1)?.response?.sources).toEqual([source('binary.mp4')])
    })
    it('does not advertise an expired cache envelope even if its old URL still responds', async () => {
        const fresh = vi.fn(async () => result(source('fresh.mp4')))
        const f = fixture([new Provider('fresh', fresh)])
        await f.cache.set('movie:123', { ...result(source('old.mp4')), responseId: 'old', expiresAt: new Date(Date.now() - 1000).toISOString() })
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(mediaBytes()))
        )
        await f.service.streamMovieSources('123', f.emit)
        expect(fresh).toHaveBeenCalledOnce()
        expect(f.events.at(-1)?.response?.sources).toEqual([source('fresh.mp4')])
        expect(Date.parse(f.events.at(-1)!.response!.expiresAt)).toBeGreaterThan(Date.now())
    })
    it('revalidates cache hits and falls back to providers when cached signed links have expired', async () => {
        const fresh = vi.fn(async () => result(source('fresh.mp4')))
        const f = fixture([new Provider('fresh', fresh)])
        await f.cache.set('movie:123', { ...result(source('expired.mp4')), responseId: 'old', expiresAt: new Date(Date.now() + 60000).toISOString() })
        f.set.mockClear()
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => new Response(mediaBytes(), { status: url.includes('expired') ? 403 : 200 }))
        )
        await f.service.streamMovieSources('123', f.emit)
        expect(fresh).toHaveBeenCalledOnce()
        expect(f.remove).toHaveBeenCalledWith('movie:123')
        expect(f.events.at(-1)?.response?.sources).toEqual([source('fresh.mp4')])
    })
    it('bounds metadata lookup time and starts the stream before metadata is ready', async () => {
        const metadata = deferred<{ exists: boolean; released: boolean }>()
        const provider = vi.fn(async () => empty())
        const f = fixture([new Provider('never-started', provider)], { validateMovie: () => metadata.promise })
        await f.service.streamMovieSources('123', f.emit, { timeoutMs: 25 })
        expect(f.events[0].type).toBe('start')
        expect(f.events.at(-1)).toMatchObject({ type: 'complete', timedOut: true })
        expect(provider).not.toHaveBeenCalled()
        expect(f.set).not.toHaveBeenCalled()
        metadata.resolve({ exists: true, released: true })
    })
    it('keeps partial sources at the deadline without caching or accepting late provider output', async () => {
        const slow = deferred<ProviderResult>()
        const f = fixture([new Provider('fast', async () => result(source('fast.mp4'))), new Provider('late', () => slow.promise)])
        const fetch = vi.fn(async () => new Response(mediaBytes()))
        vi.stubGlobal('fetch', fetch)
        await f.service.streamMovieSources('123', f.emit, { timeoutMs: 35 })
        expect(f.events.at(-1)).toMatchObject({ type: 'complete', timedOut: true })
        expect(f.events.at(-1)?.response?.sources).toHaveLength(1)
        expect(f.set).not.toHaveBeenCalled()
        const eventCount = f.events.length
        slow.resolve(result(source('late.mp4')))
        await new Promise((r) => setImmediate(r))
        expect(f.events).toHaveLength(eventCount)
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('shares a validation concurrency limit across requests and aborts queued network checks', async () => {
        const f = fixture([new Provider('many', async () => result(...Array.from({ length: 8 }, (_, i) => source(`${i}.mp4`))))])
        const abort = new AbortController()
        let active = 0,
            maxActive = 0
        const fetch = vi.fn(
            (_url: string, options: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    active++
                    maxActive = Math.max(maxActive, active)
                    options.signal?.addEventListener(
                        'abort',
                        () => {
                            active--
                            reject(new Error('aborted'))
                        },
                        { once: true }
                    )
                })
        )
        vi.stubGlobal('fetch', fetch)
        const first = f.service.streamMovieSources('123', f.emit, { signal: abort.signal })
        const second = f.service.streamMovieSources('124', async () => {}, { signal: abort.signal })
        const settled = Promise.allSettled([first, second])
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4))
        abort.abort()
        const outcomes = await settled
        expect(maxActive).toBe(4)
        expect(fetch).toHaveBeenCalledTimes(4)
        expect(active).toBe(0)
        expect(outcomes.every((o) => o.status === 'rejected')).toBe(true)
        expect(f.set).not.toHaveBeenCalled()
    })
    it('finishes a coalesced slow stream with every verified source and a usable refresh mapping', async () => {
        const f = fixture([new Provider('many', async () => result(...Array.from({ length: 12 }, (_, i) => source(`${i}.mp4`))))])
        const gate = deferred<void>()
        let blocked = false
        const fetch = vi.fn(async () => new Response(mediaBytes()))
        vi.stubGlobal('fetch', fetch)
        const pending = f.service.streamMovieSources('123', async (event) => {
            f.events.push(event)
            if (event.type === 'update' && !blocked) {
                blocked = true
                await gate.promise
            }
        })
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(12))
        expect(f.events.filter((e) => e.type === 'update')).toHaveLength(1)
        expect(f.service.getMappingInfo(f.events.at(-1)!.response!.responseId)?.cacheKey).toBe('movie:123')
        gate.resolve()
        await pending
        expect(f.events.at(-1)?.type).toBe('complete')
        expect(f.events.at(-1)?.response?.sources).toHaveLength(12)
        expect(f.events.length).toBeLessThan(8)
    })
    it('coalesces cumulative snapshots behind a slow writer and cancels a blocked writer', async () => {
        const f = fixture([new Provider('many', async () => result(...Array.from({ length: 12 }, (_, i) => source(`${i}.mp4`))))])
        const gate = deferred<void>()
        const abort = new AbortController()
        let blocked = false
        const fetch = vi.fn(async () => new Response(mediaBytes()))
        vi.stubGlobal('fetch', fetch)
        const pending = f.service.streamMovieSources(
            '123',
            async (event) => {
                f.events.push(event)
                if (event.type === 'update' && !blocked) {
                    blocked = true
                    await gate.promise
                }
            },
            { signal: abort.signal }
        )
        const outcome = pending.catch((error) => error)
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(12))
        expect(f.events.filter((e) => e.type === 'update')).toHaveLength(1)
        abort.abort()
        expect((await outcome).name).toBe('AbortError')
        expect(f.set).not.toHaveBeenCalled()
        gate.resolve()
    })
})
