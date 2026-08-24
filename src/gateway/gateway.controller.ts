import { Body, Controller, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CacheService } from '../cache/cache.service';
import { ApiKeyId } from '../common/decorators/api-key-id.decorator';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequestLogService } from '../metrics/request-log.service';
import {
  ChatChunk,
  ChatRequest,
  ProviderError,
  TokenUsage,
} from '../providers/provider.types';
import { RouterService } from '../router/router.service';
import type { ServedTarget } from '../router/router.service';
import { chatCompletionSchema } from './dto/chat-completion.schema';
import type { ChatCompletionBody } from './dto/chat-completion.schema';
import {
  chunkText,
  completionId,
  completionPayload,
  openSseStream,
  writeDelta,
  writeDone,
  writeError,
  writeFinal,
} from './sse';

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0 };

// a hit spends nothing upstream, so it is recorded against the cache rather
// than against whichever provider first produced the answer
const CACHE_PROVIDER = 'cache';

@Controller('v1/chat')
@UseGuards(ApiKeyGuard)
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private readonly router: RouterService,
    private readonly cache: CacheService,
    private readonly requestLog: RequestLogService,
  ) {}

  @Post('completions')
  async completions(
    // scoped to the body on purpose, UsePipes would also run this schema
    // against the api key id and reject every request
    @Body(new ZodValidationPipe(chatCompletionSchema))
    body: ChatCompletionBody,
    @ApiKeyId() apiKeyId: string,
    @Res() res: Response,
  ): Promise<void> {
    if (body.stream) {
      await this.streamCompletion(body, apiKeyId, res);
      return;
    }

    const req = this.toChatRequest(body);
    const startedAt = Date.now();

    try {
      const hit = await this.cache.lookup(req);
      if (hit) {
        this.logCacheHit(hit.kind, body.model, hit.similarity);
        this.recordHit(apiKeyId, body.model, Date.now() - startedAt);
        res.json(
          completionPayload(
            completionId(),
            {
              content: hit.response,
              usage: NO_USAGE,
              model: body.model,
              provider: CACHE_PROVIDER,
            },
            true,
            body.model,
            false,
          ),
        );
        return;
      }

      const routed = await this.router.chat(req, body.fallback);

      this.requestLog.record({
        apiKeyId,
        provider: routed.result.provider,
        model: routed.result.model,
        usage: routed.result.usage,
        costUsd: routed.costUsd,
        latencyMs: routed.latencyMs,
        cacheHit: false,
        status: 'success',
        attempts: routed.attempts,
      });

      // a substituted model answers a different question well enough to return,
      // but not well enough to cache under the requested model's key
      if (routed.result.model === body.model) {
        void this.cache.store(req, routed.result.content);
      }

      res.json(
        completionPayload(
          completionId(),
          routed.result,
          false,
          body.model,
          routed.usedFallback,
        ),
      );
    } catch (error) {
      this.recordFailure(apiKeyId, body.model, error, Date.now() - startedAt);
      throw error;
    }
  }

  private async streamCompletion(
    body: ChatCompletionBody,
    apiKeyId: string,
    res: Response,
  ): Promise<void> {
    const abort = new AbortController();
    // the body parser drains req and closes it before the handler runs, so req
    // close never fires here, res close is the disconnect signal
    res.on('close', () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });

    // resolve before any byte is written, so an unsupported model is still a 400
    this.router.resolve(body.model);

    const req = { ...this.toChatRequest(body), signal: abort.signal };
    const startedAt = Date.now();
    const id = completionId();

    const hit = await this.cache.lookup(req);
    if (hit) {
      this.logCacheHit(hit.kind, body.model, hit.similarity);
      this.recordHit(apiKeyId, body.model, Date.now() - startedAt);
      openSseStream(res);
      for (const piece of chunkText(hit.response)) {
        if (abort.signal.aborted) {
          res.end();
          return;
        }
        writeDelta(res, id, body.model, piece);
      }
      writeFinal(
        res,
        id,
        body.model,
        NO_USAGE,
        true,
        body.model,
        CACHE_PROVIDER,
        false,
      );
      writeDone(res);
      res.end();
      return;
    }

    let content = '';
    // the served target is only known once the stream opens, and the final
    // chunk has to report it rather than the model the caller asked for
    let served: ServedTarget = {
      provider: 'unknown',
      model: body.model,
      usedFallback: false,
    };

    const stream = this.router.stream(
      req,
      {
        onOpen: (target) => {
          served = target;
        },
        onFinish: (outcome) => {
          this.requestLog.record({
            apiKeyId,
            provider: outcome.provider,
            model: outcome.model,
            usage: outcome.usage,
            costUsd: outcome.costUsd,
            latencyMs: outcome.latencyMs,
            cacheHit: false,
            status: 'success',
            attempts: outcome.attempts,
          });
        },
      },
      body.fallback,
    );
    const iterator = stream[Symbol.asyncIterator]();

    // the first chunk is pulled before any header goes out, which keeps an
    // upstream failure a normal http error instead of an sse event
    let current: IteratorResult<ChatChunk>;
    try {
      current = await iterator.next();
    } catch (error) {
      if (abort.signal.aborted) {
        res.end();
        return;
      }
      this.recordFailure(apiKeyId, body.model, error, Date.now() - startedAt);
      throw error;
    }

    openSseStream(res);

    try {
      while (!current.done) {
        const chunk = current.value;
        if (chunk.done) {
          writeFinal(
            res,
            id,
            served.model,
            chunk.usage ?? NO_USAGE,
            false,
            body.model,
            served.provider,
            served.usedFallback,
          );
        } else if (chunk.delta) {
          content += chunk.delta;
          writeDelta(res, id, body.model, chunk.delta);
        }
        if (abort.signal.aborted) {
          break;
        }
        current = await iterator.next();
      }
    } catch (error) {
      if (abort.signal.aborted) {
        this.logger.warn(`client disconnected, upstream aborted for ${id}`);
        res.end();
        return;
      }
      this.logger.error(`stream failed for ${id}: ${describe(error)}`);
      this.recordFailure(apiKeyId, body.model, error, Date.now() - startedAt);
      writeError(res, describe(error), statusOf(error));
      res.end();
      return;
    }

    // a partial answer must not be stored as if it were the whole thing, and a
    // substituted model must not be stored under the requested model's key
    if (
      !abort.signal.aborted &&
      content.length > 0 &&
      served.model === body.model
    ) {
      void this.cache.store(req, content);
    }

    writeDone(res);
    res.end();
  }

  private logCacheHit(kind: string, model: string, similarity: number): void {
    this.logger.log(
      `${kind} cache hit for ${model} at similarity ${similarity.toFixed(4)}`,
    );
  }

  private recordHit(apiKeyId: string, model: string, latencyMs: number): void {
    this.requestLog.record({
      apiKeyId,
      provider: CACHE_PROVIDER,
      model,
      usage: NO_USAGE,
      costUsd: 0,
      latencyMs,
      cacheHit: true,
      status: 'success',
    });
  }

  private recordFailure(
    apiKeyId: string,
    model: string,
    error: unknown,
    latencyMs: number,
  ): void {
    this.requestLog.record({
      apiKeyId,
      provider: error instanceof ProviderError ? error.provider : 'unrouted',
      model,
      usage: NO_USAGE,
      costUsd: 0,
      latencyMs,
      cacheHit: false,
      status: 'error',
    });
  }

  private toChatRequest(body: ChatCompletionBody): ChatRequest {
    return {
      model: body.model,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown upstream error';
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ProviderError ? error.status : undefined;
}
