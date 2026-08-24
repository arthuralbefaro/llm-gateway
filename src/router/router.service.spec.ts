import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LlmProvider } from '../providers/llm-provider.abstract';
import {
  ChatChunk,
  ChatRequest,
  ChatResult,
  ProviderError,
  TokenUsage,
} from '../providers/provider.types';
import { RouterService } from './router.service';

const FAST_RETRY = {
  RETRY_MAX_ATTEMPTS: '3',
  RETRY_MAX_ELAPSED_MS: '10000',
  RETRY_BASE_DELAY_MS: '1',
  RETRY_MAX_DELAY_MS: '2',
};

function config(): ConfigService {
  return {
    get: (key: string) => FAST_RETRY[key as keyof typeof FAST_RETRY],
  } as unknown as ConfigService;
}

interface ScriptedOptions {
  name?: string;
  models?: string[];
  failures?: number;
  failAfterFirstChunk?: boolean;
  fatal?: boolean;
}

class ScriptedProvider extends LlmProvider {
  readonly name: string;
  chatCalls = 0;
  streamCalls = 0;

  private readonly models: string[];
  private readonly failures: number;
  private readonly failAfterFirstChunk: boolean;
  private readonly fatal: boolean;

  constructor(options: ScriptedOptions = {}) {
    super();
    this.name = options.name ?? 'stub';
    this.models = options.models ?? ['stub-model'];
    this.failures = options.failures ?? 0;
    this.failAfterFirstChunk = options.failAfterFirstChunk ?? false;
    this.fatal = options.fatal ?? false;
  }

  supports(model: string): boolean {
    return this.models.includes(model);
  }

  chat(): Promise<ChatResult> {
    this.chatCalls += 1;
    if (this.chatCalls <= this.failures) {
      return Promise.reject(
        this.fatal
          ? new ProviderError('bad upstream request', this.name, 400, false)
          : new ProviderError('upstream busy', this.name, 503, true),
      );
    }
    return Promise.resolve({
      content: `ok from ${this.name}`,
      usage: { promptTokens: 1, completionTokens: 1 },
      model: this.models[0],
      provider: this.name,
    });
  }

  async *stream(): AsyncGenerator<ChatChunk> {
    this.streamCalls += 1;
    const failing = this.streamCalls <= this.failures;

    if (failing && !this.failAfterFirstChunk) {
      await Promise.resolve();
      throw new ProviderError('upstream busy', this.name, 503, true);
    }

    yield { delta: 'first', done: false };

    if (failing && this.failAfterFirstChunk) {
      throw new ProviderError('upstream died', this.name, 503, true);
    }

    yield {
      delta: '',
      done: true,
      usage: { promptTokens: 1, completionTokens: 1 },
    };
  }

  estimateCostUsd(_model: string, usage: TokenUsage): number {
    return usage.completionTokens * 0.001;
  }
}

function drain(req: ChatRequest, router: RouterService): Promise<ChatChunk[]> {
  return (async () => {
    const chunks: ChatChunk[] = [];
    for await (const chunk of router.stream(req, {
      onFinish: () => undefined,
    })) {
      chunks.push(chunk);
    }
    return chunks;
  })();
}

const REQUEST: ChatRequest = {
  model: 'stub-model',
  messages: [{ role: 'user', content: 'hi' }],
};

