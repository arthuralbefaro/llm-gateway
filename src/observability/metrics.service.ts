import { Injectable } from '@nestjs/common';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export type CacheResult = 'exact' | 'semantic' | 'miss' | 'bypassed';

/**
 * Prometheus metrics for the gateway.
 *
 * Every label here is bounded by something the gateway controls: a route table,
 * a pricing table, a fixed set of outcomes. Nothing is labelled by anything the
 * caller supplies, because a label value becomes a time series that outlives
 * the request that created it.
 *
 * Deliberately absent, and why:
 *
 * - **api key id**. It grows with every customer, and a series per key never
 *   expires. It is also the identifier for a person, and a label is retained
 *   and rendered far more widely than a database row. Per key analytics belong
 *   in the sql api, queried on demand rather than stored as a time series.
 * - **prompt, prompt hash, cache key**. Unbounded by definition, one series per
 *   distinct prompt, which is the whole point of the traffic.
 * - **error message**. Upstream text varies by request id, quota figures and
 *   timestamps, so it is unbounded in practice even though it looks like an
 *   enum.
 * - **similarity, cost, latency as labels**. Continuous values. They belong in
 *   the histogram buckets and counter sums they already occupy.
 * - **trace id**. One series per request.
 * - **requested model on every metric**. Bounded, but multiplying it against
 *   served model squares the series count on the cost metric for a question
 *   only the fallback counter actually asks.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly requests: Counter<'route' | 'status' | 'cache'>;
  private readonly duration: Histogram<'route' | 'cache'>;
  private readonly cacheLookups: Counter<'result'>;
  private readonly cost: Counter<'provider' | 'model' | 'estimated'>;
  private readonly tokens: Counter<'provider' | 'model' | 'kind'>;
  private readonly attempts: Counter<'provider' | 'status'>;
  private readonly breakerTransitions: Counter<'provider' | 'to'>;
  private readonly breakerState: Gauge<'provider'>;
  private readonly embeddingQueue: Gauge;
  private readonly embeddingRejected: Counter;
  private readonly cacheStoreSkipped: Counter<'reason'>;
  private readonly rateLimited: Counter;
  private readonly fallbacks: Counter<'from_model' | 'to_model'>;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.requests = new Counter({
      name: 'gateway_requests_total',
      help: 'requests served, by route, http status and cache outcome',
      labelNames: ['route', 'status', 'cache'],
      registers: [this.registry],
    });

    this.duration = new Histogram({
      name: 'gateway_request_duration_seconds',
      help: 'end to end request latency by route and cache outcome',
      labelNames: ['route', 'cache'],
      // a cache hit lands near five milliseconds and a provider call near two
      // hundred, so the buckets have to resolve both ends
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.cacheLookups = new Counter({
      name: 'gateway_cache_lookups_total',
      help: 'cache lookups by outcome, exact and semantic counted separately',
      labelNames: ['result'],
      registers: [this.registry],
    });

    this.cost = new Counter({
      name: 'gateway_cost_usd_total',
      help: 'accumulated cost, with estimated cost kept separable',
      labelNames: ['provider', 'model', 'estimated'],
      registers: [this.registry],
    });

    this.tokens = new Counter({
      name: 'gateway_tokens_total',
      help: 'tokens billed by provider, model and prompt or completion',
      labelNames: ['provider', 'model', 'kind'],
      registers: [this.registry],
    });

    this.attempts = new Counter({
      name: 'gateway_provider_attempts_total',
      help: 'provider attempts by outcome, including the ones that failed',
      labelNames: ['provider', 'status'],
      registers: [this.registry],
    });

    this.breakerTransitions = new Counter({
      name: 'gateway_breaker_transitions_total',
      help: 'circuit breaker state changes by provider',
      labelNames: ['provider', 'to'],
      registers: [this.registry],
    });

    this.breakerState = new Gauge({
      name: 'gateway_breaker_state',
      help: 'current breaker state, 0 closed, 1 half open, 2 open',
      labelNames: ['provider'],
      registers: [this.registry],
    });

    this.embeddingQueue = new Gauge({
      name: 'gateway_embedding_queue_size',
      help: 'tasks waiting for an embedding worker',
      registers: [this.registry],
    });

    this.embeddingRejected = new Counter({
      name: 'gateway_embedding_rejected_total',
      help: 'embeddings refused by a full queue or a dead worker',
      registers: [this.registry],
    });

    this.cacheStoreSkipped = new Counter({
      name: 'gateway_cache_stores_skipped_total',
      help: 'cache writes abandoned, by reason',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.rateLimited = new Counter({
      name: 'gateway_rate_limited_total',
      help: 'requests refused with 429',
      registers: [this.registry],
    });

    this.fallbacks = new Counter({
      name: 'gateway_fallbacks_total',
      help: 'requests answered by a substitute, by model pair',
      labelNames: ['from_model', 'to_model'],
      registers: [this.registry],
    });
  }

  recordRequest(
    route: string,
    status: number,
    cache: CacheResult,
    seconds: number,
  ): void {
    this.requests.inc({ route, status: String(status), cache });
    this.duration.observe({ route, cache }, seconds);
  }

  recordCacheLookup(result: CacheResult): void {
    this.cacheLookups.inc({ result });
  }

  recordUsage(
    provider: string,
    model: string,
    promptTokens: number,
    completionTokens: number,
    costUsd: number,
    estimated: boolean,
  ): void {
    const flag = estimated ? 'true' : 'false';
    this.cost.inc({ provider, model, estimated: flag }, costUsd);
    this.tokens.inc({ provider, model, kind: 'prompt' }, promptTokens);
    this.tokens.inc({ provider, model, kind: 'completion' }, completionTokens);
  }

  recordAttempt(provider: string, status: string): void {
    this.attempts.inc({ provider, status });
  }

  recordBreakerTransition(provider: string, to: string): void {
    this.breakerTransitions.inc({ provider, to });
    this.breakerState.set({ provider }, stateValue(to));
  }

  recordEmbeddingQueue(size: number): void {
    this.embeddingQueue.set(size);
  }

  recordEmbeddingRejected(): void {
    this.embeddingRejected.inc();
  }

  recordCacheStoreSkipped(reason: string): void {
    this.cacheStoreSkipped.inc({ reason });
  }

  recordRateLimited(): void {
    this.rateLimited.inc();
  }

  recordFallback(fromModel: string, toModel: string): void {
    this.fallbacks.inc({ from_model: fromModel, to_model: toModel });
  }

  scrape(): Promise<string> {
    return this.registry.metrics();
  }
}

function stateValue(state: string): number {
  if (state === 'open') {
    return 2;
  }
  return state === 'half-open' ? 1 : 0;
}
