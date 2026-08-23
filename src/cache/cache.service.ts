import { createHash } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ChatRequest } from '../providers/provider.types';
import { EmbeddingService } from './embedding.service';

const DEFAULT_THRESHOLD = 0.92;
const DEFAULT_TTL_SECONDS = 60 * 60 * 24;

export type CacheHitKind = 'exact' | 'semantic';

export interface CacheHit {
  response: string;
  kind: CacheHitKind;
  similarity: number;
}

interface NeighbourRow {
  id: string;
  response: string;
  similarity: number;
}

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private readonly threshold: number;
  private readonly ttlSeconds: number;
  private readonly allowNonZeroTemperature: boolean;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly embeddings: EmbeddingService,
  ) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      // the cache must never be the reason a request fails, so a dead redis
      // surfaces as an error we catch rather than an endless retry queue
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    // ioredis connection errors often carry an empty message, the code is the
    // only part that says what actually happened
    this.redis.on('error', (error: Error & { code?: string }) => {
      this.logger.warn(
        `redis unavailable: ${error.code ?? ''} ${error.message}`.trim(),
      );
    });

    this.threshold = Number(
      config.get<string>('CACHE_SIMILARITY_THRESHOLD') ?? DEFAULT_THRESHOLD,
    );
    this.ttlSeconds = Number(
      config.get<string>('CACHE_TTL_SECONDS') ?? DEFAULT_TTL_SECONDS,
    );
    // a caller asking for temperature above zero asked for variation, and
    // replaying one stored answer is the opposite of that
    this.allowNonZeroTemperature =
      config.get<string>('CACHE_ALLOW_NONZERO_TEMPERATURE') === 'true';
  }

  isCacheable(req: ChatRequest): boolean {
    if (this.allowNonZeroTemperature) {
      return true;
    }
    return (req.temperature ?? 0) === 0;
  }

  async lookup(req: ChatRequest): Promise<CacheHit | undefined> {
    if (!this.isCacheable(req)) {
      return undefined;
    }

    const prompt = normalize(req);

    try {
      const exact = await this.redis.get(redisKey(req.model, prompt));
      if (exact !== null) {
        return { response: exact, kind: 'exact', similarity: 1 };
      }
    } catch (error) {
      this.logger.warn(`exact lookup skipped: ${describe(error)}`);
    }

    try {
      return await this.semanticLookup(req.model, prompt);
    } catch (error) {
      // an unavailable cache costs latency, never availability
      this.logger.warn(`semantic lookup skipped: ${describe(error)}`);
      return undefined;
    }
  }

  async store(req: ChatRequest, response: string): Promise<void> {
    if (!this.isCacheable(req)) {
      return;
    }

    const prompt = normalize(req);
    const hash = promptHash(req.model, prompt);

    try {
      const embedding = await this.embeddings.embed(prompt);
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "CacheEntry" ("id", "promptHash", "prompt", "response", "model", "embedding", "lastUsedAt")
        VALUES (gen_random_uuid()::text, ${hash}, ${prompt}, ${response}, ${req.model}, ${toVector(embedding)}::vector, now())
        ON CONFLICT ("promptHash") DO UPDATE
          SET "response" = EXCLUDED."response", "lastUsedAt" = now()
      `);
      await this.redis.set(
        redisKey(req.model, prompt),
        response,
        'EX',
        this.ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(`cache store skipped: ${describe(error)}`);
    }
  }

  onModuleDestroy(): void {
    this.redis.disconnect();
  }

  private async semanticLookup(
    model: string,
    prompt: string,
  ): Promise<CacheHit | undefined> {
    const embedding = toVector(await this.embeddings.embed(prompt));

    // ordering by distance with limit 1 is what lets the hnsw index do the work
    const rows = await this.prisma.$queryRaw<NeighbourRow[]>(Prisma.sql`
      SELECT "id", "response", 1 - ("embedding" <=> ${embedding}::vector) AS similarity
      FROM "CacheEntry"
      WHERE "model" = ${model}
      ORDER BY "embedding" <=> ${embedding}::vector
      LIMIT 1
    `);

    const nearest = rows.at(0);
    if (!nearest || nearest.similarity < this.threshold) {
      return undefined;
    }

    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "CacheEntry"
      SET "hits" = "hits" + 1, "lastUsedAt" = now()
      WHERE "id" = ${nearest.id}
    `);

    await this.redis.set(
      redisKey(model, prompt),
      nearest.response,
      'EX',
      this.ttlSeconds,
    );

    return {
      response: nearest.response,
      kind: 'semantic',
      similarity: nearest.similarity,
    };
  }
}

// the model is part of the identity, the same question answered by two models
// is two different cache entries
function redisKey(model: string, prompt: string): string {
  return `cache:${promptHash(model, prompt)}`;
}

function promptHash(model: string, prompt: string): string {
  return createHash('sha256').update(`${model}\n${prompt}`).digest('hex');
}

// role labels are identical on both sides of any comparison, and shared
// boilerplate pulls unrelated vectors together, so only content is embedded
function normalize(req: ChatRequest): string {
  return req.messages
    .map((message) => message.content.trim())
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function toVector(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
