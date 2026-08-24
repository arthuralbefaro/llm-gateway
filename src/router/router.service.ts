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
  TokenUsage,
} from '../providers/provider.types';
import { RetryPolicy, withRetry } from './retry';

export interface RoutedChat {
  result: ChatResult;
  costUsd: number;
  latencyMs: number;
  attempts: number;
}

export interface StreamOutcome {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  attempts: number;
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

  // latency is measured here because the router sees the whole request, an
  // adapter only sees its own call
  async chat(req: ChatRequest): Promise<RoutedChat> {
    const provider = this.resolve(req.model);
    const startedAt = Date.now();
    let attempts = 0;

    const result = await withRetry(
      (attempt) => {
        attempts = attempt;
        return provider.chat(req);
      },
      {
        policy: this.policy,
        signal: req.signal,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `${provider.name} attempt ${attempt} failed with ${error.status ?? 'no status'}, retrying in ${delayMs} ms`,
          );
        },
      },
    );

    return {
      result,
      costUsd: provider.estimateCostUsd(req.model, result.usage),
      latencyMs: Date.now() - startedAt,
      attempts,
    };
  }

  async *stream(
    req: ChatRequest,
    onFinish: (outcome: StreamOutcome) => void,
  ): AsyncGenerator<ChatChunk> {
    const provider = this.resolve(req.model);
    const startedAt = Date.now();
    let attempts = 0;

    // retry covers opening the stream and reaching its first chunk, nothing
    // after that: once a delta has been handed to the caller the answer is
    // partially delivered, and a second attempt would restart the text midway
    const opened = await withRetry(
      async (attempt) => {
        attempts = attempt;
        const iterator = provider.stream(req)[Symbol.asyncIterator]();
        const first = await iterator.next();
        return { iterator, first };
      },
      {
        policy: this.policy,
        signal: req.signal,
        onRetry: ({ attempt, delayMs, error }) => {
          this.logger.warn(
            `${provider.name} stream attempt ${attempt} failed with ${error.status ?? 'no status'}, retrying in ${delayMs} ms`,
          );
        },
      },
    );

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

    onFinish({
      provider: provider.name,
      model: req.model,
      usage,
      costUsd: provider.estimateCostUsd(req.model, usage),
      latencyMs: Date.now() - startedAt,
      attempts,
    });
  }
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
