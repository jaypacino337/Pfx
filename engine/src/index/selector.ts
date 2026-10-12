import type { Weighting } from "../config.js";
import type { Constituent, Verdict } from "./types.js";

/**
 * Cap any weight at `max` and hand the excess to the uncapped names, pro rata,
 * until nothing exceeds the cap. Weights always sum to 1.
 */
export function capWeights(raw: number[], max: number): number[] {
  const n = raw.length;
  if (n === 0) return [];
  const cap = Math.max(max, 1 / n);
  const total = raw.reduce((a, b) => a + b, 0);
  let w = raw.map((x) => (total > 0 ? x / total : 1 / n));
  const capped = new Array<boolean>(n).fill(false);

  for (let iter = 0; iter < n; iter++) {
    let excess = 0;
    w = w.map((x, i) => {
      if (x > cap + 1e-12) {
        excess += x - cap;
        capped[i] = true;
        return cap;
      }
      return x;
    });
    if (excess <= 1e-12) break;
    const freeTotal = w.reduce((a, x, i) => (capped[i] ? a : a + x), 0);
    if (freeTotal <= 0) break;
    w = w.map((x, i) => (capped[i] ? x : x + (excess * x) / freeTotal));
  }
  return w;
}

export function selectIndex(
  verdicts: Verdict[],
  size: number,
  weighting: Weighting,
  maxWeight: number,
): Constituent[] {
  const picks = verdicts
    .filter((v) => !v.hidden)
    .map((v) => v.candidate)
    .sort((a, b) => b.marketCapUsd - a.marketCapUsd)
    .slice(0, size);

  const raw = picks.map((c) => (weighting === "mcap" ? c.marketCapUsd : 1));
  const weights = capWeights(raw, maxWeight);
  return picks.map((c, i) => ({ ...c, weight: weights[i]! }));
}
