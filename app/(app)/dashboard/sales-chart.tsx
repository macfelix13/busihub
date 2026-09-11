import { bucketLabel, type Period } from "@/lib/reports/period";

/**
 * The sales chart, drawn as plain SVG on the server.
 *
 * No charting library, and no client component: this is a bar per bucket
 * and two numbers per bar, and shipping a hundred kilobytes of JavaScript
 * to a shop on a phone tethered to mobile data to draw it would be a poor
 * trade. It also means the chart is in the first HTML response rather
 * than appearing a second later.
 *
 * The series arrives already gap-filled from sales_trend(), so a quiet
 * day is a zero-height bar sitting on the baseline rather than a missing
 * one — a chart that closes the gap draws a straight line through a dead
 * week and flatters it.
 *
 * A bucket CAN be negative: refunds are subtracted from the day they were
 * given, so a big return on a slow day puts the bar below the line. That
 * is a real thing that happens in a shop, so the axis is drawn to
 * accommodate it rather than clamping it away.
 */

export interface TrendPoint {
  bucket_start: string;
  sale_count: number | string;
  net_total: number | string;
  gross_profit: number | string;
}

interface SalesChartProps {
  points: TrendPoint[];
  period: Period;
  /** Formats a number as money in the business's currency. */
  money: (amount: number | string | undefined) => string;
  showProfit: boolean;
}

const HEIGHT = 160;
const GAP = 2;

export function SalesChart({ points, period, money, showProfit }: SalesChartProps) {
  if (points.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-neutral-500 dark:text-ink-muted">No sales in this period yet.</p>
    );
  }

  const nets = points.map((p) => Number(p.net_total ?? 0));
  const profits = points.map((p) => Number(p.gross_profit ?? 0));
  const values = showProfit ? [...nets, ...profits] : nets;

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  // Where zero sits, top-down. With no negatives this is the floor.
  const zeroY = ((max - 0) / span) * HEIGHT;
  const bandWidth = 100 / points.length;
  const barWidth = Math.max(bandWidth - GAP, bandWidth * 0.4);

  // A dense series (90 days, a year of weeks) cannot show every label
  // without them overlapping into a grey smear.
  const labelEvery = Math.ceil(points.length / 7);

  const everythingIsZero = values.every((v) => v === 0);

  return (
    // animate-fade-in (added in the UI polish pass) is a pure CSS
    // @keyframes animation — it plays automatically on first paint even
    // for server-rendered markup like this, so the chart gets a smooth
    // entrance with zero client-side JavaScript, preserving the
    // no-charting-library, server-rendered-SVG approach described above.
    <div className="animate-fade-in">
      <div className="flex items-baseline justify-between text-xs text-neutral-500 dark:text-ink-muted">
        <span>{money(min < 0 ? min : 0)}</span>
        <span>{money(max)}</span>
      </div>

      <svg
        viewBox={`0 0 100 ${HEIGHT}`}
        preserveAspectRatio="none"
        className="mt-1 h-40 w-full"
        role="img"
        aria-label={`Sales per ${period.bucket} for ${period.label}`}
      >
        {/* The zero line, so a negative bucket is unmistakably below it. */}
        <line
          x1="0"
          x2="100"
          y1={zeroY}
          y2={zeroY}
          stroke="currentColor"
          strokeWidth="0.5"
          className="text-neutral-300 dark:text-surface-line"
          vectorEffect="non-scaling-stroke"
        />

        {points.map((point, index) => {
          const net = Number(point.net_total ?? 0);
          const profit = Number(point.gross_profit ?? 0);
          const x = index * bandWidth + (bandWidth - barWidth) / 2;

          const netTop = ((max - Math.max(net, 0)) / span) * HEIGHT;
          const netHeight = everythingIsZero ? 0 : Math.abs((net / span) * HEIGHT);
          const netY = net >= 0 ? netTop : zeroY;

          const profitTop = ((max - Math.max(profit, 0)) / span) * HEIGHT;
          const profitHeight = everythingIsZero ? 0 : Math.abs((profit / span) * HEIGHT);
          const profitY = profit >= 0 ? profitTop : zeroY;

          return (
            <g key={point.bucket_start}>
              <rect
                x={x}
                y={netY}
                width={barWidth}
                height={Math.max(netHeight, net === 0 ? 0 : 1)}
                rx="0.6"
                className={net < 0 ? "fill-red-400 dark:fill-red-500" : "fill-brand-500"}
              >
                <title>
                  {bucketLabel(point.bucket_start, period.bucket, period.timezone)} —{" "}
                  {money(net)} from {Number(point.sale_count ?? 0)}{" "}
                  {Number(point.sale_count ?? 0) === 1 ? "sale" : "sales"}
                  {showProfit ? `, ${money(profit)} profit` : ""}
                </title>
              </rect>
              {showProfit ? (
                <rect
                  x={x + barWidth * 0.25}
                  y={profitY}
                  width={barWidth * 0.5}
                  height={Math.max(profitHeight, profit === 0 ? 0 : 1)}
                  rx="0.4"
                  className={profit < 0 ? "fill-red-700 dark:fill-red-300" : "fill-lime-500 dark:fill-lime-400"}
                  opacity="0.85"
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      <div className="mt-1 flex text-[10px] text-neutral-500 dark:text-ink-muted">
        {points.map((point, index) => (
          <span
            key={point.bucket_start}
            className="overflow-hidden text-ellipsis whitespace-nowrap text-center"
            style={{ width: `${bandWidth}%` }}
          >
            {index % labelEvery === 0 ? bucketLabel(point.bucket_start, period.bucket, period.timezone) : ""}
          </span>
        ))}
      </div>

      {showProfit ? (
        <div className="mt-3 flex flex-wrap gap-4 text-xs text-neutral-500 dark:text-ink-muted">
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-brand-500" aria-hidden="true" /> Net sales
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-lime-500 dark:bg-lime-400" aria-hidden="true" /> Gross
            profit
          </span>
        </div>
      ) : null}
    </div>
  );
}