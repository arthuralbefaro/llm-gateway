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

class ScriptedProvider extends LlmProvider {
  readonly name = 'stub';
  chatCalls = 0;
  streamCalls = 0;

  constructor(
    private readonly failures: number,
    private readonly failAfterFirstChunk = false,
  ) {
    super();
  }

  supports(model: string): boolean {
    return model === 'stub-model';
  }

  chat(): Promise<ChatResult> {
    this.chatCalls += 1;
    if (this.chatCalls <= this.failures) {
      return Promise.reject(
        new ProviderError('upstream busy', this.name, 503, true),
      );
    }
    return Promise.resolve({
      content: 'ok',
      usage: { promptTokens: 1, completionTokens: 1 },
      model: 'stub-model',
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
    for await (const chunk of router.stream(req, () => undefined)) {
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
    const router = new RouterService([new ScriptedProvider(0)], config());

    expect(() => router.resolve('llama-3-70b')).toThrow(BadRequestException);
  });

  it('retries a retryable failure and reports the attempt count', async () => {
    const provider = new ScriptedProvider(2);
    const router = new RouterService([provider], config());

    const routed = await router.chat(REQUEST);

    expect(routed.result.content).toBe('ok');
    expect(routed.attempts).toBe(3);
    expect(provider.chatCalls).toBe(3);
  });

  it('retries a stream that fails before its first chunk', async () => {
    const provider = new ScriptedProvider(1);
    const router = new RouterService([provider], config());

    const chunks = await drain(REQUEST, router);

    expect(provider.streamCalls).toBe(2);
    expect(chunks.at(0)?.delta).toBe('first');
  });

  it('never retries a stream that already emitted a chunk', async () => {
    const provider = new ScriptedProvider(1, true);
    const router = new RouterService([provider], config());

    // the caller has the partial answer already, a second attempt would restart
    // the text midway through what they are reading
    await expect(drain(REQUEST, router)).rejects.toBeInstanceOf(ProviderError);
    expect(provider.streamCalls).toBe(1);
  });
});
