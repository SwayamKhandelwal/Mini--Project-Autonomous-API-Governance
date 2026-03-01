# Project 42 — Autonomous API & Microservice Governance System

An autonomous system that continuously maps, secures, and optimizes backend microservice architectures using graph mining, ML, and LLM reasoning.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    API Gateway (Express)                  │
│              http://localhost:3000                        │
└────────────────────────┬────────────────────────────────┘
                         │ Kafka Topics
         ┌───────────────┼───────────────────┐
         ▼               ▼                   ▼
  ┌─────────────┐ ┌─────────────┐   ┌───────────────┐
  │  Discovery  │ │  Dependency │   │   Security    │
  │   Agent     │ │    Agent    │   │    Agent      │
  └─────────────┘ └─────────────┘   └───────────────┘
         │               │                   │
         ▼               ▼                   ▼
  ┌─────────────┐ ┌─────────────────────────────────┐
  │ Performance │ │        Refactoring Agent         │
  │   Agent     │ │         (GPT-4o-mini LLM)        │
  └─────────────┘ └─────────────────────────────────┘
         │
         ▼
  ┌─────────────────────────────────────────────────┐
  │           Neo4j Graph Database                   │
  │     (Services, APIs, Dependencies, Alerts)       │
  └─────────────────────────────────────────────────┘
```

## Quick Start

### 1. Clone and install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Fill in your values (Neo4j password, OpenAI API key, etc.)
```

### 3. Start infrastructure + all agents
```bash
docker-compose up -d
```

### 4. Run locally without Docker (requires Kafka + Neo4j running)
```bash
# Start all services at once
npm run start:all

# Or individually:
npm run start          # Gateway
npm run agent:discovery
npm run agent:dependency
npm run agent:security
npm run agent:performance
npm run agent:refactoring
```

## API Endpoints

### Discovery
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/discovery/apis | List all discovered APIs |
| POST | /api/discovery/register | Register a service for scanning |

### Dependency
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/dependency/graph | Full service dependency graph |
| GET | /api/dependency/orphans | Services with no connections |
| GET | /api/dependency/circular | Circular dependency detection |

### Security
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/security/alerts | All security alerts |
| GET | /api/security/summary | Alerts grouped by severity |
| PATCH | /api/security/alerts/:id/resolve | Resolve an alert |

### Performance
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/performance/bottlenecks | High latency / error endpoints |
| GET | /api/performance/unused | Unused APIs (30+ days) |

### Refactoring
| Method | Path | Description |
|--------|------|-------------|
| GET | /api/refactoring/suggestions | LLM-generated suggestions |
| PATCH | /api/refactoring/suggestions/:id/status | Accept or dismiss |

### System
| Method | Path | Description |
|--------|------|-------------|
| GET | /health | System health check |
| GET | /metrics | Prometheus metrics |

## Registering a Service

```bash
curl -X POST http://localhost:3000/api/discovery/register \
  -H "Content-Type: application/json" \
  -d '{
    "serviceName": "user-service",
    "baseUrl": "http://your-service:8080",
    "environment": "production"
  }'
```

The Discovery Agent will automatically fetch its OpenAPI spec, map dependencies, run security analysis, and the Refactoring Agent will generate improvement suggestions.

## Reporting Metrics (from your services)

```bash
curl -X POST http://localhost:9092 ... 
# Or publish directly to Kafka GOVERNANCE_COMMAND topic:
{
  "command": "INGEST_METRIC",
  "payload": {
    "serviceName": "user-service",
    "path": "/api/users",
    "method": "GET",
    "latencyMs": 145,
    "statusCode": 200
  }
}
```

## Dashboards

- **Grafana**: http://localhost:3001 (admin/admin)
- **Neo4j Browser**: http://localhost:7474
- **Prometheus**: http://localhost:9090

## Project Structure

```
project42/
├── gateway/                 # API Gateway (Express)
│   ├── index.js
│   └── routes/
│       ├── discovery.js
│       ├── dependency.js
│       ├── security.js
│       ├── performance.js
│       ├── refactoring.js
│       └── health.js
├── agents/
│   ├── discovery/           # API Discovery Agent
│   ├── dependency/          # Dependency Mapping Agent
│   ├── security/            # Security Analysis Agent
│   ├── performance/         # Performance Agent
│   └── refactoring/         # LLM Refactoring Agent
├── shared/
│   ├── kafka/               # Kafka producer/consumer factory
│   ├── neo4j/               # Neo4j driver + schema init
│   └── logger/              # Winston logger
├── docker-compose.yml
├── Dockerfile
├── prometheus.yml
└── package.json
```

## Next Phase: React Dashboard (Phase 7)
The dashboard will visualize the dependency graph, security alerts, performance metrics, and refactoring suggestions in real-time.
