import { ProviderError } from '../providers/provider.types';

export interface RetryPolicy {
  maxAttempts: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface RetryAttempt {
  attempt: number;
  delayMs: number;
  error: ProviderError;
}

export interface RetryOptions {
  policy: RetryPolicy;
  signal?: AbortSignal;
  onRetry?: (attempt: RetryAttempt) => void;
  random?: () => number;
  now?: () => number;
}

/**
 * Computes how long to wait before the next attempt.
 *
 * Uses full jitter: the delay is drawn uniformly from zero up to the
 * exponential ceiling rather than sitting on it. Clients that failed together
 * would otherwise come back together and knock the provider over again at the
 * same instant. A Retry-After from the provider wins outright, since it knows
 * its own recovery better than any curve chosen here.
 */
export function computeDelayMs(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs: number | undefined,
  random: () => number,
): number {
  if (retryAfterMs !== undefined) {
    return Math.min(retryAfterMs, policy.maxDelayMs);
  }

  const ceiling = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * 2 ** (attempt - 1),
  );

  return Math.floor(random() * ceiling);
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const { policy, signal, onRetry } = options;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const startedAt = now();

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!(error instanceof ProviderError) || !error.retryable) {
        throw error;
      }
      if (attempt >= policy.maxAttempts) {
        throw error;
      }
      if (signal?.aborted) {
        throw error;
      }

      const delayMs = computeDelayMs(
        attempt,
        policy,
        error.retryAfterMs,
        random,
      );

      // the elapsed ceiling matters more than the attempt ceiling, sleeping
      // past it burns money on an answer whose client has already given up
      if (now() - startedAt + delayMs > policy.maxElapsedMs) {
        throw error;
      }

      onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs, signal);

      if (signal?.aborted) {
        throw error;
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
