# llm-gateway

[![ci](https://github.com/arthuralbefaro/llm-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/arthuralbefaro/llm-gateway/actions/workflows/ci.yml)

A gateway that puts one API in front of multiple LLM providers and answers from
a cache when it already knows the answer. It routes with retry, fallback and a
circuit breaker, caches exactly by default, and serves semantically similar
answers only when the caller opts in — because measurement showed that
similarity does not imply the same answer.

Every performance claim in this file was measured, and each one carries the
condition it was measured under. The traffic behind every number is synthetic.

## Architecture

```
                      ┌────────────────────────────────────────────────┐
                      │ gateway (NestJS)                               │
 client ──► auth ──► rate limit ──► cache read ──► router ──► provider │
                      │                │              │        adapters │
                      │                │              ├─ retry + jitter │
                      │                │              ├─ fallback map   │
                      │                │              └─ circuit breaker│
                      │                ▼                                │
                      │   exact: Redis (hash lookup)                    │
                      │   semantic: Postgres + pgvector (HNSW),         │
                      │             opt-in per request                  │
                      │                                                 │
                      │   embedding: multilingual-e5-small (q8 ONNX)    │
                      │              on one worker thread               │
                      └───────┬──────────────┬──────────────┬──────────┘
                              ▼              ▼              ▼
                        OpenTelemetry    Prometheus     Postgres
                          (Jaeger)       (Grafana)   (request history,
                                                      analytics API,
                                                      Next.js dashboard)
```

Cache writes always happen; reads are what the request controls. `cache: false`
skips reading, omitting it reads exact only, `cache: "semantic"` adds the
vector search. `docs/api.md` has the full contract.

## The central finding

**Embedding similarity measures how close two prompts are in subject matter,
not whether they have the same answer.**

The cache was measured against 220 labelled pairs in English and Portuguese
(`evals/`). Pairs that must not match — a question and its negation, an entity
swap, a shifted time scope — score *higher* than honest paraphrases: the
median minimal pair sits at 0.9515 against 0.9441 for paraphrases. Peak
precision over every possible threshold is 0.477.

The number that dismantles the obvious fix — be stricter — is precision by
similarity band, inside the acceptance region:

| Similarity band | Hits | Right | Wrong | Precision |
|---|---|---|---|---|
| 0.95–0.96 | 5 | 4 | 1 | 0.800 |
| 0.96–0.97 | 11 | 6 | 5 | 0.545 |
| 0.97–0.98 | 14 | 5 | 9 | 0.357 |
| 0.98–1.00 | 6 | 1 | 5 | **0.167** |

**Precision falls as similarity rises.** A nearly identical prompt with a
different answer is exactly what the model cannot see, so the most confident
region of the metric is its least correct. No threshold fixes an inverted
ordering — which is why semantic lookup became opt-in per request, declared
with its similarity in the response (ADR 0008, ADR 0010).

The dataset is adversarial and written by the project author; it bounds what
the semantic tier can miss, not how often real traffic triggers it.

## Measured results

Everything below comes from one laptop — AMD Ryzen 5 7520U, 4 physical cores,
15.3 GB RAM — running the gateway compiled, with k6, Postgres, Redis and the
observability stack competing for the same cores, against a local provider
simulating 120 ms. Absolute numbers are a floor for this setup, not a capacity
claim. Full conditions and voided runs are in `docs/load/`.

| What | Number | Condition |
|---|---|---|
| Gateway overhead (auth, rate limit, routing, retry, breaker, metrics) | ~7 ms, flat | no-embedding path against the 120 ms provider |
| Throughput ceiling | 61.6 req/s, 0 drops, p99 174 ms | ramp to 120 req/s, embedding on every store, one worker |
| Same ramp before the worker thread | 44.7 req/s, p99 7.28 s | embedding on the main thread, the reason ADR 0006 exists |
| Cache effect on the median | 132 ms → 5.2 ms | 20 req/s, 86% measured hit rate |
| Cache effect on the tail | p99 152 ms → 163 ms — **it does not move** | same run: the 14% misses still pay full provider cost, and they are what p99 measures |
| Semantic hit tail | p99 459 ms vs 493 ms for a miss (93%) | week 4 metrics; why hit rates are never reported aggregated |
| Provider dies mid-run | 0% failed over 1125 requests, p99 437 ms | 35 s injected outage, breaker suppressed ~450 doomed calls; the p99 is the visible price of resilience |
| Redis dies mid-run | 0% failed, hit rate 88%, cached median 5.9 → 17.8 ms | semantic tier served from Postgres alone, after fixing a write-back that discarded found hits |
| Default read path after opt-in | miss median −40 ms (~20%), p95 −190 to −430 ms | same build, same day, old default reproduced as `cache:"semantic"`, alternating rounds |

The last row is a side effect worth naming: the correctness fix also made the
default path faster, because a default miss stopped offering two embeddings per
request to a single worker with one of them awaited on the request path.

A hit rate never appears in this project without the latency effect beside it,
split by median and tail. That rule exists because the tail number above would
otherwise be hidden by the median one.

## Setup

Prerequisites: Docker Desktop (compose v2). Node 24 with pnpm 11 only for
running outside Docker; Python 3.12 with [uv](https://docs.astral.sh/uv/) only
for the evaluation suite.

```powershell
git clone https://github.com/arthuralbefaro/llm-gateway.git
cd llm-gateway
docker compose up -d --build
```

The first build downloads the embedding model (about 130 MB) into the image, so
the gateway boots warm instead of downloading on first request. A first build
pulls hundreds of packages, and a transient registry or layer error can fail
it; run the same command again and Docker resumes from cache.

Migrations and the seed run in the one-shot `migrate` service. The development
API key is printed once in its logs:

```powershell
docker compose logs migrate
```

Copy the `llmg_...` value. Only its hash is stored; if you lose it:

```powershell
docker compose run --rm migrate node seed-dist/prisma/seed.js --rotate
```

Smoke test — `local-small` is served by the built-in simulated provider, so no
provider API key is needed:

```powershell
$key = "llmg_..."
Invoke-RestMethod -Method Post -Uri http://localhost:3000/v1/chat/completions `
  -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' `
  -Body '{"model":"local-small","messages":[{"role":"user","content":"hello"}]}'
```

For the analytics API and the dashboard, create `.env` from `.env.example`, set
any non-empty `ANALYTICS_TOKEN`, and `docker compose up -d gateway dashboard`.
Without it the gateway still serves completions; analytics answers 401 and the
dashboard says the token is missing.

### Ports

| Port | Service | Why not the default |
|---|---|---|
| 3000 | gateway | |
| 3001 | Grafana | 3000 is taken by the gateway |
| 3002 | dashboard | |
| 5433 | Postgres | a local Postgres often already holds 5432, and a gateway silently talking to the wrong database is a failure nothing reports |
| 6380 | Redis | same reasoning for a local Redis on 6379 |
| 9090 | Prometheus | |
| 16686 | Jaeger UI | |

### Outside Docker

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

The first request after a cold start downloads the model into `.models` and
loads it, which takes tens of seconds once; the boot log prints the per-worker
load time.

### Checks

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

## Documents

`docs/api.md` — the API: request contract, the `cache` field with its measured
precision, response fields, analytics endpoints.

`docs/evals/cache-quality.md` — the cache measurement end to end: methodology,
dataset and its biases, threshold sweep, partitioning decision, cache value
analysis, and what could not be concluded.

Decisions, each with the numbers that forced it:

| ADR | One line |
|---|---|
| [0001](docs/adr/0001-cross-lingual-alignment-blocks-threshold-separation.md) | A multilingual encoder puts translations close by design, so no threshold separates languages; 0.95 chosen on an 11-pair measurement. |
| [0002](docs/adr/0002-only-message-content-is-embedded.md) | A `user:` prefix on both sides moved a pair +0.0325 across the threshold; anything constant on both sides of a similarity inflates it. |
| [0003](docs/adr/0003-generated-migrations-try-to-drop-the-hnsw-index.md) | Every generated migration tries to drop the HNSW index; a static test replays migrations and fails loudly. |
| [0004](docs/adr/0004-execution-facts-are-reported-by-the-executor.md) | `fallback` computed by comparing models missed same-model provider switches; execution facts come from the executor. |
| [0005](docs/adr/0005-load-tests-must-declare-which-layer-they-measure.md) | Sequentially numbered prompts are semantic near-duplicates; every scenario declares a target hit rate and proves the measured one. |
| [0006](docs/adr/0006-embedding-runs-on-one-worker-thread.md) | One worker, because onnxruntime already parallelises one inference; four workers measured worse than no pool. |
| [0007](docs/adr/0007-the-same-onnx-file-is-not-the-same-model.md) | The same quantized ONNX file diverges across runtimes by five times the band under study; provenance travels with every number. |
| [0008](docs/adr/0008-embedding-similarity-is-not-answer-equivalence.md) | The inversion: pairs that must not match score above pairs that must; peak precision 0.477 at any threshold. |
| [0009](docs/adr/0009-the-cache-is-not-partitioned-by-language.md) | Language is perfectly recoverable from the embedding for 2.7 µs, and partitioning buys zero paraphrases back; not built, trigger recorded. |
| [0010](docs/adr/0010-semantic-lookup-is-opt-in-per-request.md) | The five options priced; the caller is the only party able to trade a provider call against a wrong answer. |

Load and observability reports, with environment and voided runs kept in the
record: `docs/load/baseline.md`, `docs/load/worker-pool.md`,
`docs/load/read-path-after-opt-in.md`, `docs/reports/week-4-observability.md`.

## Not covered

- **HNSW under pressure.** `CacheEntry` never exceeded a few hundred rows;
  nothing here says anything about the index at scale.
- **Postgres pool limits.** Never the constraint at the measured rates, so
  never characterised.
- **Multi-instance breaker.** Breaker state is in-memory and per-process; two
  gateway instances learn about a dead provider independently.
- **Real traffic.** Every request in every measurement was generated. The hit
  distribution, the frequency of near-miss prompts, and the value of the
  semantic tier in practice are all unknown — what is missing is not volume,
  it is origin.
- **Tail sampling, per-key analytics, dashboard depth** — listed with reasons
  in the week 4 report.
