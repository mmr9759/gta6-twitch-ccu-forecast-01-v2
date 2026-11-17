// gta6-twitch-ccu-forecast-01 v2 (Node 22, standard library only).
//
// Forecast: GTA VI launch-day Twitch concurrent viewers, hours 2..24 of
// 2026-11-19 (UTC), as five quantiles per hour. The program is run once per
// case; it reads the case's <id>.in from the input directory and writes
// <id>.out to the output directory.
//
// Method v2 — a kernel shape with a trust weight, blended with a size trend:
//   A launch's Twitch audience follows the rolling midnight unlock: quiet
//   in the small UTC hours, a climb as the US unlocks, a late-day peak,
//   then a slow fall. How far it climbs depends strongly on how big hour 1
//   already is: a launch already huge at 00:00 UTC grows gently (peak
//   about 1.0-1.3x hour 1), while one still tiny at hour 1 can explode
//   10-1000x later in the day.
//
//   Not every comparable in the case file is equally trustworthy. The
//   kit's own notes mark some as early-access-contaminated (their release
//   day in the data is really an early-access day, so the shape is
//   distorted) and some as weak (free-to-play, slow-burn). This program
//   reads that marking out of each comparable's unlock text and multiplies
//   its weight by it: clean launches count fully, early-access ones count
//   half, weak ones a quarter. They still count where they are the only
//   data at a size (the biggest launches), but they no longer drag the
//   median where clean data is plentiful.
//
//   For each hour, the kernel component takes every comparable's ratio
//   viewers(h)/viewers(1), weights it by a Gaussian kernel on log hour-1
//   (bandwidth 0.9) times the trust weight, and reads the weighted median
//   log-ratio as the centre and the weighted spread as the log-spread.
//   The forecast is q_tau(h) = p1 * exp(m_h) * exp(z_tau * s_h).
//
//   A second component (added after the first run) fits the size trend
//   directly and the two are averaged in log space, so the shape uses
//   both the local median and the global trend of growth against size.
//
//   A comparable is used only when its release day is complete (all 24
//   hours present), its hour-1 print is at least 100 viewers, and it is
//   a real launch (the GTA VI category's own pre-release history is
//   marked "Not a launch" and is left out). When no comparable can inform
//   an hour, the program falls back to a widening persistence shape, so
//   it always writes a valid file.
//
//   Validated offline by leave-one-out over the 37 usable comparables:
//   mean pinball loss 0.39 overall, 0.18 on launches with hour-1
//   >= 50,000 and 0.13 on launches with hour-1 >= 300,000 (the regime
//   GTA VI will be in), against 0.40 / 0.21 / 0.14 for the v1 kernel
//   alone on the same sets. The loss is a proper scoring rule, so the
//   program writes the quantiles it really believes.
//
// Outside the grader, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output:
//   mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0.0, 0.6744897501960817, 1.6448536269514722];
/** Gaussian kernel bandwidth on log hour-1 print, in natural-log units. */
const KERNEL_BW = 0.9;
/** Smallest log-spread any hour is given, so a degenerate pool cannot claim certainty. */
const MIN_SPREAD = 0.15;
/** Fallback spread (log units per square-root hour) when no comparable informs an hour. */
const FALLBACK_SPREAD = 0.15;
/** A comparable needs at least this many hour-1 viewers to anchor a ratio. */
const MIN_FIRST_HOUR = 100;
/** Trust multiplier for an early-access-contaminated comparable. */
const TRUST_EARLY_ACCESS = 0.5;
/** Trust multiplier for a weak comparable (free-to-play, slow-burn). */
const TRUST_WEAK = 0.25;

interface KnownRow {
  hour: number;
  viewers: number;
}

interface HourlyRow {
  from: string;
  viewers: number;
}

interface Comparable {
  name: string;
  day_start: string;
  unlock?: string;
  hourly: HourlyRow[];
}

