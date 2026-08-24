import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';

export type SpanAttributes = Record<string, string | number | boolean>;

const tracer = trace.getTracer('llm-gateway');

/**
 * Runs work inside a span, recording a thrown error on the span rather than
 * only logging it, so a failed request is red in the trace instead of merely
 * short.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  work: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await work(span);
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'unknown error',
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

/**
 * Opens a span the caller ends itself.
 *
 * Streaming needs this: the span has to outlive the function that opened it,
 * because closing when the headers flush would hide every chunk after them.
 */
export function startSpan(name: string, attributes: SpanAttributes): Span {
  return tracer.startSpan(name, { attributes });
}

export function failSpan(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : 'unknown error',
  });
}

export function currentSpan(): Span | undefined {
  return trace.getActiveSpan();
}
