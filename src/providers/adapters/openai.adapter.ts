import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI, { APIError } from 'openai';
import type { CompletionUsage } from 'openai/resources/completions';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { LlmProvider } from '../llm-provider.abstract';
import {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderError,
  TokenUsage,
} from '../provider.types';

const PROVIDER = 'openai';

interface ModelPrice {
  input: number;
  output: number;
}

// usd per million tokens, https://developers.openai.com/api/docs/pricing
const PRICING: Record<string, ModelPrice> = {
  'gpt-5': { input: 1.25, output: 10 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

const TOKENS_PER_PRICE_UNIT = 1_000_000;

@Injectable()
export class OpenAiAdapter extends LlmProvider {
  readonly name = PROVIDER;

  private readonly client: OpenAI;

  constructor(config: ConfigService) {
    super();
    this.client = new OpenAI({
      apiKey: config.getOrThrow<string>('OPENAI_API_KEY'),
      // retries disabled here, router owns retry and circuit breaking
      maxRetries: 0,
    });
  }

  // a model we cannot price is a model we do not route to
  supports(model: string): boolean {
    return Object.hasOwn(PRICING, model);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    try {
      const completion = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: this.toMessages(req.messages),
          temperature: req.temperature,
          max_completion_tokens: req.maxTokens,
          stream: false,
        },
        { signal: req.signal },
      );

      return {
        content: completion.choices[0]?.message.content ?? '',
        usage: this.toUsage(completion.usage),
        model: completion.model,
        provider: PROVIDER,
      };
    } catch (error) {
      throw this.normalize(error);
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    try {
      const stream = await this.client.chat.completions.create(
        {
          model: req.model,
          messages: this.toMessages(req.messages),
          temperature: req.temperature,
          max_completion_tokens: req.maxTokens,
          stream: true,
          // without this the stream carries no usage and the request has no cost
          stream_options: { include_usage: true },
        },
        { signal: req.signal },
      );

      for await (const chunk of stream) {
        if (chunk.usage) {
          usage = this.toUsage(chunk.usage);
        }
        const delta = chunk.choices[0]?.delta.content;
        if (delta) {
          yield { delta, done: false };
        }
      }
    } catch (error) {
      throw this.normalize(error);
    }

    yield { delta: '', done: true, usage };
  }

  estimateCostUsd(model: string, usage: TokenUsage): number {
    const price: ModelPrice | undefined = PRICING[model];
    if (!price) {
      return 0;
    }

    return (
      (usage.promptTokens * price.input +
        usage.completionTokens * price.output) /
      TOKENS_PER_PRICE_UNIT
    );
  }

  private toMessages(messages: ChatMessage[]): ChatCompletionMessageParam[] {
    return messages.map((message): ChatCompletionMessageParam => {
      switch (message.role) {
        case 'system':
          return { role: 'system', content: message.content };
        case 'user':
          return { role: 'user', content: message.content };
        case 'assistant':
          return { role: 'assistant', content: message.content };
      }
    });
  }

  private toUsage(usage: CompletionUsage | undefined): TokenUsage {
    return {
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
    };
  }

  private normalize(error: unknown): ProviderError {
    if (error instanceof APIError) {
      // the sdk types status as any, narrow it before it reaches ProviderError
      const status =
        typeof error.status === 'number' ? error.status : undefined;
      return new ProviderError(
        error.message,
        PROVIDER,
        status,
        this.isRetryable(status),
      );
    }
    if (error instanceof Error) {
      return new ProviderError(error.message, PROVIDER);
    }
    return new ProviderError('unknown openai error', PROVIDER);
  }

  private isRetryable(status: number | undefined): boolean {
    if (status === undefined) {
      return false;
    }
    return status === 429 || status >= 500;
  }
}
