export interface Series {
  label: string;
  colour: string;
  values: number[];
  dashed?: boolean;
}

interface LineChartProps {
  series: Series[];
  labels: string[];
  format: (value: number) => string;
  height?: number;
}

const WIDTH = 720;
const PADDING = { top: 12, right: 12, bottom: 24, left: 52 };

/**
 * a line chart drawn as inline svg
 *
 * no chart library: these are a handful of series over a shared x axis, and a
 * dependency that renders differently between server and client is a poor
 * trade for that
 */
export function LineChart({
  series,
  labels,
  format,
  height = 220,
}: LineChartProps) {
  const points = Math.max(...series.map((s) => s.values.length), 0);
  if (points === 0) {
    return null;
  }

  const max = Math.max(...series.flatMap((s) => s.values), 0);
  const ceiling = max === 0 ? 1 : max * 1.1;
  const plotWidth = WIDTH - PADDING.left - PADDING.right;
  const plotHeight = height - PADDING.top - PADDING.bottom;

  const x = (index: number) =>
    PADDING.left +
    (points === 1 ? plotWidth / 2 : (index / (points - 1)) * plotWidth);
  const y = (value: number) =>
    PADDING.top + plotHeight - (value / ceiling) * plotHeight;

  const ticks = [0, 0.5, 1].map((fraction) => ceiling * fraction);

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${WIDTH} ${height}`} role="img">
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={y(tick)}
              y2={y(tick)}
              className="grid"
            />
            <text
              x={PADDING.left - 8}
              y={y(tick) + 4}
              className="axis"
              textAnchor="end"
            >
              {format(tick)}
            </text>
          </g>
        ))}

        {series.map((line) => (
          <g key={line.label}>
            <polyline
              fill="none"
              stroke={line.colour}
              strokeWidth={2}
              strokeDasharray={line.dashed ? '5 4' : undefined}
              points={line.values
                .map((value, index) => `${x(index)},${y(value)}`)
                .join(' ')}
            />
            {!line.dashed && line.values.length > 0 && (
              <circle
                cx={x(line.values.length - 1)}
                cy={y(line.values[line.values.length - 1])}
                r={3}
                fill={line.colour}
              />
            )}
          </g>
        ))}

        {labels.length > 0 && (
          <>
            <text x={PADDING.left} y={height - 6} className="axis">
              {labels[0]}
            </text>
            <text
              x={WIDTH - PADDING.right}
              y={height - 6}
              className="axis"
              textAnchor="end"
            >
              {labels[labels.length - 1]}
            </text>
          </>
        )}
      </svg>

      <figcaption className="legend">
        {series.map((line) => (
          <span key={line.label}>
            <i style={{ background: line.colour }} data-dashed={line.dashed} />
            {line.label}{' '}
            <b>{format(line.values[line.values.length - 1])}</b>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
