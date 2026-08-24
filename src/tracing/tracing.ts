import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  AlwaysOnSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import type { IncomingMessage } from 'node:http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';

const DEFAULT_ENDPOINT = 'http://localhost:4318/v1/traces';

let sdk: NodeSDK | undefined;

/**
 * Starts tracing.
 *
 * Called at module load rather than exported for the caller to invoke, because
 * a compiled import is hoisted above ordinary statements: calling it from
 * main.ts would run after nest and express had already been required, and the
 * instrumentations patch those modules as they load.
 */
function startTracing(): void {
  if (process.env.TRACING_ENABLED !== 'true' || sdk) {
    return;
  }

  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'llm-gateway',
    }),
    traceExporter: new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_ENDPOINT,
    }),
    sampler: sampler(),
    instrumentations: [
      // only http and express, because the auto bundle patches pg, redis, dns
      // and more, and each one adds spans nobody asked for and overhead to
      // every call on a path already measured in single milliseconds
      new HttpInstrumentation({
        // the health check is polled continuously and would drown real traffic
        ignoreIncomingRequestHook: (request: IncomingMessage) =>
          request.url?.startsWith('/health') === true,
      }),
      new ExpressInstrumentation(),
    ],
  });

  sdk.start();

  process.once('SIGTERM', () => {
    void sdk?.shutdown();
  });
}

/**
 * Head based sampling on the trace id.
 *
 * Development records everything. Production would run a ratio well under one,
 * because a gateway whose own overhead is about seven milliseconds cannot
 * afford to export a span tree per request, and head sampling is the only kind
 * available without a collector doing tail sampling.
 */
function sampler(): ParentBasedSampler | AlwaysOnSampler {
  const ratio = Number(process.env.TRACING_SAMPLE_RATIO);
  if (!Number.isFinite(ratio) || ratio >= 1) {
    return new AlwaysOnSampler();
  }
  return new ParentBasedSampler({
    root: new TraceIdRatioBasedSampler(Math.max(0, ratio)),
  });
}

startTracing();
