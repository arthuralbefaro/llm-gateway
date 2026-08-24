import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '../llm-provider.abstract';
import {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderError,
  TokenUsage,
} from '../provider.types';

const DEFAULT_NAME = 'local';
const DEFAULT_ENV_PREFIX = 'LOCAL_PROVIDER';

export interface LocalAdapterOptions {
  name?: string;
  envPrefix?: string;
}

interface ModelPrice {
  input: number;
  output: number;
}

// fictional, but in the range of a small hosted model, so cost stays exercised
const PRICING: Record<string, ModelPrice> = {
  'local-small': { input: 0.1, output: 0.4 },
  'local-large': { input: 0.5, output: 2 },
};

const TOKENS_PER_PRICE_UNIT = 1_000_000;

// rough but stable, real tokenizers land near four characters per token
const CHARS_PER_TOKEN = 4;

const DEFAULT_LATENCY_MS = 150;

const DEFAULT_FAILURE_STATUS = 503;

@Injectable()
export class LocalAdapter extends LlmProvider {
  readonly name: string;

  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly failureStatus: number;
  private readonly failureFromMs: number;
  private readonly failureUntilMs: number;
  private readonly startedAt = Date.now();

  // a second instance under another name gives two providers serving the same
  // models, which is what makes fallback and the breaker demonstrable without
  // paying a real provider to go down
  constructor(config: ConfigService, options: LocalAdapterOptions = {}) {
    super();
    this.name = options.name ?? DEFAULT_NAME;
    const prefix = options.envPrefix ?? DEFAULT_ENV_PREFIX;

    this.latencyMs = Number(
      config.get<string>(`${prefix}_LATENCY_MS`) ?? DEFAULT_LATENCY_MS,
    );
    // injected failure is what makes retry, fallback and the breaker testable
    // under load without paying a real provider to misbehave
    this.failureRate = Number(
      config.get<string>(`${prefix}_FAILURE_RATE`) ?? 0,
    );
    this.failureStatus = Number(
      config.get<string>(`${prefix}_FAILURE_STATUS`) ?? DEFAULT_FAILURE_STATUS,
    );
    // a window relative to process start lets a provider die partway through a
    // load test and recover on its own, which is what proves a breaker closes
    this.failureFromMs = Number(
      config.get<string>(`${prefix}_FAILURE_FROM_MS`) ?? 0,
    );
    this.failureUntilMs = Number(
      config.get<string>(`${prefix}_FAILURE_UNTIL_MS`) ??
        Number.MAX_SAFE_INTEGER,
    );
  }

  supports(model: string): boolean {
    return Object.hasOwn(PRICING, model);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    await this.simulateLatency(this.latencyMs, req.signal);
    this.throwIfAborted(req.signal);
    this.maybeFail();

    const content = answerFor(req.messages);

    return {
      content,
      usage: usageFor(req.messages, content),
      model: req.model,
      provider: this.name,
    };
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    // failing here keeps the injected failure retryable, a failure after the
    // first chunk is a different scenario and belongs in a dedicated test
    this.maybeFail();
    await Promise.resolve();

    const content = answerFor(req.messages);
    const pieces = content.split(/(?<=\s)/);
    const perPiece = Math.max(
      1,
      Math.floor(this.latencyMs / Math.max(1, pieces.length)),
    );

    for (const piece of pieces) {
      await this.simulateLatency(perPiece, req.signal);
      if (req.signal?.aborted) {
        return;
      }
      yield { delta: piece, done: false };
    }

    yield { delta: '', done: true, usage: usageFor(req.messages, content) };
  }

  estimateCostUsd(model: string, usage: TokenUsage): number {
    const price: ModelPrice | undefined = PRICING[model];
    if (!price) {
      return 0;
    }
    return (
      (usage.promptTokens * price.input +
        usage.completionTokens * price.output) /
      TOKENS_PER_PRICE_UNIT
    );
  }

  private simulateLatency(
    ms: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
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

  private maybeFail(): void {
    const uptime = Date.now() - this.startedAt;
    if (uptime < this.failureFromMs || uptime >= this.failureUntilMs) {
      return;
    }
    if (this.failureRate > 0 && Math.random() < this.failureRate) {
      throw new ProviderError(
        `injected failure with status ${this.failureStatus}`,
        this.name,
        this.failureStatus,
        this.failureStatus === 429 || this.failureStatus >= 500,
      );
    }
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
      throw new ProviderError('request aborted by the client', this.name);
    }
  }
}

// the fingerprint makes a cache hit provable: a reply carrying the fingerprint
// of a different prompt can only have come from the cache
function answerFor(messages: ChatMessage[]): string {
  const prompt = messages.map((m) => `${m.role}:${m.content}`).join('\n');
  const fingerprint = createHash('sha256')
    .update(prompt)
    .digest('hex')
    .slice(0, 12);
  const question = messages.filter((m) => m.role === 'user').at(-1)?.content;

  return `This is a deterministic local reply to "${question ?? ''}" [fingerprint ${fingerprint}]`;
}

function usageFor(messages: ChatMessage[], content: string): TokenUsage {
  const promptChars = messages.reduce(
    (total, message) => total + message.content.length,
    0,
  );
  return {
    promptTokens: Math.ceil(promptChars / CHARS_PER_TOKEN),
    completionTokens: Math.ceil(content.length / CHARS_PER_TOKEN),
  };
}
