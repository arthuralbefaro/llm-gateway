import { LineChart } from './chart';
import type { Series } from './chart';
import { breakers, cost, failures, hitRate, latency } from './analytics';
import type { Fetched, LatencyRow } from './analytics';

export const dynamic = 'force-dynamic';

const BUCKET = 'minute';

const COLOURS = {
  total: '#6b7280',
  exact: '#2563eb',
  semantic: '#d97706',
  confirmed: '#059669',
  estimated: '#a855f7',
  p50: '#2563eb',
  p95: '#d97706',
  p99: '#dc2626',
};

function Empty({ what, error }: { what: string; error?: string }) {
  return (
    <p className="empty">
      {error ? `could not load ${what}: ${error}` : `no ${what} in this window`}
    </p>
  );
}

function shortTime(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

function usd(value: number): string {
  return `$${value.toFixed(5)}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(0)}%`;
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

export default async function Page() {
  const [hits, costs, latencies, failureRows, breakerRows] = await Promise.all([
    hitRate(BUCKET),
    cost(BUCKET),
    latency(),
    failures(),
    breakers(),
  ]);

  // rows written before the cacheKind column exist count as hits but belong to
  // neither part, so the parts sum to less than the whole and the interface has
  // to say why rather than look broken
  const unclassified = hits.rows.reduce(
    (total, row) => total + (row.hits - row.exact_hits - row.semantic_hits),
    0,
  );

  return (
    <main>
      <header>
        <h1>LLM Gateway</h1>
        <p>Last 24 hours, bucketed by {BUCKET}. Live from the gateway.</p>
      </header>

      <section>
        <h2>Cost over time</h2>
        <p className="note">
          Estimated cost is drawn dashed. It comes from a stream that failed
          after emitting text, where the provider billed for output it never
          reported, so the tokens were counted from the characters sent.
        </p>
        <CostChart data={costs} />
      </section>

      <section>
        <h2>Cache hit rate</h2>
        <p className="note">
          Exact and semantic are separate lines because they are not the same
          product. The latency panel below is the reason: a semantic hit&apos;s
          tail sits close to an outright miss, so a combined hit rate would
          suggest a speed it does not deliver. Semantic reads are opt-in per
          request, so a near-zero semantic line is the default working as
          designed, not a regression.
        </p>
        {unclassified > 0 && (
          <p className="warn">
            {unclassified} hits in this window were recorded before the gateway
            stored which cache answered, so exact and semantic sum to less than
            the total.
          </p>
        )}
        <HitRateChart data={hits} />
      </section>

      <section>
        <h2>Latency by cache outcome</h2>
        <p className="note">
          Never aggregated across the cache outcome. A percentile over both
          describes no real population: the two are distributions two orders of
          magnitude apart.
        </p>
        <LatencyTable data={latencies} />
      </section>

      <section>
        <h2>Provider health</h2>
        <p className="note">
          Failure rate is counted over attempts rather than requests, so a
          provider failing behind a working fallback is still visible.
        </p>
        <ProviderTable failures={failureRows} breakers={breakerRows} />
      </section>
    </main>
  );
}

function CostChart({ data }: { data: Awaited<ReturnType<typeof cost>> }) {
  if (data.rows.length === 0) {
    return <Empty what="cost" error={data.error} />;
  }

  const buckets = [...new Set(data.rows.map((row) => row.bucket))].sort();
  const confirmed = buckets.map((bucket) =>
    data.rows
      .filter((row) => row.bucket === bucket)
      .reduce((total, row) => total + row.cost_confirmed, 0),
  );
  const estimated = buckets.map((bucket) =>
    data.rows
      .filter((row) => row.bucket === bucket)
      .reduce((total, row) => total + row.cost_estimated, 0),
  );

  const series: Series[] = [
    { label: 'confirmed', colour: COLOURS.confirmed, values: confirmed },
    {
      label: 'estimated',
      colour: COLOURS.estimated,
      values: estimated,
      dashed: true,
    },
  ];

  return (
    <>
      <LineChart series={series} labels={buckets.map(shortTime)} format={usd} />
      <dl className="totals">
        <div>
          <dt>confirmed</dt>
          <dd>{usd(confirmed.reduce((a, b) => a + b, 0))}</dd>
        </div>
        <div>
          <dt>estimated</dt>
          <dd className="estimated">
            {usd(estimated.reduce((a, b) => a + b, 0))}
          </dd>
        </div>
      </dl>
    </>
  );
}

function HitRateChart({ data }: { data: Awaited<ReturnType<typeof hitRate>> }) {
  if (data.rows.length === 0) {
    return <Empty what="cache activity" error={data.error} />;
  }

  const rows = [...data.rows].sort((a, b) => a.bucket.localeCompare(b.bucket));
  const series: Series[] = [
    {
      label: 'total',
      colour: COLOURS.total,
      values: rows.map((row) => row.hit_rate),
    },
    {
      label: 'exact',
      colour: COLOURS.exact,
      values: rows.map((row) => row.exact_rate),
    },
    {
      label: 'semantic',
      colour: COLOURS.semantic,
      values: rows.map((row) => row.semantic_rate),
    },
  ];

  return (
    <LineChart
      series={series}
      labels={rows.map((row) => shortTime(row.bucket))}
      format={percent}
    />
  );
}

function LatencyTable({ data }: { data: Fetched<LatencyRow> }) {
  if (data.rows.length === 0) {
    return <Empty what="latency" error={data.error} />;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>served by</th>
          <th>outcome</th>
          <th className="num">requests</th>
          <th className="num">p50</th>
          <th className="num">p95</th>
          <th className="num">p99</th>
        </tr>
      </thead>
      <tbody>
        {data.rows.map((row) => (
          <tr key={`${row.provider}-${String(row.cache_hit)}`}>
            <td>{row.provider}</td>
            <td>{row.cache_hit ? 'cache hit' : 'provider call'}</td>
            <td className="num">{row.requests}</td>
            <td className="num" style={{ color: COLOURS.p50 }}>
              {ms(row.p50)}
            </td>
            <td className="num" style={{ color: COLOURS.p95 }}>
              {ms(row.p95)}
            </td>
            <td className="num" style={{ color: COLOURS.p99 }}>
              {ms(row.p99)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProviderTable({
  failures: failureData,
  breakers: breakerData,
}: {
  failures: Awaited<ReturnType<typeof failures>>;
  breakers: Awaited<ReturnType<typeof breakers>>;
}) {
  const names = [
    ...new Set([
      ...breakerData.rows.map((row) => row.provider),
      ...failureData.rows.map((row) => row.provider),
    ]),
  ].sort();

  if (names.length === 0) {
    return (
      <Empty
        what="provider activity"
        error={breakerData.error ?? failureData.error}
      />
    );
  }

  return (
    <table>
      <thead>
        <tr>
          <th>provider</th>
          <th>breaker</th>
          <th className="num">attempts</th>
          <th className="num">failures</th>
          <th className="num">refused by breaker</th>
          <th className="num">failure rate</th>
        </tr>
      </thead>
      <tbody>
        {names.map((name) => {
          const failure = failureData.rows.find((row) => row.provider === name);
          const breaker = breakerData.rows.find((row) => row.provider === name);
          return (
            <tr key={name}>
              <td>{name}</td>
              <td>
                <span
                  className="state"
                  data-state={breaker?.state ?? 'unknown'}
                >
                  {breaker?.state ?? 'unknown'}
                </span>
              </td>
              <td className="num">{failure ? failure.attempts : '—'}</td>
              <td className="num">{failure ? failure.failures : '—'}</td>
              <td className="num">{failure ? failure.circuit_open : '—'}</td>
              <td className="num">
                {failure ? percent(failure.failure_rate) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
