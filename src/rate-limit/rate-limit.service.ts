import {
  Inject,
  Injectable,
  Logger,
  Optional,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const RATE_LIMIT_REDIS = Symbol('RATE_LIMIT_REDIS');

// only what the counter needs, so a test can supply one without opening a
// socket the service would then keep alive
export interface RateLimitCounter {
  multi(): {
    incr(key: string): {
      pexpire(
        key: string,
        ms: number,
      ): { exec(): Promise<[Error | null, unknown][] | null> };
    };
  };
  disconnect(): void;
}

const DEFAULT_LIMIT = 60;
const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  degraded: boolean;
}

@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly logger = new Logger(RateLimitService.name);
  private readonly redis: RateLimitCounter;
  private readonly defaultLimit: number;
  private readonly windowMs: number;
  private readonly failOpen: boolean;

  constructor(
    config: ConfigService,
    @Optional() @Inject(RATE_LIMIT_REDIS) counter?: RateLimitCounter,
  ) {
    if (counter) {
      this.redis = counter;
    } else {
      const client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      client.on('error', (error: Error & { code?: string }) => {
        this.logger.warn(
          `redis unavailable: ${error.code ?? ''} ${error.message}`.trim(),
        );
      });
      this.redis = client;
    }

    this.defaultLimit = numberFrom(config, 'RATE_LIMIT_DEFAULT', DEFAULT_LIMIT);
    this.windowMs = numberFrom(
      config,
      'RATE_LIMIT_WINDOW_MS',
      DEFAULT_WINDOW_MS,
    );
    // refusing every request because the component that counts them is down
    // turns a degraded dependency into a total outage, and the gateway exists
    // to serve, so the default lets traffic through and says so loudly
    this.failOpen = config.get<string>('RATE_LIMIT_FAIL_OPEN') !== 'false';
  }

  /**
   * Counts one request against a key and says whether it may proceed.
   *
   * The window is fixed rather than sliding: two bursts either side of a
   * boundary can reach twice the limit in a short span. A sliding log would
   * remove that at the cost of storing a timestamp per request, which is the
   * wrong trade on a hot path whose job is to be cheap.
   */
  async consume(
    apiKeyId: string,
    keyLimit: number | null | undefined,
  ): Promise<RateLimitDecision> {
    const limit = keyLimit ?? this.defaultLimit;
    const now = Date.now();
    const windowStart = now - (now % this.windowMs);
    const resetAt = windowStart + this.windowMs;

    try {
      const key = `ratelimit:${apiKeyId}:${windowStart}`;
      const results = await this.redis
        .multi()
        .incr(key)
        .pexpire(key, this.windowMs)
        .exec();

      const used = firstNumber(results);
      if (used === undefined) {
        return this.degrade(limit, resetAt, 'redis returned no counter');
      }

      return {
        allowed: used <= limit,
        limit,
        remaining: Math.max(0, limit - used),
        resetAt,
        degraded: false,
      };
    } catch (error) {
      return this.degrade(
        limit,
        resetAt,
        error instanceof Error ? error.message : 'unknown redis error',
      );
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private degrade(
    limit: number,
    resetAt: number,
    reason: string,
  ): RateLimitDecision {
    this.logger.error(
      `rate limiting ${this.failOpen ? 'bypassed' : 'refusing traffic'}: ${reason}`,
    );

    return {
      allowed: this.failOpen,
      limit,
      remaining: this.failOpen ? limit : 0,
      resetAt,
      degraded: true,
    };
  }
}

function firstNumber(
  results: [Error | null, unknown][] | null,
): number | undefined {
  const value = results?.[0]?.[1];
  return typeof value === 'number' ? value : undefined;
}

function numberFrom(
  config: ConfigService,
  key: string,
  fallback: number,
): number {
  const raw = config.get<string>(key);
  const parsed = Number(raw);
  return raw !== undefined && Number.isFinite(parsed) ? parsed : fallback;
}
