import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { LlmProvider } from '../providers/llm-provider.abstract';
import { LLM_PROVIDERS } from '../providers/providers.module';
import {
  ChatChunk,
  ChatRequest,
  ChatResult,
  TokenUsage,
} from '../providers/provider.types';

export interface RoutedChat {
  result: ChatResult;
  costUsd: number;
  latencyMs: number;
}

export interface StreamOutcome {
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
}

@Injectable()
export class RouterService {
  constructor(
    @Inject(LLM_PROVIDERS) private readonly providers: LlmProvider[],
  ) {}

  resolve(model: string): LlmProvider {
    const provider = this.providers.find((candidate) =>
      candidate.supports(model),
    );
    if (!provider) {
      const registered = this.providers.map((p) => p.name).join(', ') || 'none';
      throw new BadRequestException(
        `no registered provider supports model "${model}" (registered providers: ${registered})`,
      );
    }
    return provider;
  }

  // latency is measured here because the router sees the whole request, an
  // adapter only sees its own call
  async chat(req: ChatRequest): Promise<RoutedChat> {
    const provider = this.resolve(req.model);
    const startedAt = Date.now();
    const result = await provider.chat(req);

    return {
      result,
      costUsd: provider.estimateCostUsd(req.model, result.usage),
      latencyMs: Date.now() - startedAt,
    };
  }

  async *stream(
    req: ChatRequest,
    onFinish: (outcome: StreamOutcome) => void,
  ): AsyncGenerator<ChatChunk> {
    const provider = this.resolve(req.model);
    const startedAt = Date.now();
    let usage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    for await (const chunk of provider.stream(req)) {
      if (chunk.usage) {
        usage = chunk.usage;
      }
      yield chunk;
    }

    onFinish({
      provider: provider.name,
      model: req.model,
      usage,
      costUsd: provider.estimateCostUsd(req.model, usage),
      latencyMs: Date.now() - startedAt,
    });
  }
}