describe('RouterService', () => {
  it('rejects a model no provider supports', () => {
    const router = new RouterService([new ScriptedProvider()], config());

    expect(() => router.resolve('llama-3-70b')).toThrow(BadRequestException);
  });

  it('retries a retryable failure and reports the attempt count', async () => {
    const provider = new ScriptedProvider({ failures: 2 });
    const router = new RouterService([provider], config());

    const routed = await router.chat(REQUEST);

    expect(routed.result.content).toBe('ok from stub');
    expect(provider.chatCalls).toBe(3);
    expect(routed.attempts.map((a) => a.status)).toEqual([
      'error',
      'error',
      'success',
    ]);
    expect(routed.attempts.at(-1)?.provider).toBe('stub');
  });

  it('retries a stream that fails before its first chunk', async () => {
    const provider = new ScriptedProvider({ failures: 1 });
    const router = new RouterService([provider], config());

    const chunks = await drain(REQUEST, router);

    expect(provider.streamCalls).toBe(2);
    expect(chunks.at(0)?.delta).toBe('first');
  });

  it('never retries a stream that already emitted a chunk', async () => {
    const provider = new ScriptedProvider({
      failures: 1,
      failAfterFirstChunk: true,
    });
    const router = new RouterService([provider], config());

    // the caller has the partial answer already, a second attempt would restart
    // the text midway through what they are reading
    await expect(drain(REQUEST, router)).rejects.toBeInstanceOf(ProviderError);
    expect(provider.streamCalls).toBe(1);
  });

  it('falls back to another provider serving the same model', async () => {
    const primary = new ScriptedProvider({ name: 'primary', failures: 99 });
    const backup = new ScriptedProvider({ name: 'backup' });
    const router = new RouterService([primary, backup], config());

    const routed = await router.chat(REQUEST);

    expect(routed.result.provider).toBe('backup');
    expect(routed.result.model).toBe('stub-model');
    expect(primary.chatCalls).toBe(3);
    expect(backup.chatCalls).toBe(1);
  });

  it('records every attempt across providers, not only the last', async () => {
    const primary = new ScriptedProvider({ name: 'primary', failures: 99 });
    const backup = new ScriptedProvider({ name: 'backup' });
    const router = new RouterService([primary, backup], config());

    const routed = await router.chat(REQUEST);

    expect(routed.attempts.map((a) => `${a.provider}:${a.status}`)).toEqual([
      'primary:error',
      'primary:error',
      'primary:error',
      'backup:success',
    ]);
    expect(routed.attempts.every((a) => a.attempt > 0)).toBe(true);
  });

  it('falls back on a non retryable failure without retrying it', async () => {
    const primary = new ScriptedProvider({
      name: 'primary',
      failures: 99,
      fatal: true,
    });
    const backup = new ScriptedProvider({ name: 'backup' });
    const router = new RouterService([primary, backup], config());

    const routed = await router.chat(REQUEST);

    expect(routed.result.provider).toBe('backup');
    expect(primary.chatCalls).toBe(1);
  });

  it('does not fall back when the caller opted out', async () => {
    const primary = new ScriptedProvider({ name: 'primary', failures: 99 });
    const backup = new ScriptedProvider({ name: 'backup' });
    const router = new RouterService([primary, backup], config());

    await expect(router.chat(REQUEST, false)).rejects.toBeInstanceOf(
      ProviderError,
    );
    expect(backup.chatCalls).toBe(0);
  });

  it('substitutes an equivalent model when the requested one keeps failing', async () => {
    const primary = new ScriptedProvider({
      name: 'primary',
      models: ['local-small'],
      failures: 99,
    });
    const sibling = new ScriptedProvider({
      name: 'sibling',
      models: ['local-large'],
    });
    const router = new RouterService([primary, sibling], config());

    const routed = await router.chat({ ...REQUEST, model: 'local-small' });

    expect(routed.result.model).toBe('local-large');
    expect(routed.result.provider).toBe('sibling');
  });

  // a model nobody serves is a configuration answer, not an outage, so it stays
  // a 400 instead of being quietly answered by a different model
  it('rejects a model no provider serves even when an equivalent exists', async () => {
    const sibling = new ScriptedProvider({
      name: 'sibling',
      models: ['local-large'],
    });
    const router = new RouterService([sibling], config());

    await expect(
      router.chat({ ...REQUEST, model: 'local-small' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sibling.chatCalls).toBe(0);
  });

  it('prefers the requested model over an equivalent one', () => {
    const exact = new ScriptedProvider({
      name: 'exact',
      models: ['local-small'],
    });
    const sibling = new ScriptedProvider({
      name: 'sibling',
      models: ['local-large'],
    });
    const router = new RouterService([exact, sibling], config());

    const targets = router.targets({ ...REQUEST, model: 'local-small' }, true);

    expect(targets.map((t) => `${t.provider.name}/${t.model}`)).toEqual([
      'exact/local-small',
      'sibling/local-large',
    ]);
  });
});
