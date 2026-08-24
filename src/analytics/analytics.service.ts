import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface Window {
  from: Date;
  to: Date;
}

export type Bucket = 'minute' | 'hour' | 'day';

export interface CostRow {
  bucket: Date;
  provider: string;
  model: string;
  requests: number;
  cost_confirmed: number;
  cost_estimated: number;
  cost_cumulative: number;
}

export interface HitRateRow {
  bucket: Date;
  requests: number;
  hits: number;
  hit_rate: number;
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

export interface FallbackRow {
  requested_model: string;
  served_model: string | null;
  served_provider: string | null;
  requests: number;
  attempts_avg: number;
}

export interface SavingsRow {
  model: string;
  hits: number;
  priced_requests: number;
  cost_p25: number | null;
  cost_median: number | null;
  cost_p75: number | null;
  avoided_low: number | null;
  avoided_mid: number | null;
  avoided_high: number | null;
}

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * cost per bucket by provider and model, with estimated cost kept apart from
   * confirmed cost and a running total per series
   */
  cost(window: Window, bucket: Bucket): Promise<CostRow[]> {
    return this.prisma.$queryRaw<CostRow[]>(Prisma.sql`
      WITH grouped AS (
        SELECT
          date_trunc(${bucket}, "createdAt")           AS bucket,
          "provider",
          "model",
          count(*)::int                                AS requests,
          sum("costUsd") FILTER (WHERE NOT "costEstimated")::float8 AS cost_confirmed,
          sum("costUsd") FILTER (WHERE "costEstimated")::float8     AS cost_estimated
        FROM "Request"
        WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
        GROUP BY 1, 2, 3
      )
      SELECT
        bucket,
        provider,
        model,
        requests,
        coalesce(cost_confirmed, 0) AS cost_confirmed,
        coalesce(cost_estimated, 0) AS cost_estimated,
        sum(coalesce(cost_confirmed, 0) + coalesce(cost_estimated, 0))
          OVER (PARTITION BY provider, model ORDER BY bucket)::float8 AS cost_cumulative
      FROM grouped
      ORDER BY bucket, provider, model
    `);
  }

  /**
   * cache hit rate per bucket
   *
   * exact and semantic cannot be separated here: Request records that a hit
   * happened, not which store answered, prometheus counts them apart because
   * the gateway knows at the time; the table would need a column to say so
   * afterwards
   */
  hitRate(window: Window, bucket: Bucket): Promise<HitRateRow[]> {
    return this.prisma.$queryRaw<HitRateRow[]>(Prisma.sql`
      SELECT
        date_trunc(${bucket}, "createdAt")                  AS bucket,
        count(*)::int                                       AS requests,
        count(*) FILTER (WHERE "cacheHit")::int             AS hits,
        (count(*) FILTER (WHERE "cacheHit"))::float8
          / nullif(count(*), 0)                             AS hit_rate
      FROM "Request"
      WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  /**
   * latency percentiles per provider, never merged across the cache outcome
   *
   * a single percentile over both is a number that describes no real
   * population: served-from-cache and served-from-provider are two
   * distributions two orders of magnitude apart, and averaging them hides that
   * a semantic hit's tail is close to a miss's
   */
  latency(window: Window): Promise<LatencyRow[]> {
    return this.prisma.$queryRaw<LatencyRow[]>(Prisma.sql`
      SELECT
        "provider",
        "cacheHit"                                                        AS cache_hit,
        count(*)::int                                                     AS requests,
        percentile_cont(0.5)  WITHIN GROUP (ORDER BY "latencyMs")::float8 AS p50,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs")::float8 AS p95,
        percentile_cont(0.99) WITHIN GROUP (ORDER BY "latencyMs")::float8 AS p99,
        max("latencyMs")::float8                                          AS max
      FROM "Request"
      WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
      GROUP BY 1, 2
      ORDER BY 1, 2
    `);
  }

  /**
   * failure rate per provider inside a window, over attempts rather than
   * requests, so a provider that failed behind a working fallback still counts
   */
  failures(window: Window): Promise<FailureRow[]> {
    return this.prisma.$queryRaw<FailureRow[]>(Prisma.sql`
      SELECT
        "provider",
        count(*)::int                                          AS attempts,
        count(*) FILTER (WHERE "status" = 'error')::int        AS failures,
        count(*) FILTER (WHERE "error" LIKE '%circuit open%')::int AS circuit_open,
        (count(*) FILTER (WHERE "status" = 'error'))::float8
          / nullif(count(*), 0)                                AS failure_rate
      FROM "RequestAttempt"
      WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
      GROUP BY 1
      ORDER BY failure_rate DESC, 1
    `);
  }

  /**
   * which model was asked for against which one answered
   *
   * the requested model is not stored on Request, but the attempt list is
   * ordered, and targets serving the requested model are always tried first, so
   * the first attempt's model is what the caller asked for
   */
  fallbacks(window: Window): Promise<FallbackRow[]> {
    return this.prisma.$queryRaw<FallbackRow[]>(Prisma.sql`
      WITH per_request AS (
        SELECT
          "requestId",
          (array_agg("model" ORDER BY "attempt"))[1] AS requested_model,
          (array_agg("model" ORDER BY "attempt")
            FILTER (WHERE "status" = 'success'))[1]  AS served_model,
          (array_agg("provider" ORDER BY "attempt")
            FILTER (WHERE "status" = 'success'))[1]  AS served_provider,
          count(*)::int                              AS attempts
        FROM "RequestAttempt"
        WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
        GROUP BY "requestId"
      )
      SELECT
        requested_model,
        served_model,
        served_provider,
        count(*)::int        AS requests,
        avg(attempts)::float8 AS attempts_avg
      FROM per_request
      GROUP BY 1, 2, 3
      ORDER BY requests DESC, 1
    `);
  }

  /**
   * cost the cache avoided, as an interval rather than a single figure.
   *
   * each hit is priced against what comparable misses of the same model
   * actually cost in the same window, at the first, second and third quartile.
   * the spread is real: prompt length varies, so what a hit would have cost is
   * a distribution and not a number.
   */
  savings(window: Window): Promise<SavingsRow[]> {
    return this.prisma.$queryRaw<SavingsRow[]>(Prisma.sql`
      WITH priced AS (
        SELECT
          "model",
          count(*)::int                                                   AS priced_requests,
          percentile_cont(0.25) WITHIN GROUP (ORDER BY "costUsd")::float8 AS cost_p25,
          percentile_cont(0.5)  WITHIN GROUP (ORDER BY "costUsd")::float8 AS cost_median,
          percentile_cont(0.75) WITHIN GROUP (ORDER BY "costUsd")::float8 AS cost_p75
        FROM "Request"
        WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
          AND NOT "cacheHit"
          AND "status" = 'success'
          AND "costUsd" > 0
        GROUP BY 1
      ),
      hits AS (
        SELECT "model", count(*)::int AS hits
        FROM "Request"
        WHERE "createdAt" >= ${window.from} AND "createdAt" < ${window.to}
          AND "cacheHit"
        GROUP BY 1
      )
      SELECT
        h."model"                                    AS model,
        h.hits                                       AS hits,
        coalesce(p.priced_requests, 0)               AS priced_requests,
        p.cost_p25,
        p.cost_median,
        p.cost_p75,
        (h.hits * p.cost_p25)::float8                AS avoided_low,
        (h.hits * p.cost_median)::float8             AS avoided_mid,
        (h.hits * p.cost_p75)::float8                AS avoided_high
      FROM hits h
      LEFT JOIN priced p ON p."model" = h."model"
      ORDER BY h.hits DESC
    `);
  }
}
