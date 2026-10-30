import { performance } from "node:perf_hooks";
const enabled = process.env.PERF_METRICS === "1";
const values = new Map<string, number[]>();
export function measure(name: string, started: number) {
  if (!enabled) return;
  const samples = values.get(name) ?? [];
  samples.push(performance.now() - started);
  if (samples.length > 10000) samples.shift();
  values.set(name, samples);
}
export function flushMetrics() {
  if (!enabled) return;
  for (const [metric, samples] of values) {
    const sorted = [...samples].sort((a, b) => a - b);
    console.log(
      JSON.stringify({
        event: "PERF",
        metric,
        count: samples.length,
        p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
        maxMs: sorted.at(-1),
      }),
    );
  }
}
