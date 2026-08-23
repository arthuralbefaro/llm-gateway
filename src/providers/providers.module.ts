import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AnthropicAdapter } from './adapters/anthropic.adapter';
import { OpenAiAdapter } from './adapters/openai.adapter';
import { LlmProvider } from './llm-provider.abstract';

export const LLM_PROVIDERS = Symbol('LLM_PROVIDERS');

interface ProviderCandidate {
  name: string;
  envKey: string;
  create: (config: ConfigService) => LlmProvider;
}

const CANDIDATES: ProviderCandidate[] = [
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    create: (config) => new OpenAiAdapter(config),
  },
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    create: (config) => new AnthropicAdapter(config),
  },
];

// registering only configured providers keeps a missing key a boot-time warning
// instead of a request-time failure, and no environment configures every provider
function createProviders(config: ConfigService): LlmProvider[] {
  const logger = new Logger('ProvidersModule');
  const providers: LlmProvider[] = [];

  for (const candidate of CANDIDATES) {
    // an absent key and an empty one are equally unusable
    const apiKey = config.get<string>(candidate.envKey);
    if (!apiKey) {
      logger.warn(
        `${candidate.name} not registered, ${candidate.envKey} is missing or empty`,
      );
      continue;
    }
    providers.push(candidate.create(config));
  }

  if (providers.length === 0) {
    logger.error(
      'no llm provider registered, the gateway started without any upstream',
    );
  }

  return providers;
}

@Module({
  providers: [
    {
      provide: LLM_PROVIDERS,
      useFactory: createProviders,
      inject: [ConfigService],
    },
  ],
  // only the token leaves this module, so nothing downstream can reach adapters/
  exports: [LLM_PROVIDERS],
})
export class ProvidersModule {}
