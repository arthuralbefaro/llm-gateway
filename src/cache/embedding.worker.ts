import { workerData } from 'node:worker_threads';
import { env, pipeline } from '@huggingface/transformers';
import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export interface EmbedTask {
  text: string;
}

export interface WorkerConfig {
  modelId: string;
  cacheDir: string;
}

interface WorkerData {
  config?: WorkerConfig;
}

function isWorkerData(value: unknown): value is WorkerData {
  return typeof value === 'object' && value !== null && 'config' in value;
}

// piscina hands workerData to every thread, and the model has to load once per
// worker rather than once per task or the pool buys nothing
const config: WorkerConfig = (isWorkerData(workerData)
  ? workerData.config
  : undefined) ?? {
  modelId: 'Xenova/multilingual-e5-small',
  cacheDir: './.models',
};

env.cacheDir = config.cacheDir;

let extractor: Promise<FeatureExtractionPipeline> | undefined;

function load(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline('feature-extraction', config.modelId, {
    dtype: 'q8',
  });
  return extractor;
}

// loading starts as the thread comes up rather than on the first task, so the
// pool is warm by the time the warmup task lands
const loading = load();

export default async function embed(task: EmbedTask): Promise<number[]> {
  const model = await loading;
  // e5 is trained with this prefix and scores noticeably worse without it, and
  // it stays inside the embedding layer so nothing else has to know
  const output = await model(`query: ${task.text}`, {
    pooling: 'mean',
    normalize: true,
  });

  return Array.from(output.data, Number);
}
