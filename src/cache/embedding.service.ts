import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const DEFAULT_MODEL = 'Xenova/multilingual-e5-small';
const DEFAULT_CACHE_DIR = './.models';

// int8 weights, roughly a quarter of the fp32 download for the same dimensions
const DTYPE = 'q8';

export const EMBEDDING_DIMENSIONS = 384;

@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly modelId: string;
  private extractor: FeatureExtractionPipeline | undefined;
  private loading: Promise<FeatureExtractionPipeline> | undefined;

  constructor(config: ConfigService) {
    this.modelId = config.get<string>('EMBEDDING_MODEL') ?? DEFAULT_MODEL;
    env.cacheDir =
      config.get<string>('EMBEDDING_CACHE_DIR') ?? DEFAULT_CACHE_DIR;
  }

  async onModuleInit(): Promise<void> {
    // warming here moves the model download and the cold inference off the
    // first user request
    const loadStartedAt = Date.now();
    try {
      await this.load();
      const loadMs = Date.now() - loadStartedAt;

      const embedStartedAt = Date.now();
      await this.embed('warmup');
      this.logger.log(
        `embedding model ${this.modelId} ready, load ${loadMs} ms, first embedding ${Date.now() - embedStartedAt} ms`,
      );
    } catch (error) {
      // a cold cache stays usable, lookups just fall through to the provider
      this.logger.error(
        `embedding model ${this.modelId} failed to warm up: ${describe(error)}`,
      );
    }
  }

  /**
   * Embeds a prompt into a unit-length vector of EMBEDDING_DIMENSIONS floats.
   */
  async embed(text: string): Promise<number[]> {
    const extractor = await this.load();
    // e5 models are trained with this prefix and score noticeably worse without
    // it, the rest of the codebase should never have to know
    const output = await extractor(`query: ${text}`, {
      pooling: 'mean',
      normalize: true,
    });

    return Array.from(output.data, Number);
  }

  private load(): Promise<FeatureExtractionPipeline> {
    if (this.extractor) {
      return Promise.resolve(this.extractor);
    }
    // concurrent callers during warmup must share one load, not start their own
    this.loading ??= pipeline('feature-extraction', this.modelId, {
      dtype: DTYPE,
    }).then((extractor) => {
      this.extractor = extractor;
      return extractor;
    });

    return this.loading;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
