// renders a jaeger trace as a span tree, so a trace can be reviewed from the
// terminal instead of only in the ui

const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';
const SERVICE = process.env.OTEL_SERVICE_NAME ?? 'llm-gateway';
const WANTED = process.argv[2];
const SHOW_ATTRS = process.argv[3] !== 'no-attrs';

const res = await fetch(
  `${JAEGER}/api/traces?service=${SERVICE}&limit=20`,
);
const body = await res.json();
const traces = body.data ?? [];

function label(trace) {
  const root = trace.spans.find((s) => s.references.length === 0);
  const attrs = new Map(
    trace.spans.flatMap((s) => s.tags.map((t) => [t.key, t.value])),
  );
  const parts = [
    attrs.get('llm.stream') === true ? 'stream' : 'json',
    attrs.get('cache.hit') === true ? 'cache-hit' : 'cache-miss',
    attrs.get('llm.fallback') === true ? 'fallback' : '',
  ].filter(Boolean);
  return `${root?.operationName ?? '?'} [${parts.join(' ')}]`;
}

// the boot warmup embeds with no request in scope and correctly opens its own
// trace, which is not what anybody asking for a request trace wants to see
const requests = traces.filter((t) =>
  t.spans.some((s) => s.references.length === 0 && s.operationName.startsWith('POST')),
);
const matching = WANTED
  ? requests.filter((t) => label(t).includes(WANTED))
  : requests;

if (matching.length === 0) {
  console.log(`no trace matching "${WANTED ?? ''}"`);
  process.exit(1);
}

const trace = matching[0];
const byId = new Map(trace.spans.map((s) => [s.spanID, s]));
const children = new Map();
for (const span of trace.spans) {
  const parent = span.references.find((r) => r.refType === 'CHILD_OF');
  const key = parent ? parent.spanID : 'root';
  children.set(key, [...(children.get(key) ?? []), span]);
}

const start = Math.min(...trace.spans.map((s) => s.startTime));

const INTERESTING = new Set([
  'llm.provider',
  'llm.model',
  'llm.requested_model',
  'llm.attempt',
  'llm.attempt_status',
  'llm.fallback',
  'llm.attempts',
  'llm.cost_usd',
  'llm.cost_estimated',
  'llm.prompt_tokens',
  'llm.completion_tokens',
  'llm.stream',
  'cache.hit',
  'cache.kind',
  'cache.similarity',
  'breaker.state',
  'embedding.pool_size',
  'ratelimit.remaining',
  'error',
]);

function render(spanId, depth) {
  for (const span of (children.get(spanId) ?? []).sort(
    (a, b) => a.startTime - b.startTime,
  )) {
    const offset = ((span.startTime - start) / 1000).toFixed(1);
    const duration = (span.duration / 1000).toFixed(1);
    const failed = span.tags.some((t) => t.key === 'error' && t.value === true);
    console.log(
      `${'  '.repeat(depth)}${failed ? 'x ' : '- '}${span.operationName}  +${offset}ms  ${duration}ms`,
    );
    if (SHOW_ATTRS) {
      for (const tag of span.tags) {
        if (INTERESTING.has(tag.key)) {
          console.log(`${'  '.repeat(depth + 1)}  ${tag.key} = ${tag.value}`);
        }
      }
    }
    render(span.spanID, depth + 1);
  }
}

const root = trace.spans.find((s) => s.references.length === 0);
console.log(`trace ${trace.traceID}  ${label(trace)}`);
console.log(`spans ${trace.spans.length}  total ${(Math.max(...trace.spans.map((s) => s.startTime + s.duration)) - start) / 1000}ms\n`);
render('root', 0);
if (root && byId.size > 0 && !children.has('root')) {
  render(root.spanID, 0);
}
