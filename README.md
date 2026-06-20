<div align="center">

# [~OMSS Framework~ MOVED](https://github.com/omss-spec/core)

[![NPM Version](https://img.shields.io/npm/v/@omss/framework.svg)](https://www.npmjs.com/package/@omss/framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![OMSS Spec](https://img.shields.io/badge/OMSS-v1.0.0-orange.svg)](https://github.com/omss-spec/omss-spec)
[![Node.js](https://img.shields.io/badge/Node.js-20.6+-green.svg)](https://nodejs.org/)

</div>

> [!CAUTION]
> We are writing this whole thing new. If you are looking to implement OMSS v1, you can still use this framework.
> 
> Starting OMSS v1.1 and future releases will be moved to: https://github.com/omss-spec/core
> The whole structure/usage will be different. Please bear with us while we are migrating. 

---

<details><summary>Click me to read the old readme.</summary>

<div align="center">

# OMSS Framework

[![NPM Version](https://img.shields.io/npm/v/@omss/framework.svg)](https://www.npmjs.com/package/@omss/framework)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3+-blue.svg)](https://www.typescriptlang.org/)
[![OMSS Spec](https://img.shields.io/badge/OMSS-v1.0.0-orange.svg)](https://github.com/omss-spec/omss-spec)
[![Node.js](https://img.shields.io/badge/Node.js-20.6+-green.svg)](https://nodejs.org/)

<img  alt="social preview" src="https://github.com/user-attachments/assets/bc6d19dc-0d86-43e5-86cc-6e1d32bdab40" />

This is an extendable multi site scraping framework, which follows the implementation guidelines of the **[OMSS (Open Media Streaming Standard)](https://github.com/omss-spec/omss-spec)**. It demonstrates how to build a compliant streaming media aggregation service that scrapes content from multiple providers and returns standardized responses. It handles most of the logic already for you. You just have to add the scraping logic!

Additionally, this is **the worlds first AI-Enabled Streaming Framework**! With built-in support for the Model Context Protocol (MCP), you can easily integrate LLMs and intelligent agents to find streaming sources using natural language queries, or even automate the management of your streaming backend using AI assistants.

---

## [_🚀Check This Template Out To Get Started!🚀_](https://github.com/omss-spec/template)

---

</div>

## 🎯 What is OMSS?

OMSS is an open standard for streaming media aggregation. It provides a unified API for fetching movie and TV show streaming sources from multiple providers, with built-in proxy support, subtitle handling, and quality selection.

## 🔍 What is the `@omss/framework`?

The `@omss/framework` is the official TypeScript/Node.js implementation framework that makes building OMSS-compliant backends effortless. Instead of manually implementing the standard from scratch, developers can focus solely on writing provider scraping logic while the framework handles all the boilerplate — routing, validation, proxy management, caching, error handling, and response formatting.

### Key Features

- ✅ **Standardized API**: Consistent response format across all providers
- ✅ **MCP Support**: Optional Model Context Protocol endpoint for LLM integration
- ✅ **Stremio Compatibility**: Designed to work seamlessly with Stremio Addons and also support Stremio Addon SDK
- ✅ **Multi-Provider Support**: Aggregate sources from multiple streaming providers
- ✅ **Built-in Proxy**: Automatic URL proxying with header forwarding
- ✅ **TMDB Integration**: Validation against The Movie Database
- ✅ **Caching Layer**: Redis or in-memory caching for performance
- ✅ **Type Safety**: Full TypeScript support
- ✅ **Provider Management**: Easy enable/disable, automatic discovery
- ✅ **Health Checks**: Monitor provider availability
- ✅ **Refresh API**: Force cache invalidation when needed

## 📋 Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Creating Custom Providers](#creating-custom-providers)
- [MCP Endpoints](#mcp-endpoints)
- [API Endpoints](#api-endpoints)
- [Environment Variables](#environment-variables)
- [Stremio Compatibility](#stremio-compatibility)
- [Architecture](#architecture)
- [OMSS Compliance](#omss-compliance)
- [License](#license)

## 🚀 Installation

There is a template which you can use to easily create your own streaming backend. Check it out [here!](https://github.com/omss-spec/template) **This is the easiest way to create your own OMSS backend.**

### Prerequisites

- Node.js 18.x or higher
- npm or yarn
- TMDB API Key ([Get one here](https://www.themoviedb.org/settings/api))
- (Optional) Redis server for caching

### Install Dependencies

```bash
# npm
npm install @omss/framework

# yarn
yarn add @omss/framework

# pnpm
pnpm add @omss/framework
```

## 🚀 Quick start

Minimal example using the built‑in provider and in‑memory cache:

```ts
// src/server.ts
import { OMSSServer } from '@omss/framework'
import { ExampleProvider } from './src/providers/implementations/example-provider'

// Create server instance
const server = new OMSSServer({
    name: 'My OMSS Backend',
    version: '1.0.0',
    host: 'localhost',
    port: 3000,
    cache: {
        type: 'memory',
        ttl: {
            sources: 7200,
            subtitles: 7200,
        },
    },
    tmdb: {
        apiKey: process.env.TMDB_API_KEY,
        cacheTTL: 86400,
    },
    proxyConfig: {
        knownThirdPartyProxies: {
            'hls1.vid1.site': [/\/proxy\/(.+)$/],
            'madplay.site': [/\/api\/[^/]+\/proxy\?url=(.+)$/],
            '*': [/\/proxy\/(.+)$/, /\/m3u8-proxy\?url=(.+?)(&|$)/],
        },
        streamPatterns: [/^https?:\/\/.+\.(mp4)(\?.*)?$/], // treat direct mp4 links as streams that need proxying. You can also add custom domains that should be streamed through the proxy.
    },
    // You can override the default cors settings, by passing your own fastify cors options here. By default, it allows all origins.
    /*
    cors: {
        origin: '*',
        methods: ['GET', 'OPTIONS', 'HEAD'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Range', 'Accept'],
        exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Range', 'Accept-Ranges'],
    },
    */
})

// Register providers
const registry = server.getRegistry()
registry.register(new ExampleProvider())

// or use the very cool auto-discovery feature
// registry.discoverProviders('./path/to/providerfolder');
// Note: this is relative to *where you start the server*.

// before starting the server, you can also modify any fastify instance settings, by getting the instance via server.getFastifyInstance() and calling any of its methods. For example, to add a custom route:

// Start server
await server.start()
```

`.env`:

```env
# Server Configuration
PORT=3000            # Port number for the server
HOST=0.0.0.0         # Use 'localhost' to restrict to local access
NODE_ENV=development # 'development' | 'production'

# TMDB Configuration
TMDB_API_KEY=your_tmdb_api_key_here
TMDB_CACHE_TTL=86400

# Cache Configuration
CACHE_TYPE=memory    # 'memory' | 'redis'

# Redis Configuration (if using Redis cache)
REDIS_HOST=localhost # default Redis host
REDIS_PORT=6379      # default Redis port
REDIS_PASSWORD=      # Redis password if required
```

Run in dev:

```bash
npm run dev
```

And then it should work!

## ⚙️ Configuration

### Server Configuration Options

```typescript
interface OMSSConfig {
    // Required: Server identification
    name: string // Your server name
    version: string // OMSS Spec version

    // Optional: Network settings
    host?: string // Default: 'localhost'
    port?: number // Default: 3000
    publicUrl?: string // For reverse proxy setups

    // Optional: Cache configuration
    cache?: {
        type: 'memory' | 'redis'
        ttl: {
            sources: number
            subtitles: number
        }
        redis?: {
            host: string
            port: number
            password?: string
        }
    }

    // Required: TMDB configuration
    tmdb?: {
        apiKey?: string // Can also use TMDB_API_KEY env var
        cacheTTL?: number // Default: 86400 (24 hours)
    }

    // Proxy configuration
    proxyConfig?: {
        knownThirdPartyProxies: Record<string, RegExp[]> // for this, see the documentation in docs/third-party-pattern-config.md
        streamPatterns: RegExp[] // Optional: Custom patterns to identify streaming URLs that need proxying
    }

    // Optional: CORS configuration (overrides default)
    cors?: {
        origin: string
        methods: string[]
        allowedHeaders: string[]
        exposedHeaders: string[]
    }
}
```

### Example Configurations

#### Development

```typescript
const server = new OMSSServer({
    name: 'OMSS Dev Server',
    version: '1.0.0',
    host: 'localhost',
    port: 3000,
    cache: {
        type: 'memory',
        ttl: {
            sources: 7200,
            subtitles: 7200,
        },
    },
    tmdb: {
        apiKey: process.env.TMDB_API_KEY,
        cacheTTL: 86400,
    },
    proxyConfig: {
        knownThirdPartyProxies: {}, // for this, see the documentation in docs/third-party-pattern-config.md
        streamPatterns: [/^https?:\/\/.+\.(mp4)(\?.*)?$/], // treat direct mp4 links as streams that need proxying. You can also add custom domains that should be streamed through the proxy.
    },
})
```

#### Production with Redis

```typescript
const server = new OMSSServer({
    name: 'OMSS Production',
    version: '1.0.0',
    host: '0.0.0.0',
    port: 3000,
    publicUrl: 'https://api.mystream.com',
    cache: {
        type: 'redis',
        ttl: {
            sources: 7200,
            subtitles: 7200,
        },
        redis: {
            host: process.env.REDIS_HOST || 'localhost',
            port: parseInt(process.env.REDIS_PORT || '6379'),
            password: process.env.REDIS_PASSWORD,
        },
    },
    tmdb: {
        apiKey: process.env.TMDB_API_KEY,
        cacheTTL: 86400,
    },
    proxyConfig: {
        knownThirdPartyProxies: {}, // for this, see the documentation in docs/third-party-pattern-config.md
        streamPatterns: [/^https?:\/\/.+\.(mp4)(\?.*)?$/], // treat direct mp4 links as streams that need proxying. You can also add custom domains that should be streamed through the proxy.
    },
    cors: {
        origin: 'https://myapp.com',
        methods: ['GET', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length', 'Content-Type'],
    },
})
```

#### Behind Reverse Proxy

```typescript
const server = new OMSSServer({
    name: 'OMSS API',
    version: '1.0.0',
    host: '0.0.0.0',
    port: 3000,
    // This is the public URL clients will use
    publicUrl: 'https://myapp.com/api',
    cache: {
        type: 'redis',
        redis: {
            host: 'redis.internal',
            port: 6379,
        },
    },
    tmdb: {
        apiKey: process.env.TMDB_API_KEY,
        cacheTTL: 86400,
    },
    proxyConfig: {
        knownThirdPartyProxies: {}, // for this, see the documentation in docs/third-party-pattern-config.md
        streamPatterns: [/^https?:\/\/.+\.(mp4)(\?.*)?$/], // treat direct mp4 links as streams that need proxying. You can also add custom domains that should be streamed through the proxy.
    },
    cors: {
        origin: 'https://myapp.com',
        methods: ['GET', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Content-Length', 'Content-Type'],
    },
})
```

## 🔌 Creating Custom Providers

See the detailed [Provider Creation Guide](./examples/example-provider.ts) for a complete walkthrough.

### Quick Start with Auto-Discovery

The easiest way to add a new provider:

1. Create a directory for all of your provider files

    ```bash
    touch src/providers/implementations/my-provider.ts
    ```

2. Implement the `BaseProvider` class (see example below) in each file.

3. In the Setup, use the `discoverProviders` method of the `ProviderRegistry` to load all providers from that directory:

    ```typescript
    const registry = server.getRegistry()
    registry.discoverProviders('./src/providers/implementations') // relative to where you start the server from
    ```

4. That's it! The provider will be automatically discovered and registered when you start the server!

No imports, no manual registration needed!

### Minimal Provider Example

```typescript
import { BaseProvider } from './src/providers/base-provider'
import { ProviderCapabilities, ProviderMediaObject, ProviderResult } from './src/core/types'

export class MyProvider extends BaseProvider {
    // Required: Provider identification
    readonly id = 'my-provider'
    readonly name = 'My Provider'
    readonly enabled = true

    // Required: Base URL and headers
    readonly BASE_URL = 'https://provider.example.com'
    readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0',
        Referer: 'https://provider.example.com',
    }

    // Required: Declare what this provider supports
    readonly capabilities: ProviderCapabilities = {
        supportedContentTypes: ['movies', 'tv'],
    }

    // Implement movie scraping
    async getMovieSources(media: ProviderMediaObject): Promise<ProviderResult> {
        this.console.log('Fetching movie sources', media)

        try {
            // Your scraping logic here
            const streamUrl = await this.scrapeMovieUrl(media.tmdbId) // this is just some example function

            return {
                sources: [
                    {
                        url: this.createProxyUrl(streamUrl, this.HEADERS),
                        type: 'hls',
                        quality: '1080p',
                        audioTracks: [
                            {
                                language: 'en',
                                label: 'English',
                            },
                        ],
                        provider: {
                            id: this.id,
                            name: this.name,
                        },
                    },
                ],
                subtitles: [],
                diagnostics: [],
            }
        } catch (error) {
            this.console.error('Failed to fetch sources', error, media)

            return {
                sources: [],
                subtitles: [],
                diagnostics: [
                    {
                        code: 'PROVIDER_ERROR',
                        message: `${this.name} failed`,
                        field: '',
                        severity: 'error',
                    },
                ],
            }
        }
    }

    // Implement TV scraping
    async getTVSources(media: ProviderMediaObject): Promise<ProviderResult> {
        // Similar to getMovieSources but for TV
        return { sources: [], subtitles: [], diagnostics: [] }
    }

    // Optional: Custom health check
    async healthCheck(): Promise<boolean> {
        try {
            const response = await fetch(this.BASE_URL)
            return response.ok
        } catch {
            return false
        }
    }
}
```

### Full Provider Example

See the detailed [Provider Creation Guide](./examples/example-provider.ts) for a complete walkthrough.

To test a singulare Provider without setting up the whole server, you can use the following file, which will run the provider in isolation and allow you to test its functionality, without debugging the whole server.

```typescript
import { ProviderMediaObject } from "@omss/framework"
import {ExampleProvider} from "./example.js"

const prov = new ExampleProvider()

const mediaObj: ProviderMediaObject = {
  title: "The Dark Knight",
  tmdbId: "155",
  releaseYear: "2008",
  type: "movie",
  imdbId: "tt0468569"
}

const resp = await prov.getMovieSources(mediaObj)

console.log(resp)
```

## 🧩 MCP Endpoints

The Model Context Protocol (MCP) is an optional JSON-RPC-like API that allows LLMs and other intelligent agents to interact with your OMSS server in a structured way. This can be useful for advanced integrations, such as allowing users to ask an AI assistant to find streaming sources for a movie or TV show.

When enabled, the MCP endpoint is exposed at `/mcp` (configurable) and accepts POST requests with a JSON body containing the method and parameters. The framework currently supports the following MCP method:

- `omss_get_sources`: Fetches streaming sources for a movie or TV episode by TMDB ID. Parameters are the same as the regular API endpoints, but wrapped in an MCP request.

## 📡 API Endpoints

### GET `/v1/movies/:tmdbId`

Fetch streaming sources for a movie.

**Parameters:**

- `tmdbId` (path): TMDB movie ID

**Response:**

```json
{
    "responseId": "uuid-v4",
    "expiresAt": "2026-01-18T20:00:00.000Z",
    "sources": [
        {
            "url": "/v1/proxy?data=...",
            "type": "hls",
            "quality": "1080p",
            "audioTracks": [
                {
                    "language": "en",
                    "label": "English"
                }
            ],
            "provider": {
                "id": "vixsrc",
                "name": "VixSrc"
            }
        }
    ],
    "subtitles": [],
    "diagnostics": []
}
```

### GET `/v1/tv/:tmdbId/seasons/:season/episodes/:episode`

Fetch streaming sources for a TV episode.

**Parameters:**

- `tmdbId` (path): TMDB series ID
- `season` (path): Season number (0-99)
- `episode` (path): Episode number (1-9999)

**Response:** Same structure as movies endpoint

### GET `/v1/proxy`

Proxy streaming URLs with custom headers.

**Query Parameters:**

- `data` (required): URL-encoded JSON containing:
    ```json
    {
        "url": "https://stream.example.com/video.m3u8",
        "headers": {
            "Referer": "https://provider.example.com"
        }
    }
    ```

### GET `/v1/refresh/:responseId`

Force refresh cached sources.

**Parameters:**

- `responseId` (path): Response ID from previous request

### GET `/v1/health`

Health check endpoint.

**Response:**

```json
{
    "status": "healthy",
    "version": "1.0.0",
    "providers": {
        "total": 1,
        "enabled": 1
    }
}
```

## 🌍 Environment Variables

```env
# Server Configuration
PORT=3000            # Port number for the server
HOST=0.0.0.0         # Use 'localhost' to restrict to local access
NODE_ENV=development # 'development' | 'production'
MCP_ENABLED=false    # 'true' | 'false'

# TMDB Configuration
TMDB_API_KEY=your_tmdb_api_key_here
TMDB_CACHE_TTL=86400

# Cache Configuration
CACHE_TYPE=memory    # 'memory' | 'redis'

# Redis Configuration (if using Redis cache)
REDIS_HOST=localhost # default Redis host
REDIS_PORT=6379      # default Redis port
REDIS_PASSWORD=      # Redis password if required
```

## 📺 Stremio Compatibility

Although the original OMSS standard was not specifically designed for Stremio, this framework is fully compatible with Stremio. In both ways:

1. You can use this framework to build a Stremio Addon. To enable the Stremio Addon SDK, simply set the `stremioAddon` option to `true` in the server configuration. This will automatically add the required endpoints (`/stremio/manifest.json`) and response formatting to work seamlessly with Stremio.

2. You can bind other Stremio Addon's directly to this framework. Since all Stremio Addons follow a standardized API, you can just pass the manifest URL of any Stremio Addon to the `stremioAddons` configuration option, and the framework will automatically fetch the manifest, extract the sources and bind them to your server. This allows you to easily aggregate sources from existing Stremio Addons alongside your custom providers, and expose them all through a single unified API.

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        OMSS Server                          │
├─────────────────────────────────────────────────────────────┤
│  Controllers                                                │
│  ├── ContentController (Movies/TV endpoints)                │
│  ├── ProxyController (Streaming proxy)                      │
│  └── HealthController (Health checks)                       │
├─────────────────────────────────────────────────────────────┤
│  Services                                                   │
│  ├── SourceService (Aggregates provider results)            │
│  ├── TMDBService (Validates against TMDB)                   │
│  └── ProxyService (Handles URL proxying)                    │
├─────────────────────────────────────────────────────────────┤
│  Provider Registry                                          │
│  └── Manages all registered providers                       │
├─────────────────────────────────────────────────────────────┤
│  Providers (Implement BaseProvider)                         │
│  ├── YourCustomProvider                                     │
│  └── ...                                                    │
├─────────────────────────────────────────────────────────────┤
│  Cache Layer                                                │
│  ├── MemoryCache (Development)                              │
│  └── RedisCache (Production)                                │
└─────────────────────────────────────────────────────────────┘
```

## ✅ OMSS Compliance

This implementation follows the [OMSS Standard](https://github.com/omss-spec/omss-spec):

- ✅ **Standardized Response Format**: All responses follow OMSS schema
- ✅ **TMDB Validation**: All requests validated against TMDB
- ✅ **Proxy Support**: Required for all streaming URLs
- ✅ **Error Handling**: OMSS-compliant error responses
- ✅ **Source Identification**: Unique IDs for all sources
- ✅ **Audio Track Support**: Multiple audio tracks per source
- ✅ **Subtitle Support**: VTT/SRT subtitle formats
- ✅ **Quality Indicators**: Resolution-based quality tags
- ✅ **Provider Attribution**: Source provider identification
- ✅ **Diagnostics**: Detailed error/warning information

## 📚 Additional Resources

- [OMSS standard](https://github.com/omss-spec/omss-spec)
- [Basic Server Example](./examples/basic-server.ts)
- [Provider Example](./examples/example-provider.ts)
- [TMDB API Documentation](https://developers.themoviedb.org/3)

## 🤝 Contributing

Contributions are welcome! Please read [our contributing guidelines](https://github.com/omss-spec/omss-spec/blob/main/CONTRIBUTING.md) before submitting PRs.

</details>

## 📄 License

MIT License - see [LICENSE](./LICENSE) file for details.

## 🙏 Acknowledgments

- All maintainers
- OMSS standard contributors
