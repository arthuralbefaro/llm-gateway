import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { ChatResult, TokenUsage } from '../providers/provider.types';

export function completionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

function usagePayload(usage: TokenUsage): Record<string, number> {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    total_tokens: usage.promptTokens + usage.completionTokens,
  };
}

export function completionPayload(
  id: string,
  result: ChatResult,
  cacheHit: boolean,
): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: result.model,
    provider: result.provider,
    cache_hit: cacheHit,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: result.content },
        finish_reason: 'stop',
      },
    ],
    usage: usagePayload(result.usage),
  };
}

export function openSseStream(res: Response): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // nginx buffers event streams unless told otherwise, which defeats streaming
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export function writeDelta(
  res: Response,
  id: string,
  model: string,
  delta: string,
): void {
  writeData(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
  });
}

export function writeFinal(
  res: Response,
  id: string,
  model: string,
  usage: TokenUsage,
  cacheHit: boolean,
): void {
  writeData(res, {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    cache_hit: cacheHit,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: usagePayload(usage),
  });
}

// the http status is already on the wire once streaming starts, so a late
// failure can only be reported inside the stream
export function writeError(
  res: Response,
  message: string,
  status: number | undefined,
): void {
  res.write('event: error\n');
  res.write(
    `data: ${JSON.stringify({ error: { message, type: 'provider_error', status: status ?? null } })}\n\n`,
  );
}

export function writeDone(res: Response): void {
  res.write('data: [DONE]\n\n');
}

function writeData(res: Response, payload: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}
