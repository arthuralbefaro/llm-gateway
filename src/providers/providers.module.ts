import { Module } from '@nestjs/common';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAiAdapter } from './adapters/openai.adapter';
import { LlmProvider } from './llm-provider.abstract';

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

@Module({
  providers: [
    OpenAiAdapter,
    AnthropicAdapter,
    {
      provide: LLM_PROVIDERS,
      useFactory: (...providers: LlmProvider[]): LlmProvider[] => providers,
      inject: [OpenAiAdapter, AnthropicAdapter],
    },
  ],
  // only the token leaves this module, so nothing downstream can reach adapters/
  exports: [LLM_PROVIDERS],
})
export class ProvidersModule {}
