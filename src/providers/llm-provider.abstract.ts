import { ChatRequest, ChatResult, ChatChunk } from './provider.types';

export abstract class LlmProvider {
  abstract readonly name: string;
  abstract supports(model: string): boolean;
  abstract chat(req: ChatRequest): Promise<ChatResult>;
  abstract stream(req: ChatRequest): AsyncIterable<ChatChunk>;
  abstract estimateCostUsd(
    model: string,
    usage: { promptTokens: number; completionTokens: number },
  ): number;
}
