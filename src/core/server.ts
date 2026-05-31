import Fastify, { FastifyInstance } from 'fastify'
import cors, { FastifyCorsOptions } from '@fastify/cors'
import { OMSSConfig } from './types/index.js'
import { ProviderRegistry } from '../providers/provider-registry.js'
import { createCacheService, CacheService } from './cache.js'
import { SourceService } from '../services/source.service.js'
import { ProxyService } from '../services/proxy.service.js'
import { HealthService } from '../services/health.service.js'
import { StremioService } from '../services/stremio.service.js'
import { LiveEventService } from '../services/live-event.service.js'
import { ContentController } from '../controllers/content.controller.js'
import { ProxyController } from '../controllers/proxy.controller.js'
import { HealthController } from '../controllers/health.controller.js'
import { LiveController } from '../controllers/live.controller.js'
import { errorHandler } from '../middleware/error-handler.js'
import { requestLogger } from '../middleware/logger.js'
import { validateContentType } from '../middleware/validation.js'
import { TMDBService } from '../services/tmdb.service.js'
import { StremioController } from '../controllers/stremio.controller.js'
import { MCPController } from '../controllers/mcp.controller.js'

export class OMSSServer {
    private app: FastifyInstance
    private config: OMSSConfig
    private registry: ProviderRegistry
    private cache: CacheService

    // Services
    private sourceService: SourceService
    private proxyService: ProxyService
    private healthService: HealthService
    private tmdbService: TMDBService
    private stremioService: StremioService
    private liveEventService: LiveEventService

    // Controllers
    private contentController: ContentController
    private proxyController: ProxyController
    private healthController: HealthController
    private liveController: LiveController
    private stremioController?: StremioController
    private mcpController?: MCPController

    constructor(config: OMSSConfig, registry?: ProviderRegistry) {
        this.config = config

        // Create registry with proxy configuration
        const host = config.host || 'localhost'
        const port = config.port || 3000

        // Determine proxy base URL
        let proxyBaseUrl: string

        if (config.publicUrl) {
            // Use explicit public URL
            proxyBaseUrl = config.publicUrl
        } else if (host === '0.0.0.0' || host === '::') {
            // Listen on all interfaces - use localhost for local proxying
            proxyBaseUrl = `http://localhost:${port}`
        } else {
            // Use configured host and port
            proxyBaseUrl = `http://${host}:${port}`
        }

        this.registry =
            registry ||
            new ProviderRegistry({
                proxyBaseUrl,
                proxyConfig: config.proxyConfig,
            })

        console.log(`[Server] Proxy base URL: ${proxyBaseUrl}`)

        // Initialize Fastify
        this.app = Fastify({
            logger: false,
            requestIdHeader: 'x-request-id',
            genReqId: () => crypto.randomUUID(),
            trustProxy: true,
        })

        // Initialize cache
        this.cache = createCacheService(config.cache)

        // Initialize TMDB service
        const tmdbApiKey = process.env.TMDB_API_KEY || config.tmdb?.apiKey
        if (!tmdbApiKey) {
            throw new Error('TMDB_API_KEY is required. Set it in .env or config')
        }

        this.tmdbService = new TMDBService(tmdbApiKey, this.cache, config.tmdb?.cacheTTL || 86400)

        // Initialize services
        this.proxyService = new ProxyService(config.proxyConfig?.streamPatterns || [])
        this.stremioService = new StremioService(config.stremio?.stremioAddons || [], this.proxyService)
        this.sourceService = new SourceService(this.registry, this.cache, this.tmdbService, this.stremioService, config.cache?.ttl)
        this.liveEventService = new LiveEventService(this.registry, this.cache, {
            manifest: config.cache?.ttl?.liveManifest ?? 6 * 60 * 60,
            sources: config.cache?.ttl?.liveSources ?? 30,
        })
        this.healthService = new HealthService(config, this.registry)

        // Initialize controllers
        this.contentController = new ContentController(this.sourceService)
        this.proxyController = new ProxyController(this.proxyService)
        this.healthController = new HealthController(this.healthService)
        this.liveController = new LiveController(this.liveEventService)

        if (config.stremio?.enableNativeAddon) {
            this.stremioController = new StremioController(this.sourceService, config, this.tmdbService)
        }

        if (config.mcp?.enabled) {
            this.mcpController = new MCPController(this.sourceService)
        }

        // Setup middleware and routes
        this.setupMiddleware(config.cors)
        this.setupRoutes()
        this.setupErrorHandlers()
    }

    /**
     * Setup middleware
     */
    private setupMiddleware(customCorsOptions?: FastifyCorsOptions): void {
        // CORS
        this.app.register(
            cors,
            customCorsOptions || {
                origin: '*',
                methods: ['GET', 'OPTIONS', 'HEAD'],
                allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
                exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges'],
                credentials: false,
            }
        )

        // Request logging
        this.app.addHook('onRequest', requestLogger)

        // Content-Type validation
        this.app.addHook('preHandler', validateContentType)
    }

