import type { Allocation } from "./allocate.js";

export interface PlanInput {
  /** Largest first, so a short gas budget pays the biggest holders first. */
  allocations: Allocation[];
  hasAccount: (owner: string) => boolean;
  /** Rent for one new holder token account. */
  rentLamports: number;
  /** Tx fee + priority fee per recipient. */
  feeLamportsPerRecipient: number;
  /** Keeper SOL above the gas floor. */
  availableLamports: number;
  /** USD value of one base unit of the token. */
  unitUsd: number;
  /** Only open a new token account if the drop is worth at least this much. */
  minNewAccountUsd: number;
}

export interface Skipped extends Allocation {
  reason: "worth less than account rent" | "keeper low on SOL";
}

export interface Plan {
  send: Allocation[];
  skipped: Skipped[];
  lamports: number;
  newAccounts: number;
}

/**
 * Decide who actually gets sent to this epoch. Opening a token account costs
 * ~0.002 SOL of rent, so a holder without one only gets a drop that's worth
 * clearly more than that; and the plan never spends past the keeper's gas.
 * Everything skipped stays in the keeper and rolls into the next epoch.
 */
export function planSends(p: PlanInput): Plan {
  const plan: Plan = { send: [], skipped: [], lamports: 0, newAccounts: 0 };
  for (const a of p.allocations) {
    const isNew = !p.hasAccount(a.owner);
    if (isNew && Number(a.amount) * p.unitUsd < p.minNewAccountUsd) {
      plan.skipped.push({ ...a, reason: "worth less than account rent" });
      continue;
    }
    const cost = p.feeLamportsPerRecipient + (isNew ? p.rentLamports : 0);
    if (plan.lamports + cost > p.availableLamports) {
      plan.skipped.push({ ...a, reason: "keeper low on SOL" });
      continue;
    }
    plan.send.push(a);
    plan.lamports += cost;
    if (isNew) plan.newAccounts++;
  }
  return plan;
}

export function feePerRecipient(batch: number, priorityMicroLamports: number): number {
  const cu = 40_000 * batch + 20_000;
  const perTx = 5_000 + Math.ceil((priorityMicroLamports * cu) / 1_000_000);
  return Math.ceil(perTx / batch);
}
