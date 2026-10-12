import type { HolderRules } from "../config.js";

/** Raw token balances (base units, as strings so they survive JSON) at one moment. */
export interface Snapshot {
  takenAt: number;
  balances: Record<string, string>;
}

export type HolderStatus =
  | "eligible" // held the whole epoch, gets paid
  | "capped" // eligible, but a whale outlier: weight clipped to the fence
  | "sold" // balance dipped below the epoch-start balance: forfeits this epoch
  | "pending" // arrived mid-epoch: starts counting next epoch
  | "dust" // below the minimum balance
  | "excluded"; // pool, bonding curve, program vault, dev/treasury

export interface HolderRow {
  owner: string;
  status: HolderStatus;
  start: bigint;
  min: bigint;
  end: bigint;
  /** Airdrop weight. Zero for everyone not eligible/capped. */
  weight: bigint;
}

export function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * The PFX rule: hold through the whole epoch without selling and you are paid on
 * the balance you held. Any dip below your epoch-start balance — a sell, or a
 * transfer out — forfeits the epoch. Buying mid-epoch is never punished, but new
 * tokens only start counting at the next epoch, so sniping the drop is pointless.
 */
export function evaluateEpoch(
  snapshots: Snapshot[],
  rules: HolderRules,
  ctx: { decimals: number; offCurve?: Iterable<string> },
): HolderRow[] {
  if (snapshots.length === 0) return [];
  const first = snapshots[0]!;
  const last = snapshots[snapshots.length - 1]!;
  const excluded = new Set([...rules.excludeOwners, ...(ctx.offCurve ?? [])]);
  const minUnits = BigInt(Math.round(rules.minBalance)) * 10n ** BigInt(ctx.decimals);

  const owners = new Set<string>();
  for (const s of snapshots) for (const o of Object.keys(s.balances)) owners.add(o);

  const rows: HolderRow[] = [];
  for (const owner of owners) {
    const start = BigInt(first.balances[owner] ?? "0");
    const end = BigInt(last.balances[owner] ?? "0");
    let min = start;
    for (const s of snapshots) {
      const b = BigInt(s.balances[owner] ?? "0");
      if (b < min) min = b;
    }
    const tolerance = (start * BigInt(Math.round(rules.sellTolerance * 1e6))) / 1_000_000n;

    let status: HolderStatus;
    if (excluded.has(owner)) status = "excluded";
    else if (start === 0n) status = "pending";
    else if (min + tolerance < start) status = "sold";
    else if (min < minUnits) status = "dust";
    else status = "eligible";

    rows.push({ owner, status, start, min, end, weight: status === "eligible" ? min : 0n });
  }

  capWhales(rows, rules);
  return rows.sort((a, b) => (b.weight > a.weight ? 1 : b.weight < a.weight ? -1 : 0));
}

/**
 * Whale outliers are not removed — they still get paid — but their weight is
 * clipped to the lower of (a) maxWalletPct of eligible supply and (b) an IQR
 * fence on log10(balance). One wallet can't vacuum up the airdrop.
 */
function capWhales(rows: HolderRow[], rules: HolderRules): void {
  const eligible = rows.filter((r) => r.status === "eligible");
  if (eligible.length === 0) return;

  const total = eligible.reduce((a, r) => a + r.weight, 0n);
  let cap = (total * BigInt(Math.round(rules.maxWalletPct * 100))) / 10_000n;

  if (eligible.length >= 8) {
    const logs = eligible.map((r) => Math.log10(Number(r.weight))).sort((a, b) => a - b);
    const q1 = quantile(logs, 0.25);
    const q3 = quantile(logs, 0.75);
    const fence = 10 ** (q3 + rules.iqrK * (q3 - q1));
    // Zero spread (e.g. a farm of identical wallets) gives no fence to speak of.
    if (q3 - q1 > 1e-9 && Number.isFinite(fence) && fence < Number.MAX_SAFE_INTEGER) {
      const fenceUnits = BigInt(Math.ceil(fence));
      if (fenceUnits < cap) cap = fenceUnits;
    }
  }
  if (cap <= 0n) return;

  for (const r of eligible) {
    if (r.weight > cap) {
      r.weight = cap;
      r.status = "capped";
    }
  }
}

export function summarize(rows: HolderRow[]): Record<HolderStatus, number> & { tracked: number } {
  const out = { tracked: rows.length, eligible: 0, capped: 0, sold: 0, pending: 0, dust: 0, excluded: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}
