import { LineChart } from './chart';
import type { Series } from './chart';
import { breakers, cost, failures, hitRate, latency } from './analytics';
import type { Fetched, LatencyRow } from './analytics';

export const dynamic = 'force-dynamic';

const BUCKET = 'minute';

// data colours match the evaluation suite's charts, the chrome stays ink
const COLOURS = {
  total: '#b6b1a7',
  exact: '#2b6ea3',
  semantic: '#c77d1f',
  confirmed: '#1b7837',
  estimated: '#8256a8',
  p50: '#2b6ea3',
  p95: '#c77d1f',
  p99: '#b2182b',
};

function EmptyState({ what }: { what: string }) {
  return <p className="empty">No {what} recorded in this window.</p>;
}

// a fault must not look like a quiet afternoon: the panel is intact, the data
// source is not, and the interface has to say which one happened
function FaultState({ error }: { error: string }) {
  return (
    <div className="fault">
      <div className="fault-head">
        <span className="fault-dot" />
        analytics unreachable
      </div>
      <div className="fault-body">
        The gateway did not answer this panel&apos;s query. The panel is
        intact; the data source is not.
        <code>{error}</code>
      </div>
    </div>
  );
}

function PanelState({ what, error }: { what: string; error?: string }) {
  return error ? <FaultState error={error} /> : <EmptyState what={what} />;
}

function PanelHead({
  no,
  title,
  children,
}: {
  no: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="panel-head">
      <div className="panel-title">
        <span className="panel-no">{no} /</span>
        <h2>{title}</h2>
      </div>
      {children}
    </div>
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
        <PanelHead no="1" title="Cost over time">
          <CostTotals data={costs} />
        </PanelHead>
        <p className="note">
          Estimated cost is drawn dashed. It comes from a stream that failed
          after emitting text, where the provider billed for output it never
          reported, so the tokens were counted from the characters sent.
        </p>
        <CostChart data={costs} />
      </section>

      <section>
        <PanelHead no="2" title="Cache hit rate">
          <HitTotals data={hits} />
        </PanelHead>
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
        <PanelHead no="3" title="Latency by cache outcome" />
        <p className="note">
          Never aggregated across the cache outcome. A percentile over both
          describes no real population: the two are distributions two orders of
          magnitude apart.
        </p>
        <LatencyTable data={latencies} />
      </section>

      <section>
        <PanelHead no="4" title="Provider health" />
        <p className="note">
          Failure rate is counted over attempts rather than requests, so a
          provider failing behind a working fallback is still visible.
        </p>
        <ProviderTable failures={failureRows} breakers={breakerRows} />
      </section>
    </main>
  );
}

function sumBy<T>(rows: T[], pick: (row: T) => number): number {
  return rows.reduce((total, row) => total + pick(row), 0);
}

function CostTotals({ data }: { data: Awaited<ReturnType<typeof cost>> }) {
  if (data.rows.length === 0) {
    return null;
  }
  const confirmed = sumBy(data.rows, (row) => row.cost_confirmed);
  const estimated = sumBy(data.rows, (row) => row.cost_estimated);
  return (
    <dl className="headline">
      <div>
        <dt>confirmed</dt>
        <dd>{usd(confirmed)}</dd>
      </div>
      <div>
        <dt>estimated</dt>
        <dd className="estimated">{usd(estimated)}</dd>
      </div>
    </dl>
  );
}

function HitTotals({ data }: { data: Awaited<ReturnType<typeof hitRate>> }) {
  const requests = sumBy(data.rows, (row) => row.requests);
  if (requests === 0) {
    return null;
  }
  // window aggregates over the same rows the chart draws, nothing extra fetched
  const rate = sumBy(data.rows, (row) => row.hits) / requests;
  const exact = sumBy(data.rows, (row) => row.exact_hits) / requests;
  const semantic = sumBy(data.rows, (row) => row.semantic_hits) / requests;
  return (
    <dl className="headline">
      <div>
        <dt>window</dt>
        <dd>{percent(rate)}</dd>
      </div>
      <div>
        <dt>exact</dt>
        <dd>{percent(exact)}</dd>
      </div>
      <div>
        <dt>semantic</dt>
        <dd>{percent(semantic)}</dd>
      </div>
    </dl>
  );
}

function CostChart({ data }: { data: Awaited<ReturnType<typeof cost>> }) {
  if (data.rows.length === 0) {
    return <PanelState what="cost" error={data.error} />;
  }

  const buckets = [...new Set(data.rows.map((row) => row.bucket))].sort();
  const confirmed = buckets.map((bucket) =>
    sumBy(
      data.rows.filter((row) => row.bucket === bucket),
      (row) => row.cost_confirmed,
    ),
  );
  const estimated = buckets.map((bucket) =>
    sumBy(
      data.rows.filter((row) => row.bucket === bucket),
      (row) => row.cost_estimated,
    ),
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
    <LineChart series={series} labels={buckets.map(shortTime)} format={usd} />
  );
}

function HitRateChart({ data }: { data: Awaited<ReturnType<typeof hitRate>> }) {
  if (data.rows.length === 0) {
    return <PanelState what="cache activity" error={data.error} />;
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
    return <PanelState what="latency" error={data.error} />;
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
      <PanelState
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
