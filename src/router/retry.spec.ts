import { ProviderError } from '../providers/provider.types';
import { RetryPolicy, computeDelayMs, withRetry } from './retry';

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 10_000,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
};

function retryable(status = 503, retryAfterMs?: number): ProviderError {
  return new ProviderError(
    'upstream failed',
    'stub',
    status,
    true,
    retryAfterMs,
  );
}

function fatal(status = 400): ProviderError {
  return new ProviderError('bad request', 'stub', status, false);
}

describe('computeDelayMs', () => {
  it('grows the ceiling exponentially', () => {
    const atCeiling = () => 1;
    expect(computeDelayMs(1, POLICY, undefined, atCeiling)).toBe(200);
    expect(computeDelayMs(2, POLICY, undefined, atCeiling)).toBe(400);
    expect(computeDelayMs(3, POLICY, undefined, atCeiling)).toBe(800);
  });

  it('caps the ceiling at maxDelayMs', () => {
    expect(computeDelayMs(10, POLICY, undefined, () => 1)).toBe(
      POLICY.maxDelayMs,
    );
  });

  it('spreads the delay across the whole window rather than sitting on it', () => {
    // full jitter, so the same attempt yields different delays per caller
    expect(computeDelayMs(3, POLICY, undefined, () => 0)).toBe(0);
    expect(computeDelayMs(3, POLICY, undefined, () => 0.5)).toBe(400);
    expect(computeDelayMs(3, POLICY, undefined, () => 1)).toBe(800);
  });

  it('lets Retry-After win over the computed backoff', () => {
    expect(computeDelayMs(1, POLICY, 1_500, () => 1)).toBe(1_500);
  });

  it('still caps Retry-After at maxDelayMs', () => {
    expect(computeDelayMs(1, POLICY, 60_000, () => 1)).toBe(POLICY.maxDelayMs);
  });
});

describe('withRetry', () => {
  const options = { policy: POLICY, random: () => 0 };

  it('returns the first successful result without retrying', async () => {
    const operation = jest.fn().mockResolvedValue('ok');

    await expect(withRetry(operation, options)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable failure and succeeds', async () => {
    const operation = jest
      .fn()
      .mockRejectedValueOnce(retryable())
      .mockResolvedValue('ok');

    await expect(withRetry(operation, options)).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non retryable failure', async () => {
    const operation = jest.fn().mockRejectedValue(fatal());

    await expect(withRetry(operation, options)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('does not retry an error that is not a ProviderError', async () => {
    const operation = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(withRetry(operation, options)).rejects.toThrow('boom');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('stops at maxAttempts', async () => {
    const operation = jest.fn().mockRejectedValue(retryable());

    await expect(withRetry(operation, options)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(operation).toHaveBeenCalledTimes(POLICY.maxAttempts);
  });

  it('gives up rather than sleeping past the elapsed budget', async () => {
    const operation = jest.fn().mockRejectedValue(retryable(503, 5_000));
    const clock = 0;

    await expect(
      withRetry(operation, {
        policy: { ...POLICY, maxElapsedMs: 1_000, maxDelayMs: 30_000 },
        random: () => 1,
        now: () => clock,
      }),
    ).rejects.toBeInstanceOf(ProviderError);

    expect(operation).toHaveBeenCalledTimes(1);
    expect(clock).toBe(0);
  });

  it('reports each retry with its delay', async () => {
    const seen: number[] = [];
    const operation = jest
      .fn()
      .mockRejectedValueOnce(retryable(503, 5))
      .mockRejectedValueOnce(retryable(503, 5))
      .mockResolvedValue('ok');

    await withRetry(operation, {
      ...options,
      onRetry: ({ attempt, delayMs }) => seen.push(attempt + delayMs),
    });

    expect(seen).toEqual([6, 7]);
  });

  it('stops retrying once the client aborts', async () => {
    const abort = new AbortController();
    const operation = jest.fn().mockImplementation(() => {
      abort.abort();
      return Promise.reject(retryable());
    });

    await expect(
      withRetry(operation, { ...options, signal: abort.signal }),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
