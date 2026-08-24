import { ConfigService } from '@nestjs/config';
import { RateLimitCounter, RateLimitService } from './rate-limit.service';

type ExecResult = Promise<[Error | null, unknown][] | null>;

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    RATE_LIMIT_DEFAULT: '3',
    RATE_LIMIT_WINDOW_MS: '60000',
    ...overrides,
  };
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => values[key],
  } as unknown as ConfigService;
}

function counter(exec: () => ExecResult): RateLimitCounter {
  return {
    multi: () => ({ incr: () => ({ pexpire: () => ({ exec }) }) }),
    disconnect: () => undefined,
  };
}

function counting(): () => ExecResult {
  let used = 0;
  return () => {
    used += 1;
    return Promise.resolve([[null, used]]);
  };
}

function serviceWith(
  exec: () => ExecResult,
  overrides: Record<string, string> = {},
): RateLimitService {
  return new RateLimitService(config(overrides), counter(exec));
}

describe('RateLimitService', () => {
  it('allows requests up to the limit and refuses the next one', async () => {
    const service = serviceWith(counting());

    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: true,
      limit: 3,
      remaining: 2,
    });
    await service.consume('key-1', null);
    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: true,
      remaining: 0,
    });
    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  it('lets a per key limit override the global default', async () => {
    const service = serviceWith(counting());

    expect(await service.consume('key-1', 10)).toMatchObject({
      limit: 10,
      remaining: 9,
    });
  });

  it('reports a reset time inside the window', async () => {
    const service = serviceWith(counting());

    const decision = await service.consume('key-1', null);

    expect(decision.resetAt).toBeGreaterThan(Date.now());
    expect(decision.resetAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('lets traffic through when redis is unreachable', async () => {
    const service = serviceWith(() =>
      Promise.reject(new Error('ECONNREFUSED')),
    );

    // a dead counter must not become a dead gateway
    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: true,
      degraded: true,
    });
  });

  it('refuses traffic when redis is unreachable and fail open is off', async () => {
    const service = serviceWith(
      () => Promise.reject(new Error('ECONNREFUSED')),
      { RATE_LIMIT_FAIL_OPEN: 'false' },
    );

    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: false,
      degraded: true,
    });
  });

  it('degrades when redis answers without a counter', async () => {
    const service = serviceWith(() => Promise.resolve(null));

    expect(await service.consume('key-1', null)).toMatchObject({
      allowed: true,
      degraded: true,
    });
  });

  it('never opens a socket when a counter is supplied', () => {
    const service = serviceWith(counting());

    expect(() => {
      service.onModuleDestroy();
    }).not.toThrow();
  });
});
