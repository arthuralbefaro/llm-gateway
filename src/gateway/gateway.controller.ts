import { Body, Controller, Logger, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
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
import { chatCompletionSchema } from './dto/chat-completion.schema';
import type { ChatCompletionBody } from './dto/chat-completion.schema';
import {
  completionId,
  completionPayload,
  openSseStream,
  writeDelta,
  writeDone,
  writeError,
  writeFinal,
} from './sse';

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0 };

@Controller('v1/chat')
@UseGuards(ApiKeyGuard)
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(
    private readonly router: RouterService,
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

    const startedAt = Date.now();
    try {
      const routed = await this.router.chat(this.toChatRequest(body));

      this.requestLog.record({
        apiKeyId,
        provider: routed.result.provider,
        model: routed.result.model,
        usage: routed.result.usage,
        costUsd: routed.costUsd,
        latencyMs: routed.latencyMs,
        cacheHit: false,
        status: 'success',
      });

      res.json(completionPayload(completionId(), routed.result, false));
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

    const startedAt = Date.now();
    const id = completionId();
    const stream = this.router.stream(
      { ...this.toChatRequest(body), signal: abort.signal },
      (outcome) => {
        this.requestLog.record({
          apiKeyId,
          provider: outcome.provider,
          model: outcome.model,
          usage: outcome.usage,
          costUsd: outcome.costUsd,
          latencyMs: outcome.latencyMs,
          cacheHit: false,
          status: 'success',
        });
      },
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
          writeFinal(res, id, body.model, chunk.usage ?? NO_USAGE, false);
        } else if (chunk.delta) {
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

    writeDone(res);
    res.end();
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
