import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { AnalyticsGuard } from './analytics.guard';
import { AnalyticsService } from './analytics.service';
import type { Window } from './analytics.service';

const DEFAULT_WINDOW_HOURS = 24;

const querySchema = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  bucket: z.enum(['minute', 'hour', 'day']).default('hour'),
});

type AnalyticsQuery = z.infer<typeof querySchema>;

@Controller('v1/analytics')
@UseGuards(AnalyticsGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('cost')
  async cost(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    return {
      window: describeWindow(window),
      bucket: query.bucket,
      rows: await this.analytics.cost(window, query.bucket),
      notes: {
        cost_estimated:
          'estimated cost comes from a stream that failed after emitting text, where the provider billed for output it never reported and the tokens were counted from the characters sent. sum it separately from confirmed cost.',
      },
    };
  }

  @Get('cache-hit-rate')
  async hitRate(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    return {
      window: describeWindow(window),
      bucket: query.bucket,
      rows: await this.analytics.hitRate(window, query.bucket),
      notes: {
        why_split:
          'exact and semantic are reported apart because they are not the same product. an exact hit returns in single milliseconds, a semantic hit runs a vector search whose tail sits close to a provider call, so a combined rate reads as "this share was fast" and is false when the semantic share is large.',
        rows_before_the_column:
          'requests recorded before cacheKind existed count in hits but in neither part, so the two can sum to less than the whole for older windows.',
      },
    };
  }

  @Get('latency')
  async latency(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    return {
      window: describeWindow(window),
      rows: await this.analytics.latency(window),
      notes: {
        never_aggregate:
          'rows are split by cache outcome on purpose. a percentile taken across both describes no real population: cache hits and provider calls are two distributions two orders of magnitude apart, and merging them hides that a semantic hit tail sits close to a miss tail.',
      },
    };
  }

  @Get('provider-failures')
  async failures(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    return {
      window: describeWindow(window),
      rows: await this.analytics.failures(window),
      notes: {
        counted_over:
          'attempts, not requests, so a provider failing behind a working fallback is still visible. circuit_open counts refusals the breaker made without calling the provider.',
      },
    };
  }

  @Get('fallbacks')
  async fallbacks(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    return {
      window: describeWindow(window),
      rows: await this.analytics.fallbacks(window),
      notes: {
        requested_model:
          'derived from the first attempt, because targets serving the requested model are always tried before any substitute. a served_model of null means every attempt failed.',
      },
    };
  }

  @Get('savings')
  async savings(
    @Query(new ZodValidationPipe(querySchema)) query: AnalyticsQuery,
  ): Promise<Record<string, unknown>> {
    const window = toWindow(query);
    const rows = await this.analytics.savings(window);

    return {
      window: describeWindow(window),
      rows,
      total: {
        avoided_low: sum(rows.map((row) => row.avoided_low)),
        avoided_mid: sum(rows.map((row) => row.avoided_mid)),
        avoided_high: sum(rows.map((row) => row.avoided_high)),
      },
      // the method travels with the number, because a saving figure quoted
      // without its assumptions is read as a measurement
      methodology: {
        summary:
          'each cache hit is priced against what comparable misses of the same model actually cost in the same window, at the 25th, 50th and 75th percentile.',
        why_an_interval:
          'prompt length varies, so what a hit would have cost is a distribution rather than a number. the interval is the observed spread of real costs, not a confidence interval.',
        assumptions: [
          'every hit is assumed to have displaced a request that would otherwise have been made and paid for. this is an upper bound on demand: retries, polling and load tests inflate hit counts without representing calls anyone would have paid for.',
          'hits are priced from misses of the same model in the same window, so a window with few or no priced misses for a model yields nulls rather than a guess.',
          'the embedding computed to answer a hit is not subtracted. it is real cost the cache incurs, and it is not billed by a provider, so it does not appear in Request.',
        ],
        read_as:
          'an upper bound on money not spent, with the interval showing price variance only. it is not a forecast of what turning the cache off would cost.',
      },
    };
  }
}

function toWindow(query: AnalyticsQuery): Window {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(to.getTime() - DEFAULT_WINDOW_HOURS * 3600_000);
  return { from, to };
}

function describeWindow(window: Window): Record<string, string> {
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}

function sum(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);
  return present.length === 0
    ? null
    : present.reduce((total, value) => total + value, 0);
}