    /**
     * Setup routes
     */
    private setupRoutes(): void {
        // Health endpoints
        this.app.get('/', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1/', this.healthController.getHealth.bind(this.healthController))
        this.app.get('/v1/health', this.healthController.getHealth.bind(this.healthController))

        // Content endpoints
        this.app.get('/v1/movies/:id', this.contentController.getMovie.bind(this.contentController))
        this.app.get('/v1/tv/:id/seasons/:s/episodes/:e', this.contentController.getTVEpisode.bind(this.contentController))
        this.app.get('/v1/live/events', this.liveController.listEvents.bind(this.liveController))
        this.app.get('/v1/live/events/:eventId', this.liveController.getEvent.bind(this.liveController))
        this.app.get('/v1/live/events/:eventId/sources', this.liveController.getEventSources.bind(this.liveController))

        // Refresh endpoint
        this.app.get('/v1/refresh/:responseId', this.contentController.refreshSource.bind(this.contentController))

        // Proxy endpoint
        this.app.get('/v1/proxy', this.proxyController.proxy.bind(this.proxyController))

        // Stremio addon endpoint
        if (this.stremioController) {
            this.app.get('/stremio/manifest.json', this.stremioController.getManifest.bind(this.stremioController))
            this.app.get('/stremio/stream/:type/:id', this.stremioController.getStream.bind(this.stremioController))
        }

        if (this.mcpController && this.config.mcp?.enabled) {
            const path = this.config.mcp.path || '/mcp'
            this.app.post(path, this.mcpController.handle.bind(this.mcpController))
        }

        // 404 handler
        this.app.setNotFoundHandler((request, reply) => {
            reply.code(404).send({
                error: {
                    code: 'ENDPOINT_NOT_FOUND',
                    message: 'The requested endpoint does not exist',
                    details: {
                        path: request.url,
                        method: request.method,
                    },
                },
                traceId: request.id,
            })
        })
    }

    /**
     * Setup error handlers
     */
    private setupErrorHandlers(): void {
        this.app.setErrorHandler(errorHandler)
    }

    /**
     * Start the server
     */
    async start(): Promise<void> {
        try {
            const host = this.config.host || 'localhost'
            const port = this.config.port || 3000

            await this.app.listen({ port, host })

            const addons = this.config.stremio?.stremioAddons || []
            const enabledAddons = addons.filter((a) => a.enabled !== false).length
            const mcpStatus = this.config.mcp?.enabled ? 'Enabled' : 'Disabled'
            const stremioStatus = this.config.stremio?.enableNativeAddon ? `Enabled` : 'Disabled'

            console.log(`
╔════════════════════════════════════════════════════════╗
║                   OMSS Backend Server                  ║
╠════════════════════════════════════════════════════════╣
║  Name:       ${this.config.name.padEnd(42)}║
║  Version:    ${this.config.version.padEnd(42)}║
║  Port:       ${port.toString().padEnd(42)}║
║  Providers:  ${this.registry ? this.registry['providers'].size.toString().padEnd(42) : '0'.padEnd(42)}║
║  Cache:      ${(this.config.cache?.type || 'memory').padEnd(42)}║
║  Stremio:    ${stremioStatus.padEnd(42)}║
║  MCP:        ${mcpStatus.padEnd(42)}║
║  Addons:     ${`${enabledAddons} enabled`.padEnd(42)}║
╠════════════════════════════════════════════════════════╣
║  Endpoints:                                            ║
║    GET  /                        - Health check        ║
║    GET  /v1/movies/:id           - Movie sources       ║
║    GET  /v1/tv/:id/seasons/:s/episodes/:e              ║
║                                  - TV sources          ║
║    GET  /v1/live/events          - Live event manifest ║
║    GET  /v1/live/events/:eventId/sources               ║
║                                  - Live event sources  ║
║    GET  /v1/proxy?data=...       - Proxy endpoint      ║
║    GET  /v1/refresh/:responseId  - Refresh cache       ║`)

            if (this.config.stremio?.enableNativeAddon) {
                console.log(`║                                                        ║
║    GET  /stremio/manifest.json    - Stremio manifest   ║`)
            }

            console.log(`╚════════════════════════════════════════════════════════╝

🚀 Server listening at http://${host}:${port}
      `)
        } catch (error) {
            console.error('[Server] Failed to start:', error)
            throw error
        }
    }

    /**
     * Stop the server gracefully
     */
    async stop(): Promise<void> {
        console.log('[Server] Shutting down...')

        try {
            await this.app.close()

            // Cleanup cache
            if ('destroy' in this.cache) {
                ;(this.cache as any).destroy?.()
            } else if ('disconnect' in this.cache) {
                await (this.cache as any).disconnect?.()
            }

            console.log('[Server] Shutdown complete')
        } catch (error) {
            console.error('[Server] Error during shutdown:', error)
            throw error
        }
    }

    /**
     * Get the Fastify instance (for testing or custom configuration)
     */
    getInstance(): FastifyInstance {
        return this.app
    }

    /**
     * Get the provider registry
     */
    getRegistry(): ProviderRegistry {
        return this.registry
    }
}
