import { ErrorCode } from './types/index.js'

export class OMSSError extends Error {
    constructor(
        public code: ErrorCode,
        public message: string,
        public statusCode: number,
        public details?: Record<string, any>,
        public traceId: string = crypto.randomUUID()
    ) {
        super(message)
        this.name = 'OMSSError'
    }

    toJSON() {
        return {
            error: {
                code: this.code,
                message: this.message,
                details: this.details,
            },
            traceId: this.traceId,
        }
    }
}

// Factory functions for common errors
export const OMSSErrors = {
    invalidTmdbId: (value: string) =>
        new OMSSError('INVALID_TMDB_ID', 'TMDB ID must be numeric', 400, {
            parameter: 'id',
            value,
            expected: 'numeric string',
        }),

    noSourcesAvailable: (tmdbId: string, providersChecked: number) =>
        new OMSSError('NO_SOURCES_AVAILABLE', `No streaming sources found for TMDB ID: ${tmdbId}`, 404, {
            parameter: 'id',
            value: tmdbId,
            providersChecked,
            allProvidersFailed: true,
        }),

    invalidSeason: (season: number, maxSeason: number) =>
        new OMSSError('INVALID_SEASON', `Season ${season} is out of valid range (max: ${maxSeason})`, 400, { parameter: 's', value: season, maxSeason }),

    invalidEpisode: (episode: number, season: number, maxEpisode: number) =>
        new OMSSError('INVALID_EPISODE', `Episode ${episode} is out of valid range for season ${season}`, 400, { parameter: 'e', value: episode, season, maxEpisode }),

    invalidResponseId: (responseId: string) =>
        new OMSSError('INVALID_RESPONSE_ID', 'Invalid responseId format', 400, {
            parameter: 'responseId',
            value: responseId,
        }),

    responseIdNotFound: (responseId: string) => new OMSSError('RESPONSE_ID_NOT_FOUND', 'ResponseId not found or already refreshed', 404, { parameter: 'responseId', value: responseId }),

    eventNotFound: (eventId: string) =>
        new OMSSError('EVENT_NOT_FOUND', `Live event not found: ${eventId}`, 404, {
            parameter: 'eventId',
            value: eventId,
        }),

    eventNotLive: (eventId: string, status?: string) =>
        new OMSSError('EVENT_NOT_LIVE', `Live event is not currently playable: ${eventId}`, 409, {
            parameter: 'eventId',
            value: eventId,
            status,
        }),

    authRequired: (providerId?: string) =>
        new OMSSError('AUTH_REQUIRED', 'Provider authentication is required for this live source', 401, {
            providerId,
        }),

    regionBlocked: (eventId: string, region?: string) =>
        new OMSSError('REGION_BLOCKED', `Live event is blocked in this region: ${eventId}`, 451, {
            parameter: 'eventId',
            value: eventId,
            region,
        }),

    internalError: (message: string) => new OMSSError('INTERNAL_ERROR', message, 500),
}
