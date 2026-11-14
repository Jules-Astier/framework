import { afterEach, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { ContentController } from '../../../src/controllers/content.controller.js'
import { validateContentType } from '../../../src/middleware/validation.js'
import type { SourceDiscoveryEvent } from '../../../src/core/types/index.js'
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()))
})
const response = { responseId: 'stable', expiresAt: new Date(Date.now() + 60000).toISOString(), sources: [], subtitles: [], diagnostics: [] }
async function server(service: any) {
    const app = Fastify()
    const controller = new ContentController(service)
    app.addHook('preHandler', validateContentType)
    app.get('/v1/movies/:id', controller.getMovie.bind(controller))
    app.get('/v1/tv/:id/seasons/:s/episodes/:e', controller.getTVEpisode.bind(controller))
    await app.listen({ port: 0, host: '127.0.0.1' })
    cleanups.push(async () => {
        app.server.closeAllConnections()
        await app.close()
    })
    const address = app.server.address() as { port: number }
    return `http://127.0.0.1:${address.port}`
}
it('writes NDJSON before search completes and forwards refresh/TV identity', async () => {
    let finish!: () => void
    const gate = new Promise<void>((r) => {
        finish = r
    })
    const service = {
        discoveryTimeoutMs: () => 30000,
        streamTVSources: vi.fn(async (_id: string, _season: number, _episode: number, emit: (event: SourceDiscoveryEvent) => Promise<void>) => {
            await emit({ type: 'start', response })
            await gate
            await emit({ type: 'complete', response })
        }),
    }
    const origin = await server(service)
    const result = await fetch(origin + '/v1/tv/96677/seasons/1/episodes/1?stream=1&refresh=1', { headers: { Accept: 'application/x-ndjson' } })
    expect(result.status).toBe(200)
    expect(result.headers.get('content-type')).toContain('application/x-ndjson')
    expect(result.headers.get('x-accel-buffering')).toBe('no')
    const reader = result.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    expect(first).toContain('"type":"start"')
    expect(first).not.toContain('"type":"complete"')
    expect(service.streamTVSources).toHaveBeenCalledWith('96677', 1, 1, expect.any(Function), expect.objectContaining({ refresh: true, signal: expect.any(AbortSignal) }))
    finish()
    let rest = ''
    while (true) {
        const next = await reader.read()
        if (next.done) break
        rest += new TextDecoder().decode(next.value)
    }
    expect(rest).toContain('"type":"complete"')
})
it('aborts upstream discovery when the real client disconnects', async () => {
    let signal!: AbortSignal
    const origin = await server({
        discoveryTimeoutMs: () => 30000,
        streamMovieSources: async (_id: string, emit: (event: SourceDiscoveryEvent) => Promise<void>, options: { signal: AbortSignal }) => {
            signal = options.signal
            await emit({ type: 'start', response })
            await new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }))
        },
    })
    const result = await fetch(origin + '/v1/movies/123?stream=1')
    const reader = result.body!.getReader()
    await reader.read()
    await reader.cancel()
    await vi.waitFor(() => expect(signal.aborted).toBe(true))
})
it('preserves legacy JSON requests and does not accept NDJSON without stream mode', async () => {
    const service = { getMovieSources: vi.fn(async () => response) }
    const origin = await server(service)
    const result = await fetch(origin + '/v1/movies/123')
    expect(await result.json()).toEqual(response)
    expect(service.getMovieSources).toHaveBeenCalledWith('123')
    const rejected = await fetch(origin + '/v1/movies/123', { headers: { Accept: 'application/x-ndjson' } })
    expect(rejected.status).toBe(406)
})
