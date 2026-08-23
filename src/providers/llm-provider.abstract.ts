import {
  ChatChunk,
  ChatRequest,
  ChatResult,
  TokenUsage,
} from './provider.types';

export abstract class LlmProvider {
  abstract readonly name: string;
  abstract supports(model: string): boolean;
  abstract chat(req: ChatRequest): Promise<ChatResult>;
  abstract stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  abstract estimateCostUsd(model: string, usage: TokenUsage): number;
}
