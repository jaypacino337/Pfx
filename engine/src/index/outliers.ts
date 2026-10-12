import type { ScreenFilters } from "../config.js";
import type { Candidate, Verdict } from "./types.js";

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Robust z-scores (Iglewicz & Hoaglin). Unlike mean/stddev, one absurd value
 * cannot drag the baseline toward itself and hide.
 */
export function robustZ(values: number[]): number[] {
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  if (!mad) return values.map(() => 0);
  return values.map((v) => (0.6745 * (v - m)) / mad);
}

/**
 * Hide every coin whose numbers can't be trusted. A coin passes only if it is
 * old enough, liquid, traded both ways, and its market cap is actually backed
 * by its pool. Copycat tickers keep only their deepest pool.
 */
export function screen(
  candidates: Candidate[],
  f: ScreenFilters,
  opts: { now?: number; exclude?: Iterable<string> } = {},
): Verdict[] {
  const now = opts.now ?? Date.now();
  const exclude = new Set(opts.exclude ?? []);

  const verdicts: Verdict[] = candidates.map((c) => {
    const reasons: string[] = [];
    const ageH = (now - c.createdAt) / 3_600_000;
    const ratio = c.sells24h > 0 ? c.buys24h / c.sells24h : Infinity;
    const backing = c.liquidityUsd > 0 ? c.marketCapUsd / c.liquidityUsd : Infinity;

    if (exclude.has(c.mint)) reasons.push("excluded");
    if (c.banned) reasons.push("banned on pump.fun");
    if (c.nsfw) reasons.push("nsfw");
    if (ageH < f.minAgeHours) reasons.push(`too new (${ageH.toFixed(0)}h)`);
    if (c.liquidityUsd < f.minLiquidityUsd) reasons.push("thin liquidity");
    if (c.volume24hUsd < f.minVolume24hUsd) reasons.push("low volume");
    if (c.sells24h < f.minSells24h) reasons.push("almost no sells");
    if (ratio > f.maxBuySellRatio) reasons.push(`wash buys (${fmtRatio(ratio)}:1)`);
    if (backing > f.maxMcapToLiquidity) reasons.push(`unbacked mcap (${fmtRatio(backing)}x liq)`);

    return { candidate: c, hidden: reasons.length > 0, reasons };
  });

  // Copycats: same ticker, keep the deepest pool among the ones still standing.
  const bySymbol = new Map<string, Verdict[]>();
  for (const v of verdicts) {
    const key = v.candidate.symbol.trim().toUpperCase();
    bySymbol.set(key, [...(bySymbol.get(key) ?? []), v]);
  }
  for (const group of bySymbol.values()) {
    if (group.length < 2) continue;
    const standing = group.filter((v) => !v.hidden);
    const keep = (standing.length ? standing : group).reduce((a, b) =>
      b.candidate.liquidityUsd > a.candidate.liquidityUsd ? b : a,
    );
    for (const v of group) {
      if (v !== keep) {
        v.hidden = true;
        v.reasons.push("copycat ticker");
      }
    }
  }

  // Statistical pass over whatever survived the hard rules.
  const survivors = verdicts.filter((v) => !v.hidden);
  if (survivors.length >= 5) {
    const z = robustZ(survivors.map((v) => Math.log(v.candidate.marketCapUsd / v.candidate.liquidityUsd)));
    survivors.forEach((v, i) => {
      if (z[i]! > f.madZ) {
        v.hidden = true;
        v.reasons.push(`statistical outlier (z=${z[i]!.toFixed(1)})`);
      }
    });
  }

  return verdicts;
}

function fmtRatio(n: number): string {
  if (!Number.isFinite(n)) return "∞";
  return n >= 10 ? n.toFixed(0) : n.toFixed(1);
}
