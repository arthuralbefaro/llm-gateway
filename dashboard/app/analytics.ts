import 'server-only';

const GATEWAY = process.env.GATEWAY_URL ?? 'http://localhost:3000';
const TOKEN = process.env.ANALYTICS_TOKEN;

export interface HitRateRow {
  bucket: string;
  requests: number;
  hits: number;
  exact_hits: number;
  semantic_hits: number;
  hit_rate: number;
  exact_rate: number;
  semantic_rate: number;
}

export interface CostRow {
  bucket: string;
  provider: string;
  model: string;
  requests: number;
  cost_confirmed: number;
  cost_estimated: number;
  cost_cumulative: number;
}

export interface LatencyRow {
  provider: string;
  cache_hit: boolean;
  requests: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface FailureRow {
  provider: string;
  attempts: number;
  failures: number;
  circuit_open: number;
  failure_rate: number;
}

export interface BreakerRow {
  provider: string;
  state: string;
  failures: number;
  successes: number;
  openedAt: string | null;
}

export interface Fetched<T> {
  rows: T[];
  error?: string;
}

/**
 * reads one analytics endpoint
 *
 * runs on the server only: the analytics token authorises reading every
 * caller's aggregate traffic, so it must never reach a browser.
 * the dashboard is a reader of the api, not a second holder of its credentials
 */
async function read<T>(path: string, query = ''): Promise<Fetched<T>> {
  if (!TOKEN) {
    return { rows: [], error: 'ANALYTICS_TOKEN is not set for the dashboard' };
  }

  try {
    const res = await fetch(`${GATEWAY}/v1/analytics/${path}${query}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      cache: 'no-store',
    });

    if (!res.ok) {
      return { rows: [], error: `gateway answered ${res.status}` };
    }

    const body = (await res.json()) as { rows?: T[] };
    return { rows: body.rows ?? [] };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : 'gateway unreachable',
    };
  }
}

export function hitRate(bucket: string): Promise<Fetched<HitRateRow>> {
  return read<HitRateRow>('cache-hit-rate', `?bucket=${bucket}`);
}

export function cost(bucket: string): Promise<Fetched<CostRow>> {
  return read<CostRow>('cost', `?bucket=${bucket}`);
}

export function latency(): Promise<Fetched<LatencyRow>> {
  return read<LatencyRow>('latency');
}

export function failures(): Promise<Fetched<FailureRow>> {
  return read<FailureRow>('provider-failures');
}

/**
 * Breaker state comes from the health endpoint rather than analytics, because
 * it is a fact about now and not about a window of history.
 */
export async function breakers(): Promise<Fetched<BreakerRow>> {
  try {
    const res = await fetch(`${GATEWAY}/health`, { cache: 'no-store' });
    if (!res.ok) {
      return { rows: [], error: `gateway answered ${res.status}` };
    }
    const body = (await res.json()) as { providers?: BreakerRow[] };
    return { rows: body.providers ?? [] };
  } catch (error) {
    return {
      rows: [],
      error: error instanceof Error ? error.message : 'gateway unreachable',
    };
  }
}