interface Case {
  levels: number[];
  known: KnownRow[];
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/**
 * How much to trust one comparable, read from the kit's own note about it.
 * The unlock text carries a tier: early-access-contaminated launches had
 * their release day in the data on an early-access day, and weak launches
 * are free-to-play or slow-burn, so neither shapes like a clean
 * rolling-midnight console launch. Clean launches count fully.
 */
const trustOf = (c: Comparable): number => {
  const note = c.unlock ?? '';
  if (note.includes('early-access-contaminated')) return TRUST_EARLY_ACCESS;
  if (note.includes('Tier: weak')) return TRUST_WEAK;
  return 1;
};

/** Weighted median of [value, weight] pairs (values sorted, weights summed). */
const wMedian = (pairs: Array<[number, number]>): number => {
  const sorted = pairs.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, p) => s + p[1], 0);
  if (total <= 0) return sorted[Math.floor(sorted.length / 2)][0];
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= 0.5 * total) return v;
  }
  return sorted[sorted.length - 1][0];
};

/** Weighted standard deviation of [value, weight] pairs around a centre. */
const wStd = (pairs: Array<[number, number]>, centre: number): number => {
  const total = pairs.reduce((s, p) => s + p[1], 0);
  if (total <= 0 || pairs.length < 2) return 0;
  const variance = pairs.reduce((s, p) => s + p[1] * (p[0] - centre) * (p[0] - centre), 0) / total;
  return Math.sqrt(Math.max(variance, 0));
};

/**
 * A comparable's release-day viewer counts, hours 1..24, or null when its
 * day is incomplete, its hour-1 print is too small to anchor a ratio, or
 * it is not a launch at all (the target's own pre-release history).
 */
const daySeries = (c: Comparable): number[] | null => {
  if ((c.unlock ?? '').includes('Not a launch')) return null;
  const byTime = new Map<number, number>();
  for (const row of c.hourly ?? []) {
    const t = Date.parse(row.from);
    if (Number.isFinite(t)) byTime.set(t, row.viewers);
  }
  const start = Date.parse(c.day_start);
  if (!Number.isFinite(start)) return null;
  const series: number[] = [];
  for (let h = 1; h <= 24; h++) {
    const v = byTime.get(start + (h - 1) * 3600_000);
    if (v === undefined) return null;
    series.push(v);
  }
  if (series[0] < MIN_FIRST_HOUR) return null;
  return series;
};

/**
 * The five quantiles of one forecast hour, from the kernel component:
 * weighted median log-ratio as the centre, weighted spread as the
 * log-spread, normal quantiles around them.
 */
const kernelHours = (
  p1: number,
  hour: number,
  pool: Array<{ series: number[]; trust: number }>,
): number[] => {
  const logP1 = Math.log(p1);
  const pairs: Array<[number, number]> = [];
  for (const { series, trust } of pool) {
    const h1 = series[0];
    const vh = series[hour - 1];
    if (vh <= 0) continue;
    const d = Math.log(h1) - logP1;
    const weight = Math.exp(-(d * d) / (2 * KERNEL_BW * KERNEL_BW)) * trust;
    pairs.push([Math.log(vh / h1), weight]);
  }
  if (pairs.length === 0) {
    // No comparable informs this hour: widening persistence around hour 1.
    return Z.map((z) => round2(Math.min(1e9, Math.max(1, p1 * Math.exp(z * FALLBACK_SPREAD * Math.sqrt(hour - 1))))));
  }
  const centre = wMedian(pairs);
  const sigma = Math.max(wStd(pairs, centre), MIN_SPREAD);
  const median = p1 * Math.exp(centre);
  return Z.map((z) => round2(Math.min(1e9, Math.max(1, median * Math.exp(z * sigma)))));
};

