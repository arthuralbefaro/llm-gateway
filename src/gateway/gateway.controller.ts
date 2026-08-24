import { Body, Controller, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { CacheService } from '../cache/cache.service';
import type { CacheHit } from '../cache/cache.service';
import { ApiKeyId } from '../common/decorators/api-key-id.decorator';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { RequestLogService } from '../metrics/request-log.service';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import {
  ChatChunk,
  ChatRequest,
  ProviderError,
  TokenUsage,
} from '../providers/provider.types';
import { RouterService } from '../router/router.service';
import { MetricsService } from '../observability/metrics.service';
import type { CacheResult } from '../observability/metrics.service';
import { currentSpan, withSpan } from '../tracing/span';
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
// order matters, the key has to be known before it can be counted, and a key
// over its limit must not reach the cache or a provider
@UseGuards(ApiKeyGuard, RateLimitGuard)
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private readonly router: RouterService,
    private readonly cache: CacheService,
    private readonly requestLog: RequestLogService,
    private readonly metrics: MetricsService,
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
    const startedAt = Date.now();
    // the outcome travels back as a return value rather than on the instance,
    // because the controller is a singleton and concurrent requests would
    // overwrite each other's result
    let outcome: CacheResult = 'miss';

    // the span wraps the whole handler, whose promise only settles after
    // res.end, so a stream stays inside it instead of closing when the headers
    // flush and hiding every chunk that follows
    try {
      outcome = await withSpan(
        'gateway.completion',
        {
          'llm.requested_model': body.model,
          'llm.stream': body.stream,
          'llm.cache_requested': body.cache !== false,
        },
        () =>
          body.stream
            ? this.streamCompletion(body, apiKeyId, res)
            : this.jsonCompletion(body, apiKeyId, res),
      );
    } finally {
      // recorded here rather than per branch, so a thrown request is counted
      // with the same latency the caller experienced
      this.metrics.recordRequest(
        'v1/chat/completions',
        res.statusCode,
        outcome,
        (Date.now() - startedAt) / 1000,
      );
    }
  }

  private async jsonCompletion(
    body: ChatCompletionBody,
    apiKeyId: string,
    res: Response,
  ): Promise<CacheResult> {
    const req = this.toChatRequest(body);
    const startedAt = Date.now();
    const missed: CacheResult = body.cache === false ? 'bypassed' : 'miss';

    try {
      const hit = await this.lookup(body, req);
      if (hit) {
        annotate({
          'llm.provider': CACHE_PROVIDER,
          'llm.model': body.model,
          'cache.hit': true,
          'cache.kind': hit.kind,
        });
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
        return hit.kind;
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

      this.metrics.recordUsage(
        routed.result.provider,
        routed.result.model,
        routed.result.usage.promptTokens,
        routed.result.usage.completionTokens,
        routed.costUsd,
        false,
      );
      if (routed.usedFallback) {
        this.metrics.recordFallback(body.model, routed.result.model);
      }
      annotate({
        'llm.provider': routed.result.provider,
        'llm.model': routed.result.model,
        'llm.fallback': routed.usedFallback,
        'llm.attempts': routed.attempts.length,
        'llm.prompt_tokens': routed.result.usage.promptTokens,
        'llm.completion_tokens': routed.result.usage.completionTokens,
        'llm.cost_usd': routed.costUsd,
        'llm.cost_estimated': false,
        'cache.hit': false,
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
      return missed;
    } catch (error) {
      this.recordFailure(apiKeyId, body.model, error, Date.now() - startedAt);
      throw error;
    }
  }

  private async streamCompletion(
    body: ChatCompletionBody,
    apiKeyId: string,
    res: Response,
  ): Promise<CacheResult> {
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
    const missed: CacheResult = body.cache === false ? 'bypassed' : 'miss';

    const hit = await this.lookup(body, req);
    if (hit) {
      this.logCacheHit(hit.kind, body.model, hit.similarity);
      this.recordHit(apiKeyId, body.model, Date.now() - startedAt);
      openSseStream(res);
      for (const piece of chunkText(hit.response)) {
        if (abort.signal.aborted) {
          res.end();
          return hit.kind;
        }
        writeDelta(res, id, body.model, piece);
      }
      annotate({
        'llm.provider': CACHE_PROVIDER,
        'llm.model': body.model,
        'cache.hit': true,
        'cache.kind': hit.kind,
      });
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
      return hit.kind;
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
          this.metrics.recordUsage(
            outcome.provider,
            outcome.model,
            outcome.usage.promptTokens,
            outcome.usage.completionTokens,
            outcome.costUsd,
            false,
          );
          if (outcome.usedFallback) {
            this.metrics.recordFallback(body.model, outcome.model);
          }
          annotate({
            'llm.provider': outcome.provider,
            'llm.model': outcome.model,
            'llm.fallback': outcome.usedFallback,
            'llm.attempts': outcome.attempts.length,
            'llm.prompt_tokens': outcome.usage.promptTokens,
            'llm.completion_tokens': outcome.usage.completionTokens,
            'llm.cost_usd': outcome.costUsd,
            'llm.cost_estimated': false,
            'cache.hit': false,
          });
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
        return missed;
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
        return missed;
      }
      this.logger.error(`stream failed for ${id}: ${describe(error)}`);
      this.recordPartialStream(
        apiKeyId,
        body.model,
        served,
        content,
        error,
        Date.now() - startedAt,
      );
      writeError(res, describe(error), statusOf(error));
      res.end();
      return missed;
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
    return missed;
  }

  // reading is what the caller opted out of, writing still happens so the next
  // caller benefits from the answer this one paid for
  private lookup(
    body: ChatCompletionBody,
    req: ChatRequest,
  ): Promise<CacheHit | undefined> {
    if (body.cache === false) {
      return Promise.resolve(undefined);
    }
    return this.cache.lookup(req);
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

  // a stream that dies after emitting text was billed for what it produced, and
  // recording that as zero would understate cost in silence, so the tokens are
  // estimated from the emitted text and the row says the number is an estimate
  private recordPartialStream(
    apiKeyId: string,
    requestedModel: string,
    served: ServedTarget,
    content: string,
    error: unknown,
    latencyMs: number,
  ): void {
    if (content.length === 0) {
      this.recordFailure(apiKeyId, requestedModel, error, latencyMs);
      return;
    }

    const usage: TokenUsage = {
      promptTokens: 0,
      completionTokens: estimateTokens(content),
    };

    this.requestLog.record({
      apiKeyId,
      provider: served.provider,
      model: served.model,
      usage,
      costUsd: this.router.estimateCostUsd(
        served.provider,
        served.model,
        usage,
      ),
      costEstimated: true,
      latencyMs,
      cacheHit: false,
      status: 'error',
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

// rough on purpose, real tokenizers land near four characters per token and a
// per provider tokenizer would be a dependency and a network call to price a
// request that already failed
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// attributes land on whichever span is active, which is the completion span
// for both paths
function annotate(attributes: Record<string, string | number | boolean>): void {
  currentSpan()?.setAttributes(attributes);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown upstream error';
}

function statusOf(error: unknown): number | undefined {
  return error instanceof ProviderError ? error.status : undefined;
}
