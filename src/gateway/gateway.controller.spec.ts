import { ExecutionContext, INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import http, { Server } from 'node:http';
import { LlmProvider } from '../providers/llm-provider.abstract';
import { LLM_PROVIDERS } from '../providers/providers.module';
import {
  ChatChunk,
  ChatRequest,
  ChatResult,
  TokenUsage,
} from '../providers/provider.types';
import { RouterService } from '../router/router.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import type { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { RequestLogService } from '../metrics/request-log.service';
import { CacheService } from '../cache/cache.service';
import type { RequestRecord } from '../metrics/request-log.service';
import { GatewayController } from './gateway.controller';

// resolves early on abort so jest does not exit with a pending timer
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

class StubProvider extends LlmProvider {
  readonly name = 'stub';
  lastSignal: AbortSignal | undefined;
  slow = false;

  supports(model: string): boolean {
    return model === 'stub-model';
  }

  chat(): Promise<ChatResult> {
    return Promise.resolve({
      content: 'Hello there',
      usage: { promptTokens: 3, completionTokens: 2 },
      model: 'stub-model',
      provider: this.name,
    });
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    this.lastSignal = req.signal;
    yield { delta: 'Hello', done: false };
    if (this.slow) {
      for (let i = 0; i < 50; i += 1) {
        await sleep(40, req.signal);
        if (req.signal?.aborted) {
          return;
        }
        yield { delta: `tick${i}`, done: false };
      }
    }
    yield { delta: ' there', done: false };
    await Promise.resolve();
    yield {
      delta: '',
      done: true,
      usage: { promptTokens: 3, completionTokens: 2 },
    };
  }

  estimateCostUsd(_model: string, usage: TokenUsage): number {
    return usage.completionTokens * 0.001;
  }
}

// nest types getHttpServer as any, narrow it once instead of at every call
function isHttpServer(value: unknown): value is Server {
  return value instanceof Server;
}

function httpServer(nest: INestApplication): Server {
  const server: unknown = nest.getHttpServer();
  if (!isHttpServer(server)) {
    throw new Error('expected a node http server');
  }
  return server;
}

function listeningPort(server: Server): number {
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    throw new Error('server is not listening on a tcp port');
  }
  return address.port;
}

describe('GatewayController', () => {
  let app: INestApplication;
  const stub = new StubProvider();
  const recorded: RequestRecord[] = [];
  const requestLog = {
    record: (entry: RequestRecord) => {
      recorded.push(entry);
    },
  };
  const stored: string[] = [];
  const cache = {
    lookup: () => Promise.resolve(undefined),
    store: (_req: unknown, response: string) => {
      stored.push(response);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [GatewayController],
      providers: [
        RouterService,
        { provide: LLM_PROVIDERS, useValue: [stub] },
        { provide: RequestLogService, useValue: requestLog },
        { provide: CacheService, useValue: cache },
      ],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({
        canActivate: (context: ExecutionContext) => {
          context.switchToHttp().getRequest<AuthenticatedRequest>().apiKeyId =
            'test-api-key';
          return true;
        },
      })
      .compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    recorded.length = 0;
    stored.length = 0;
  });

  it('returns json when stream is false', async () => {
    const res = await request(httpServer(app))
      .post('/v1/chat/completions')
      .send({
        model: 'stub-model',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(201);

    expect(res.body).toMatchObject({
      object: 'chat.completion',
      model: 'stub-model',
      provider: 'stub',
      cache_hit: false,
      choices: [{ message: { role: 'assistant', content: 'Hello there' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      apiKeyId: 'test-api-key',
      provider: 'stub',
      model: 'stub-model',
      cacheHit: false,
      status: 'success',
      usage: { promptTokens: 3, completionTokens: 2 },
    });
    expect(recorded[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('streams one sse event per chunk and terminates with [DONE]', async () => {
    const res = await request(httpServer(app))
      .post('/v1/chat/completions')
      .send({
        model: 'stub-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    const events = res.text
      .split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => block.slice('data: '.length));

    expect(events).toHaveLength(4);
    expect(events[3]).toBe('[DONE]');

    const deltas = events
      .slice(0, 2)
      .map(
        (raw) =>
          JSON.parse(raw) as { choices: [{ delta: { content: string } }] },
      )
      .map((chunk) => chunk.choices[0].delta.content);
    expect(deltas).toEqual(['Hello', ' there']);

    const last = JSON.parse(events[2]) as {
      choices: [{ finish_reason: string }];
      usage: { total_tokens: number };
    };
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage.total_tokens).toBe(5);

    // the usage only exists after the final chunk, so the row is written then
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      status: 'success',
      cacheHit: false,
      usage: { promptTokens: 3, completionTokens: 2 },
    });
  });

  it('aborts the upstream stream when the client disconnects', async () => {
    stub.slow = true;
    await app.listen(0);
    const port = listeningPort(httpServer(app));

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        {
          port,
          path: '/v1/chat/completions',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          res.once('data', () => {
            req.destroy();
            resolve();
          });
          res.on('error', () => resolve());
        },
      );
      req.on('error', reject);
      req.end(
        JSON.stringify({
          model: 'stub-model',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        }),
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(stub.lastSignal?.aborted).toBe(true);
    stub.slow = false;
  });

  it('rejects a model no provider supports', async () => {
    await request(httpServer(app))
      .post('/v1/chat/completions')
      .send({
        model: 'llama-3-70b',
        messages: [{ role: 'user', content: 'hi' }],
      })
      .expect(400);
  });

  it('rejects an empty message list', async () => {
    await request(httpServer(app))
      .post('/v1/chat/completions')
      .send({ model: 'stub-model', messages: [] })
      .expect(400);
  });
});
