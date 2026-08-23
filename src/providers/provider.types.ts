export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  // lets the caller cancel the upstream call when the client goes away
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface ChatChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
}

export interface ChatResult {
  content: string;
  usage: TokenUsage;
  model: string;
  provider: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
