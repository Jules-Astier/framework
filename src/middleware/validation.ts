import { FastifyRequest, FastifyReply } from 'fastify'
import { OMSSErrors } from '../core/errors.js'
import { TMDBService } from '../services/tmdb.service.js'

/**
 * Basic TMDB ID format validation
 */
export function validateTmdbIdFormat(id: string): void {
    if (!/^\d{1,20}$/.test(id)) {
        throw OMSSErrors.invalidTmdbId(id)
    }
}

/**
 * Validate season number format
 */
export function validateSeasonFormat(season: number): void {
    if (season < 0 || season > 99) {
        throw OMSSErrors.invalidSeason(season, 99)
    }
}

/**
 * Validate episode number format
 */
export function validateEpisodeFormat(episode: number, season: number): void {
    if (episode < 1 || episode > 9999) {
        throw OMSSErrors.invalidEpisode(episode, season, 9999)
    }
}

/**
 * Content-Type validation middleware
 * Note: This is an async hook handler that doesn't use the 'done' callback
 */
export async function validateContentType(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const accept = request.headers['accept']

    // Check Accept header
    const streaming = (request.query as { stream?: string } | undefined)?.stream === '1'
    if (accept && !accept.includes('application/json') && !accept.includes('*/*') && !(streaming && accept.includes('application/x-ndjson'))) {
        reply.code(406).send({
            error: {
                code: 'UNSUPPORTED_MEDIA_TYPE',
                message: 'Server only supports application/json responses',
                details: {
                    accept: accept,
                    supported: ['application/json'],
                },
            },
            traceId: request.id,
        })
    }
}

/**
 * Create TMDB validation middleware
 */
export function createTMDBValidator(tmdbService: TMDBService) {
    return {
        /**
         * Validate movie exists and has been released
         */
        async validateMovie(tmdbId: string): Promise<void> {
            // First check format
            validateTmdbIdFormat(tmdbId)

            // Then validate with TMDB
            const result = await tmdbService.validateMovie(tmdbId)

            if (!result.exists) {
                throw OMSSErrors.invalidTmdbId(tmdbId)
            }

            if (!result.released) {
                throw OMSSErrors.invalidTmdbId(tmdbId)
            }
        },

        /**
         * Validate TV episode exists and has aired
         */
        async validateTVEpisode(tmdbId: string, season: number, episode: number): Promise<void> {
            // First check formats
            validateTmdbIdFormat(tmdbId)
            validateSeasonFormat(season)
            validateEpisodeFormat(episode, season)

            // Then validate with TMDB
            const result = await tmdbService.validateTVEpisode(tmdbId, season, episode)

            if (!result.exists) {
                throw OMSSErrors.invalidEpisode(episode, season, -1)
            }

            if (!result.released) {
                throw OMSSErrors.invalidEpisode(episode, season, -1)
            }
        },
    }
}
