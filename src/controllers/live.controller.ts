import { FastifyReply, FastifyRequest } from 'fastify'
import { LiveEventService } from '../services/live-event.service.js'

interface LiveEventParams {
    eventId: string
}

interface LiveEventQuery {
    refresh?: string
}

export class LiveController {
    constructor(private liveEventService: LiveEventService) {}

    /**
     * GET /v1/live/events
     */
    async listEvents(request: FastifyRequest<{ Querystring: LiveEventQuery }>, reply: FastifyReply) {
        const events = await this.liveEventService.getEvents({
            refresh: this.isRefreshRequest(request.query.refresh),
        })
        return reply.code(200).send({ events })
    }

    /**
     * GET /v1/live/events/:eventId
     */
    async getEvent(request: FastifyRequest<{ Params: LiveEventParams; Querystring: LiveEventQuery }>, reply: FastifyReply) {
        const event = await this.liveEventService.getEvent(request.params.eventId, {
            refresh: this.isRefreshRequest(request.query.refresh),
        })
        return reply.code(200).send({ event })
    }

    /**
     * GET /v1/live/events/:eventId/sources
     */
    async getEventSources(request: FastifyRequest<{ Params: LiveEventParams; Querystring: LiveEventQuery }>, reply: FastifyReply) {
        const response = await this.liveEventService.getLiveEventSources(request.params.eventId, {
            refresh: this.isRefreshRequest(request.query.refresh),
        })
        return reply.code(200).send(response)
    }

    private isRefreshRequest(value?: string): boolean {
        return value === '1' || value === 'true'
    }
}