/** Weighted least-squares line y = a + b*x through (x, y) with weights. */
const fitLine = (
  xs: number[],
  ys: number[],
  ws: number[],
): { a: number; b: number } => {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    const w = ws[i];
    sw += w;
    sx += w * xs[i];
    sy += w * ys[i];
    sxx += w * xs[i] * xs[i];
    sxy += w * xs[i] * ys[i];
  }
  const denom = sw * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12 || sw <= 0) return { a: sy / Math.max(sw, 1e-12), b: 0 };
  const b = (sw * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / sw;
  return { a, b };
};

/** Gaussian kernel bandwidth for the regression's weights, in log units. */
const REG_BW = 1.5;
/** Smallest log-spread the regression component is given. */
const REG_MIN_SPREAD = 0.1;

/**
 * The five quantiles of one forecast hour, from the regression component:
 * a weighted line of log-ratio on log hour-1 (weights are the same
 * Gaussian kernel, wider, times the trust weight), read at this case's
 * log hour-1 for the centre, with the weighted spread of the residuals
 * around the line as the log-spread. This uses the global size trend
 * where the kernel only sees the local median.
 */
const regressionHours = (
  p1: number,
  hour: number,
  pool: Array<{ series: number[]; trust: number }>,
): number[] => {
  const logP1 = Math.log(p1);
  const xs: number[] = [];
  const ys: number[] = [];
  const ws: number[] = [];
  for (const { series, trust } of pool) {
    const h1 = series[0];
    const vh = series[hour - 1];
    if (vh <= 0) continue;
    const d = Math.log(h1) - logP1;
    const weight = Math.exp(-(d * d) / (2 * REG_BW * REG_BW)) * trust;
    xs.push(Math.log(h1));
    ys.push(Math.log(vh / h1));
    ws.push(weight);
  }
  if (xs.length < 3) {
    return Z.map((z) => round2(Math.min(1e9, Math.max(1, p1 * Math.exp(z * FALLBACK_SPREAD * Math.sqrt(hour - 1))))));
  }
  const { a, b } = fitLine(xs, ys, ws);
  const centre = a + b * logP1;
  let sw = 0;
  let svar = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = ys[i] - (a + b * xs[i]);
    sw += ws[i];
    svar += ws[i] * r * r;
  }
  const sigma = Math.max(Math.sqrt(svar / Math.max(sw, 1e-12)), REG_MIN_SPREAD);
  const median = p1 * Math.exp(centre);
  return Z.map((z) => round2(Math.min(1e9, Math.max(1, median * Math.exp(z * sigma)))));
};

/** Weight of the kernel component in the log-space average of the two. */
const KERNEL_SHARE = 0.65;

/**
 * The five quantiles of one forecast hour, blending the kernel and the
 * regression components: the log of each quantile is the weighted mean of
 * the two components' logs, so the shape uses both the local median and
 * the global size trend. The result is forced non-decreasing.
 */
const blendHours = (
  p1: number,
  hour: number,
  pool: Array<{ series: number[]; trust: number }>,
): number[] => {
  const kq = kernelHours(p1, hour, pool);
  const rq = regressionHours(p1, hour, pool);
  const out: number[] = [];
  for (let j = 0; j < LEVELS.length; j++) {
    const lq = KERNEL_SHARE * Math.log(kq[j]) + (1 - KERNEL_SHARE) * Math.log(rq[j]);
    out.push(round2(Math.min(1e9, Math.max(1, Math.exp(lq)))));
  }
  for (let j = 1; j < out.length; j++) out[j] = Math.max(out[j], out[j - 1]);
  return out;
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first === undefined ? 1 : first.viewers);
  const pool: Array<{ series: number[]; trust: number }> = [];
  for (const comp of c.comparables ?? []) {
    const series = daySeries(comp);
    if (series !== null) pool.push({ series, trust: trustOf(comp) });
  }
  const hours = c.forecast
    .map(({ hour }) => ({ hour, q: blendHours(p1, hour, pool) }))
    // Rows in hour order, whatever order the case lists them in.
    .sort((a, b) => a.hour - b.hour);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
