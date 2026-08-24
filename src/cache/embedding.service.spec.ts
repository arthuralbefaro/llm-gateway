import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';

const CRASHING_WORKER = join(__dirname, '__fixtures__', 'crashing.worker.cjs');

function config(overrides: Record<string, string> = {}): ConfigService {
  const values: Record<string, string> = {
    EMBEDDING_WORKER_PATH: CRASHING_WORKER,
    EMBEDDING_POOL_SIZE: '2',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('EmbeddingService', () => {
  let service: EmbeddingService;

  afterEach(async () => {
    await service.onModuleDestroy();
  });

  it('runs embeddings on the pool', async () => {
    service = new EmbeddingService(config());

    await expect(service.embed('hello')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(service.stats().size).toBe(2);
  });

  it('survives a worker dying and keeps serving afterwards', async () => {
    service = new EmbeddingService(config());
    await service.embed('warm');

    // the task on the dead thread fails, which callers treat as a cache miss
    await expect(service.embed('crash')).rejects.toBeInstanceOf(Error);

    // the pool replaces the thread, so the next caller is served again
    await expect(service.embed('after')).resolves.toEqual([0.1, 0.2, 0.3]);
    expect(service.stats().rejected).toBe(1);
  });

  it('rejects a task whose caller already went away', async () => {
    service = new EmbeddingService(config());
    const abort = new AbortController();
    abort.abort();

    await expect(service.embed('hello', abort.signal)).rejects.toBeInstanceOf(
      Error,
    );
  });

  it('defaults the pool size to one worker per core minus the event loop', () => {
    service = new EmbeddingService(config({ EMBEDDING_POOL_SIZE: '' }));

    expect(service.stats().size).toBeGreaterThanOrEqual(1);
    expect(service.stats().size).toBeLessThanOrEqual(4);
  });
});
