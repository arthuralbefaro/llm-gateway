# llm-gateway

An LLM gateway with a measured semantic cache. One endpoint routes chat
completions across providers with retry, fallback and a circuit breaker, caches
answers exactly and — only when a caller opts in — by embedding similarity,
because the measurement showed similarity does not imply the same answer.

This README is being rebuilt. Architecture, measured results and the full
document index land with the week 6 closing. `docs/api.md` describes the API,
`docs/adr/` the decisions, `docs/evals/cache-quality.md` the cache measurement.

## Prerequisites

- Docker Desktop (compose v2)
- Node 24 and pnpm 11 only if you want to run the gateway outside Docker
- Python 3.12 with [uv](https://docs.astral.sh/uv/) only for the evaluation
  suite in `evals/`

## Setup

```powershell
git clone <repo-url> llm-gateway
cd llm-gateway
docker compose up -d --build
```

The first build downloads the embedding model (about 130 MB) into the image, so
the gateway boots warm instead of downloading on first request.

A first build pulls hundreds of packages, and a transient registry or layer
error can fail it. Run the same command again: Docker resumes from cache and
only the failed step repeats.

Migrations and the seed run automatically in the one-shot `migrate` service.
The development API key is printed once in its logs:

```powershell
docker compose logs migrate
```

Copy the `llmg_...` value. Only its hash is stored; if you lose it:

```powershell
docker compose run --rm migrate node seed-dist/prisma/seed.js --rotate
```

Smoke test:

```powershell
$key = "llmg_..."
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/chat/completions `
  -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' `
  -Body '{"model":"local-small","messages":[{"role":"user","content":"hello"}]}'
```

A `local-small` request is served by the built-in simulated provider, so no
provider API key is needed to see the system work.

### Analytics and dashboard

The analytics API and the dashboard need a shared token. Create `.env` from the
example and set any non-empty value:

```powershell
Copy-Item .env.example .env
# edit ANALYTICS_TOKEN in .env, then
docker compose up -d gateway dashboard
```

Without it the gateway still serves completions; the analytics endpoints return
401 and the dashboard says the token is missing.

## Ports

| Port | Service | Why not the default |
|---|---|---|
| 3000 | gateway | |
| 3001 | Grafana | 3000 is taken by the gateway |
| 3002 | dashboard | |
| 5433 | Postgres | a local Postgres often already holds 5432, and a gateway silently talking to the wrong database is a failure nothing reports |
| 6380 | Redis | same reasoning for a local Redis on 6379 |
| 9090 | Prometheus | |
| 16686 | Jaeger UI | |

## Development outside Docker

```powershell
Copy-Item .env.example .env
docker compose up -d postgres redis jaeger prometheus grafana
pnpm install
pnpm prisma generate
pnpm db:migrate
npx ts-node prisma/seed.ts
pnpm build
pnpm start:prod
```

The first request after a cold start downloads the model into `.models` (about
130 MB) and loads it, which takes tens of seconds once; the boot log prints the
per-worker load time.

## Checks

From a clean clone, the generated Prisma client has to exist before anything
compiles:

```powershell
pnpm install
pnpm prisma generate
pnpm lint
pnpm build
pnpm test
cd evals; uv run ruff check .; uv run pytest -q; cd ..
```

The tests need no database, no Redis and no model download: infrastructure is
stubbed and the embedding specs inject a test worker.
