import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { LlmProvider } from '../llm-provider.abstract';
import { retryAfterMs } from '../retry-after';
import {
  ChatChunk,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ProviderError,
  TokenUsage,
} from '../provider.types';

const PROVIDER = 'anthropic';

interface ModelPrice {
  input: number;
  output: number;
}

// usd per million tokens, https://docs.claude.com/en/docs/about-claude/pricing
const PRICING: Record<string, ModelPrice> = {
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const TOKENS_PER_PRICE_UNIT = 1_000_000;

// the api rejects a request without it, openai has no equivalent requirement
const DEFAULT_MAX_TOKENS = 4096;

type ConversationMessage = ChatMessage & { role: 'user' | 'assistant' };

function isConversationMessage(
  message: ChatMessage,
): message is ConversationMessage {
  return message.role !== 'system';
}

interface SplitMessages {
  system: string | undefined;
  messages: MessageParam[];
}

@Injectable()
export class AnthropicAdapter extends LlmProvider {
  readonly name = PROVIDER;

  private readonly client: Anthropic;

  constructor(config: ConfigService) {
    super();
    this.client = new Anthropic({
      apiKey: config.getOrThrow<string>('ANTHROPIC_API_KEY'),
      // retries disabled here, router owns retry and circuit breaking
      maxRetries: 0,
    });
  }

  // a model we cannot price is a model we do not route to
  supports(model: string): boolean {
    return Object.hasOwn(PRICING, model);
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const { system, messages } = this.split(req.messages);

    try {
      const message = await this.client.messages.create(
        {
          model: req.model,
          messages,
          system,
          temperature: req.temperature,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: false,
        },
        { signal: req.signal },
      );

      const content = message.content
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');

      return {
        content,
        usage: {
          promptTokens: message.usage.input_tokens,
          completionTokens: message.usage.output_tokens,
        },
        model: message.model,
        provider: PROVIDER,
      };
    } catch (error) {
      throw this.normalize(error);
    }
  }

  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> {
    const { system, messages } = this.split(req.messages);
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const stream = await this.client.messages.create(
        {
          model: req.model,
          messages,
          system,
          temperature: req.temperature,
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
          stream: true,
        },
        { signal: req.signal },
      );

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start':
            promptTokens = event.message.usage.input_tokens;
            completionTokens = event.message.usage.output_tokens;
            break;
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              yield { delta: event.delta.text, done: false };
            }
            break;
          case 'message_delta':
            // these counters are cumulative, so overwrite instead of adding
            if (event.usage.input_tokens !== null) {
              promptTokens = event.usage.input_tokens;
            }
            completionTokens = event.usage.output_tokens;
            break;
          default:
            break;
        }
      }
    } catch (error) {
      throw this.normalize(error);
    }

    yield {
      delta: '',
      done: true,
      usage: { promptTokens, completionTokens },
    };
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

  // anthropic takes the system prompt as its own field, not as a message
  private split(messages: ChatMessage[]): SplitMessages {
    const system = messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n\n');

    const conversation = messages
      .filter(isConversationMessage)
      .map((message): MessageParam => ({
        role: message.role,
        content: message.content,
      }));

    return {
      system: system.length > 0 ? system : undefined,
      messages: conversation,
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
        retryAfterMs(error.headers, Date.now()),
      );
    }
    if (error instanceof Error) {
      return new ProviderError(error.message, PROVIDER);
    }
    return new ProviderError('unknown anthropic error', PROVIDER);
  }

  private isRetryable(status: number | undefined): boolean {
    if (status === undefined) {
      return false;
    }
    return status === 429 || status >= 500;
  }
}
