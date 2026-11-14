import { BaseProvider } from './base-provider.js'
import * as fs from 'fs/promises'
import * as path from 'path'
import { pathToFileURL } from 'url'
import { LiveProvider, OMSSConfig, ProviderLiveEventCandidate } from '../core/types/index.js'

export interface ProviderRegistryConfig {
    proxyBaseUrl?: string
    host?: string
    port?: number
    protocol?: 'http' | 'https'
    proxyConfig?: OMSSConfig['proxyConfig']
}

export class ProviderRegistry {
    private providers: Map<string, BaseProvider> = new Map()

    constructor(config?: ProviderRegistryConfig) {
        // Set proxy configuration for all providers
        if (config) {
            BaseProvider.setProxyConfig({
                baseUrl: config.proxyBaseUrl,
                host: config.host,
                port: config.port,
                protocol: config.protocol,
                proxyConfig: config.proxyConfig,
            })

            if (config.proxyConfig) {
                BaseProvider.setGlobalProxyConfig(config.proxyConfig)
            }
        }
    }

    /**
     * Register a provider instance
     */
    register(provider: BaseProvider): void {
        if (this.providers.has(provider.id)) {
            throw new Error(`Provider with id '${provider.id}' is already registered`)
        }
        this.providers.set(provider.id, provider)
        console.log(`[ProviderRegistry] Registered provider: ${provider.name} (${provider.id})`)
    }

    /**
     * Unregister a provider
     */
    unregister(providerId: string): boolean {
        return this.providers.delete(providerId)
    }
    /**
     * Auto-discover and register providers from a directory (recursive)
     */
    async discoverProviders(directory: string): Promise<void> {
        try {
            const absoluteDir = path.resolve(directory)

            const dirExists = await fs
                .access(absoluteDir)
                .then(() => true)
                .catch(() => false)

            if (!dirExists) {
                console.warn(`[ProviderRegistry] Directory does not exist: ${absoluteDir}`)
                return
            }

            const entries = await fs.readdir(absoluteDir, { withFileTypes: true })
            console.log(`[ProviderRegistry] Scanning ${entries.length} item(s) in ${absoluteDir}`)

            for (const entry of entries) {
                const fullPath = path.resolve(absoluteDir, entry.name)

                if (entry.isDirectory()) {
                    // Recurse into subdirectory
                    await this.discoverProviders(fullPath)
                    continue
                }

                // Only handle files from here on
                const file = entry.name
                if (!file.endsWith('.js') && !file.endsWith('.ts')) continue
                if (file.includes('.test.') || file.includes('.spec.')) continue
                if (file.endsWith('.d.ts')) continue

                try {
                    const fileUrl = pathToFileURL(fullPath).href
                    const module = await import(fileUrl)

                    let foundProvider = false
                    for (const [name, ExportedClass] of Object.entries(module)) {
                        if (typeof ExportedClass === 'function' && ExportedClass.prototype) {
                            if (BaseProvider.prototype.isPrototypeOf(ExportedClass.prototype)) {
                                try {
                                    // Check if ExportedClass is a constructable class
                                    const instance = new (ExportedClass as { new (): BaseProvider })()
                                    this.register(instance)
                                    foundProvider = true
                                } catch (err) {
                                    console.warn(`[ProviderRegistry] Failed to instantiate ${name} from ${fullPath}:`, err)
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.error(`[ProviderRegistry] Failed to load provider from ${fullPath}:`, error)
                }
            }
        } catch (error) {
            console.error(`[ProviderRegistry] Failed to discover providers in ${directory}:`, error)
        }
    }

    /**
     * Get all providers
     */
    getProviders(): BaseProvider[] {
        return Array.from(this.providers.values())
    }

    /**
     * Get provider by ID
     */
    getProvider(id: string): BaseProvider | undefined {
        return this.providers.get(id)
    }

    /**
     * Get enabled providers only
     */
    getEnabledProviders(): BaseProvider[] {
        return this.getProviders().filter((p) => p.enabled)
    }

    /**
     * Get enabled providers that can resolve live event sources.
     */
    getLiveProviders(): Array<BaseProvider & LiveProvider> {
        return this.getEnabledProviders()
            .filter((p) => p.capabilities.supportedContentTypes.includes('live'))
            .filter((p): p is BaseProvider & LiveProvider => typeof (p as unknown as LiveProvider).getLiveEventSources === 'function')
    }

    /**
     * Get enabled live providers that can discover live event metadata.
     */
    getLiveDiscoveryProviders(): Array<BaseProvider & LiveProvider & { getLiveEvents: () => Promise<ProviderLiveEventCandidate[]> }> {
        return this.getLiveProviders().filter((p): p is BaseProvider & LiveProvider & { getLiveEvents: () => Promise<ProviderLiveEventCandidate[]> } => typeof p.getLiveEvents === 'function')
    }

    /**
     * Check if a provider exists
     */
    hasProvider(id: string): boolean {
        return this.providers.has(id)
    }

    /**
     * Get provider count
     */
    get count(): number {
        return this.providers.size
    }

    /**
     * Health check all providers
     */
    async healthCheckAll(): Promise<Map<string, boolean>> {
        const results = new Map<string, boolean>()

        for (const provider of this.providers.values()) {
            try {
                const healthy = await provider.healthCheck()
                results.set(provider.id, healthy)
            } catch (error) {
                results.set(provider.id, false)
            }
        }

        return results
    }

    /**
     * List all registered provider IDs
     */
    listProviders(): string[] {
        return Array.from(this.providers.keys())
    }

    /**
     * Clear all providers
     */
    clear(): void {
        this.providers.clear()
        console.log('[ProviderRegistry] Cleared all providers')
    }
}
