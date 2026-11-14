import { FastifyRequest, FastifyReply } from 'fastify'
import { SourceService } from '../services/source.service.js'
import type { SourceDiscoveryEvent } from '../core/types/index.js'

interface SourceQuery {
    stream?: string
    refresh?: string
}

interface MovieParams {
    id: string
}

interface TVParams {
    id: string
    s: string
    e: string
}

interface RefreshParams {
    responseId: string
}

export class ContentController {
    constructor(private sourceService: SourceService) {}

    /**
     * GET /v1/movies/:id
     */
    async getMovie(request: FastifyRequest<{ Params: MovieParams; Querystring: SourceQuery }>, reply: FastifyReply) {
        const { id } = request.params
        if (request.query?.stream === '1') return this.stream(request, reply, (emit, signal) => this.sourceService.streamMovieSources(id, emit, { signal, refresh: request.query?.refresh === '1' }))
        const response = await this.sourceService.getMovieSources(id)
        return reply.code(200).send(response)
    }

    /**
     * GET /v1/tv/:id/seasons/:s/episodes/:e
     */
    async getTVEpisode(request: FastifyRequest<{ Params: TVParams; Querystring: SourceQuery }>, reply: FastifyReply) {
        const { id, s, e } = request.params
        const season = parseInt(s, 10)
        const episode = parseInt(e, 10)
        if (request.query?.stream === '1')
            return this.stream(request, reply, (emit, signal) => this.sourceService.streamTVSources(id, season, episode, emit, { signal, refresh: request.query?.refresh === '1' }))

        const response = await this.sourceService.getTVSources(id, season, episode)
        return reply.code(200).send(response)
    }

    private async stream(request: FastifyRequest, reply: FastifyReply, discover: (emit: (event: SourceDiscoveryEvent) => Promise<void>, signal: AbortSignal) => Promise<void>): Promise<void> {
        const controller = new AbortController()
        const abort = () => controller.abort()
        const close = () => {
            if (!reply.raw.writableFinished) controller.abort()
        }
        request.raw.once('aborted', abort)
        reply.raw.once('close', close)
        // Bound even a connected consumer that stops draining its socket.
        const deadline = setTimeout(() => {
            controller.abort()
            reply.raw.destroy()
        }, this.sourceService.discoveryTimeoutMs() + 2000)
        deadline.unref()
        reply.hijack()
        for (const [name, value] of Object.entries(reply.getHeaders())) {
            if (value !== undefined) reply.raw.setHeader(name, Array.isArray(value) ? value.map(String) : String(value))
        }
        reply.raw.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Accel-Buffering': 'no' })
        const emit = async (event: SourceDiscoveryEvent): Promise<void> => {
            if (controller.signal.aborted || reply.raw.destroyed) throw new DOMException('Client disconnected', 'AbortError')
            if (!reply.raw.write(JSON.stringify(event) + '\n'))
                await new Promise<void>((resolve, reject) => {
                    const cleanup = () => {
                        reply.raw.off('drain', drained)
                        reply.raw.off('close', failed)
                        reply.raw.off('error', failed)
                        controller.signal.removeEventListener('abort', failed)
                    }
                    const drained = () => {
                        cleanup()
                        resolve()
                    }
                    const failed = () => {
                        cleanup()
                        reject(new DOMException('Client disconnected', 'AbortError'))
                    }
                    reply.raw.once('drain', drained)
                    reply.raw.once('close', failed)
                    reply.raw.once('error', failed)
                    controller.signal.addEventListener('abort', failed, { once: true })
                    if (controller.signal.aborted) failed()
                })
        }
        try {
            await discover(emit, controller.signal)
        } catch (error) {
            if (!controller.signal.aborted && !reply.raw.destroyed)
                await emit({
                    type: 'error',
                    error: {
                        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'SOURCE_DISCOVERY_FAILED',
                        message: 'Source discovery could not be completed.',
                    },
                }).catch(() => {})
        } finally {
            clearTimeout(deadline)
            controller.abort()
            request.raw.off('aborted', abort)
            reply.raw.off('close', close)
            if (!reply.raw.destroyed) reply.raw.end()
        }
    }

    /**
     * GET /v1/refresh/:responseId
     */
    async refreshSource(request: FastifyRequest<{ Params: RefreshParams }>, reply: FastifyReply) {
        const { responseId } = request.params
        await this.sourceService.refreshSource(responseId)
        return reply.code(200).send({ status: 'OK' })
    }
}
