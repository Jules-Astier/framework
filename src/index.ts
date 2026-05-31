/**
 * @omss/framework
 *
 * Official OMSS backend framework for multi-provider streaming media aggregation
 *
 * @packageDocumentation
 */

// Core exports
export { OMSSServer } from './core/server.js'
export { OMSSError, OMSSErrors } from './core/errors.js'
export { type CacheService, MemoryCacheService, RedisCacheService } from './core/cache.js'

// Provider exports
export * from './providers/base-provider.js'
export { ProviderRegistry, type ProviderRegistryConfig } from './providers/provider-registry.js'

// Service exports
export { SourceService } from './services/source.service.js'
export { ProxyService } from './services/proxy.service.js'
export { HealthService } from './services/health.service.js'
export { LiveEventService, type LiveEventCacheTTL, type LiveEventListOptions, type LiveEventSourceOptions } from './services/live-event.service.js'

// Utility exports
export { ProxyService as ProxyUtils } from './services/proxy.service.js'

// Re-export commonly used types
export type * from './core/types/index.js'
