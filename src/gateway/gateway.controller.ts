import { Body, Controller, Logger, Post, Res, UsePipes } from '@nestjs/common';
import type { Response } from 'express';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import {
  ChatChunk,
  ChatRequest,
  ProviderError,
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

@Controller('v1/chat')
export class GatewayController {
  private readonly logger = new Logger(GatewayController.name);

  constructor(private readonly router: RouterService) {}

  @Post('completions')
  @UsePipes(new ZodValidationPipe(chatCompletionSchema))
  async completions(
    @Body() body: ChatCompletionBody,
    @Res() res: Response,
  ): Promise<void> {
    if (body.stream) {
      await this.streamCompletion(body, res);
      return;
    }

    const routed = await this.router.chat(this.toChatRequest(body));
    res.json(completionPayload(completionId(), routed.result, false));
  }

  private async streamCompletion(
    body: ChatCompletionBody,
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

    const id = completionId();
    const stream = this.router.stream(
      { ...this.toChatRequest(body), signal: abort.signal },
      () => undefined,
    );
    const iterator = stream[Symbol.asyncIterator]();

    // the first chunk is pulled before any header goes out, so an upstream
    // failure here can still be a normal http error instead of an sse event
    let current: IteratorResult<ChatChunk>;
    try {
      current = await iterator.next();
    } catch (error) {
      if (abort.signal.aborted) {
        res.end();
        return;
      }
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
            body.model,
            chunk.usage ?? { promptTokens: 0, completionTokens: 0 },
            false,
          );
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
      writeError(res, describe(error), statusOf(error));
      res.end();
      return;
    }

    writeDone(res);
    res.end();
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
