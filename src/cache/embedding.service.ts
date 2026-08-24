import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Piscina from 'piscina';
import type { EmbedTask, WorkerConfig } from './embedding.worker';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_CACHE_DIR = './.models';

export const EMBEDDING_DIMENSIONS = 384;

// one worker by default, which is not an oversight
//
// the pool exists to move inference off the event loop, not to parallelise it:
// onnxruntime already spreads a single inference across cores internally, so a
// second worker competes with the first for the same cores rather than adding
// throughput. measured at 40 req/s on four physical cores, p99 was 152 ms with
// one worker, 252 ms with two and 462 ms with four, see docs/load
const DEFAULT_WORKERS = 1;

// a task that starts after the caller gave up is pure waste, so the queue is
// bounded and overflow skips the cache rather than growing without limit
const QUEUE_PER_WORKER = 10;

export interface PoolStats {
  size: number;
  queued: number;
  completed: number;
  rejected: number;
}

@Injectable()
export class EmbeddingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly modelId: string;
  private readonly pool: Piscina<EmbedTask, number[]>;
  private readonly size: number;
  private rejected = 0;

  constructor(config: ConfigService) {
    this.modelId = config.get<string>('EMBEDDING_MODEL') ?? DEFAULT_MODEL;
    const cacheDir =
      config.get<string>('EMBEDDING_CACHE_DIR') ?? DEFAULT_CACHE_DIR;
    this.size = poolSize(config);

    const workerConfig: WorkerConfig = { modelId: this.modelId, cacheDir };

    this.pool = new Piscina<EmbedTask, number[]>({
      // resolved from the compiled location, because the worker runs as js
      filename:
        config.get<string>('EMBEDDING_WORKER_PATH') ??
        join(__dirname, 'embedding.worker.js'),
      minThreads: this.size,
      maxThreads: this.size,
      maxQueue: this.size * QUEUE_PER_WORKER,
      workerData: { config: workerConfig },
    });
  }

  async onModuleInit(): Promise<void> {
    // warming moves the model load and the cold inference off the first user
    // request, and every worker has to be hit or only one of them is warm
    const startedAt = Date.now();
    try {
      const loads = await Promise.all(
        Array.from({ length: this.size }, (_, index) => this.warmOne(index)),
      );
      const embedStartedAt = Date.now();
      await this.embed('warmup');

      this.logger.log(
        `embedding pool ready with ${this.size} workers, slowest load ${Math.max(...loads)} ms, first embedding ${Date.now() - embedStartedAt} ms`,
      );
    } catch (error) {
      // a cold pool leaves the cache cold, lookups fall through to the provider
      this.logger.error(
        `embedding pool failed to warm up after ${Date.now() - startedAt} ms: ${describe(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.destroy();
  }

  /**
   * Embeds a prompt into a unit-length vector of EMBEDDING_DIMENSIONS floats.
   *
   * Rejects when the pool queue is full or a worker died mid-task. Callers
   * treat that as a cache miss: an unavailable embedding costs a lookup, never
   * a request.
   */
  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    try {
      return await this.pool.run({ text }, { signal });
    } catch (error) {
      this.rejected += 1;
      throw error instanceof Error ? error : new Error('embedding failed');
    }
  }

  stats(): PoolStats {
    return {
      size: this.size,
      queued: this.pool.queueSize,
      completed: this.pool.completed,
      rejected: this.rejected,
    };
  }

  // one task per worker, run concurrently so each thread is forced to load
  private async warmOne(index: number): Promise<number> {
    const startedAt = Date.now();
    await this.pool.run({ text: `warmup ${index}` });
    const elapsed = Date.now() - startedAt;
    this.logger.log(`embedding worker ready in ${elapsed} ms`);
    return elapsed;
  }
}

/**
 * Workers to run. Raising this only helps where inference is single threaded
 * or the host has cores to spare beyond what onnxruntime already uses.
 */
function poolSize(config: ConfigService): number {
  const configured = Number(config.get<string>('EMBEDDING_POOL_SIZE'));
  if (Number.isFinite(configured) && configured >= 1) {
    return Math.min(Math.floor(configured), availableParallelism());
  }
  return DEFAULT_WORKERS;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
