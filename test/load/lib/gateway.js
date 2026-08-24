import http from 'k6/http';
import { Counter, Rate, Trend } from 'k6/metrics';

export const cacheHits = new Rate('gateway_cache_hit');
export const providerLatency = new Trend('gateway_provider_latency', true);
export const cachedLatency = new Trend('gateway_cached_latency', true);
export const rateLimited = new Counter('gateway_rate_limited');
export const servedBy = new Counter('gateway_served_by_fallback');
export const upstreamErrors = new Counter('gateway_upstream_errors');

const BASE = __ENV.GATEWAY_URL || 'http://localhost:3000';
const KEY = __ENV.GATEWAY_KEY;

export function completion(prompt, options = {}) {
  const body = {
    model: options.model || 'local-small',
    messages: [{ role: 'user', content: prompt }],
  };
  if (options.bypassCache) {
    body.cache = false;
  }
  if (options.fallback !== undefined) {
    body.fallback = options.fallback;
  }
  // above zero the cache is skipped entirely, read and write, which is the only
  // way to run traffic that pays no embedding cost at all
  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const res = http.post(`${BASE}/v1/chat/completions`, JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${KEY}`,
    },
    tags: { scenario: options.scenario || 'default' },
  });

  if (res.status === 429) {
    rateLimited.add(1);
    return res;
  }
  if (res.status !== 201 && res.status !== 200) {
    upstreamErrors.add(1);
    return res;
  }

  // the hit rate comes from the gateway's own accounting rather than from what
  // the scenario assumed about its prompts, see docs/adr/0005
  const payload = res.json();
  const hit = payload.cache_hit === true;
  cacheHits.add(hit);
  if (hit) {
    cachedLatency.add(res.timings.duration);
  } else {
    providerLatency.add(res.timings.duration);
  }
  if (payload.fallback === true) {
    servedBy.add(1);
  }

  return res;
}

export function health() {
  return http.get(`${BASE}/health`, { tags: { scenario: 'health' } });
}

export function seededRandom(seed) {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
