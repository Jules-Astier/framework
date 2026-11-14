import { HealthResponse, OMSSConfig } from '../core/types/index.js'
import { ProviderRegistry } from '../providers/provider-registry.js'

export class HealthService {
    constructor(
        private config: OMSSConfig,
        private registry: ProviderRegistry
    ) {}

    /**
     * Get health/info response
     */
    getHealth(): HealthResponse {
        this.registry.healthCheckAll()
        return {
            name: this.config.name,
            version: this.config.version,
            status: this.getStatus(),
            endpoints: {
                movie: '/v1/movies/{id}',
                tv: '/v1/tv/{id}/seasons/{s}/episodes/{e}',
                proxy: '/v1/proxy?data={encoded_data}',
                refresh: '/v1/refresh/{responseId}',
                liveEvents: '/v1/live/events',
                liveSources: '/v1/live/events/{eventId}/sources',
            },
            spec: 'omss',
            note:
                this.config.note ??
                `Running with ${this.registry.getEnabledProviders().length} provider(s). Supported Providers: ${this.registry
                    .getEnabledProviders()
                    .map((p) => p.name)
                    .join(', ')}`,
        }
    }

    /**
     * Determine current status
     */
    private getStatus(): 'operational' | 'degraded' | 'maintenance' | 'offline' {
        const providerCount = this.registry.count

        if (providerCount === 0) {
            return 'degraded' // No providers but server is running
        }

        return 'operational'
    }
}
