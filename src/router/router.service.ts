import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '../providers/llm-provider.abstract';
import { LLM_PROVIDERS } from '../providers/providers.module';
import {
  ChatChunk,
  ChatRequest,
  ChatResult,
  ProviderError,
  TokenUsage,
} from '../providers/provider.types';
import { equivalentModels } from './model-equivalence';
import { RetryPolicy, withRetry } from './retry';

export type AttemptStatus = 'success' | 'error';

export interface AttemptRecord {
  attempt: number;
  provider: string;
  model: string;
  status: AttemptStatus;
  latencyMs: number;
  error?: string;
}

export interface RoutedChat {
  result: ChatResult;
  costUsd: number;
  latencyMs: number;
  attempts: AttemptRecord[];
  usedFallback: boolean;
}

export interface StreamOutcome {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  attempts: AttemptRecord[];
  usedFallback: boolean;
}

export interface ServedTarget {
  provider: string;
  model: string;
  // true whenever the first choice did not answer, whether the substitute was
  // another provider for the same model or another model entirely
  usedFallback: boolean;
}

export interface StreamHooks {
  // fires the moment a target is committed to, which is before any byte
  // reaches the client and long before usage is known
  onOpen?: (target: ServedTarget) => void;
  onFinish: (outcome: StreamOutcome) => void;
}

export interface RouteTarget {
  provider: LlmProvider;
  model: string;
}

const DEFAULTS: RetryPolicy = {
  maxAttempts: 3,
  maxElapsedMs: 10_000,
  baseDelayMs: 200,
  maxDelayMs: 4_000,
};

@Injectable()
export class RouterService {
  private readonly logger = new Logger(RouterService.name);
  private readonly policy: RetryPolicy;
  private readonly fallbackByDefault: boolean;

  constructor(
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
    config: ConfigService,
  ) {
    this.policy = {
      maxAttempts: numberFrom(
        config,
        'RETRY_MAX_ATTEMPTS',
        DEFAULTS.maxAttempts,
      ),
      maxElapsedMs: numberFrom(
        config,
        'RETRY_MAX_ELAPSED_MS',
        DEFAULTS.maxElapsedMs,
      ),
      baseDelayMs: numberFrom(
        config,
        'RETRY_BASE_DELAY_MS',
        DEFAULTS.baseDelayMs,
      ),
      maxDelayMs: numberFrom(config, 'RETRY_MAX_DELAY_MS', DEFAULTS.maxDelayMs),
    };
    this.fallbackByDefault =
      config.get<string>('FALLBACK_ENABLED_BY_DEFAULT') !== 'false';
  }

  resolve(model: string): LlmProvider {
    const provider = this.providers.find((candidate) =>
      candidate.supports(model),
    );
    if (!provider) {
      const registered = this.providers.map((p) => p.name).join(', ') || 'none';
      throw new BadRequestException(
        `no registered provider supports model "${model}" (registered providers: ${registered})`,
      );
    }
    return provider;
  }

  /**
   * Lists the provider and model pairs to try, best first.
   *
   * Every provider serving the requested model comes first, because answering
   * with the model the caller asked for is always preferable to substituting
   * one. Equivalent models follow only when fallback is allowed.
   */
  targets(req: ChatRequest, allowFallback: boolean): RouteTarget[] {
    const exact = this.providers
      .filter((provider) => provider.supports(req.model))
      .map((provider) => ({ provider, model: req.model }));

    if (exact.length === 0) {
      this.resolve(req.model);
    }
    if (!allowFallback) {
      return exact.slice(0, 1);
    }

    const substitutes = equivalentModels(req.model).flatMap((model) =>
      this.providers
        .filter((provider) => provider.supports(model))
        .map((provider) => ({ provider, model })),
    );

    return [...exact, ...substitutes];
  }

  /**
   * Prices a usage figure the caller assembled itself, for the case where the
   * provider never reported one.
   */
  estimateCostUsd(provider: string, model: string, usage: TokenUsage): number {
    const found = this.providers.find(
      (candidate) => candidate.name === provider,
    );
    return found ? found.estimateCostUsd(model, usage) : 0;
  }

  allowsFallback(requested: boolean | undefined): boolean {
    return requested ?? this.fallbackByDefault;
  }

  // latency is measured here because the router sees the whole request, an
  // adapter only sees its own call
  async chat(req: ChatRequest, allowFallback?: boolean): Promise<RoutedChat> {
    const targets = this.targets(req, this.allowsFallback(allowFallback));
    const attempts: AttemptRecord[] = [];
    const startedAt = Date.now();
    let lastError: unknown;

    for (const [index, target] of targets.entries()) {
      try {
        const result = await this.runWithRetry(target, req, attempts, () =>
          target.provider.chat({ ...req, model: target.model }),
        );

        return {
          result,
          costUsd: target.provider.estimateCostUsd(target.model, result.usage),
          latencyMs: Date.now() - startedAt,
          attempts,
          usedFallback: index > 0,
        };
      } catch (error) {
        lastError = error;
        if (req.signal?.aborted) {
          throw error;
        }
        this.logger.warn(
          `${target.provider.name} exhausted for ${target.model}, ${describe(error)}`,
        );
      }
    }

    throw asError(lastError, 'no route produced a result');
  }

  async *stream(
    req: ChatRequest,
    hooks: StreamHooks,
    allowFallback?: boolean,
  ): AsyncGenerator<ChatChunk> {
    const targets = this.targets(req, this.allowsFallback(allowFallback));
    const attempts: AttemptRecord[] = [];
    const startedAt = Date.now();
    let opened: OpenedStream | undefined;
    let served: RouteTarget | undefined;
    let servedIndex = 0;
    let lastError: unknown;

    for (const [index, target] of targets.entries()) {
      try {
        // retry and fallback both stop at the first chunk: once a delta has
        // been handed to the caller the answer is partially delivered, and
        // starting over would rewrite the text they are already reading
        opened = await this.runWithRetry(target, req, attempts, async () => {
          const iterator = target.provider
            .stream({ ...req, model: target.model })
            [Symbol.asyncIterator]();
          const first = await iterator.next();
          return { iterator, first };
        });
        served = target;
        servedIndex = index;
        break;
      } catch (error) {
        lastError = error;
        if (req.signal?.aborted) {
          throw error;
        }
        this.logger.warn(
          `${target.provider.name} exhausted for ${target.model}, ${describe(error)}`,
        );
      }
    }

    if (!opened || !served) {
      throw asError(lastError, 'no route produced a stream');
    }

    hooks.onOpen?.({
      provider: served.provider.name,
      model: served.model,
      usedFallback: servedIndex > 0,
    });

    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };
    let current = opened.first;

    while (!current.done) {
      const chunk = current.value;
      if (chunk.usage) {
        usage = chunk.usage;
      }
      yield chunk;
      current = await opened.iterator.next();
    }

    hooks.onFinish({
      provider: served.provider.name,
      model: served.model,
      usage,
      costUsd: served.provider.estimateCostUsd(served.model, usage),
      latencyMs: Date.now() - startedAt,
      attempts,
      usedFallback: servedIndex > 0,
    });
  }

  private runWithRetry<T>(
    target: RouteTarget,
    req: ChatRequest,
    attempts: AttemptRecord[],
    operation: () => Promise<T>,
  ): Promise<T> {
    return withRetry(
      async () => {
        const attemptStartedAt = Date.now();
        const record: AttemptRecord = {
          attempt: attempts.length + 1,
          provider: target.provider.name,
          model: target.model,
          status: 'error',
          latencyMs: 0,
        };
        attempts.push(record);

        try {
          const value = await operation();
          record.status = 'success';
          return value;
        } catch (error) {
          record.error = describe(error);
          throw error;
        } finally {
          record.latencyMs = Date.now() - attemptStartedAt;
        }
      },
      {
        policy: this.policy,
        signal: req.signal,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `${target.provider.name} attempt ${attempt} failed with ${error.status ?? 'no status'}, retrying in ${delayMs} ms`,
          );
        },
      },
    );
  }
}

interface OpenedStream {
  iterator: AsyncIterator<ChatChunk>;
  first: IteratorResult<ChatChunk>;
}

// every target failed, so the caller gets the last upstream error rather than
// a wrapper that hides which provider actually refused
function asError(error: unknown, fallbackMessage: string): Error {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

function describe(error: unknown): string {
  if (error instanceof ProviderError) {
    return `${error.status ?? 'no status'}: ${error.message}`;
  }
  return error instanceof Error ? error.message : 'unknown error';
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
