export interface Recipient {
  owner: string;
  weight: bigint;
}

export interface Allocation {
  owner: string;
  amount: bigint;
}

/**
 * Split `total` pro rata by weight, in integer base units. Shares below
 * `minUnits` are not sent — they and the rounding dust stay in the keeper and
 * roll into the next epoch, so nothing is ever lost.
 */
export function allocate(
  total: bigint,
  recipients: Recipient[],
  minUnits = 1n,
): { allocations: Allocation[]; remainder: bigint } {
  const totalWeight = recipients.reduce((a, r) => a + r.weight, 0n);
  if (total <= 0n || totalWeight <= 0n) return { allocations: [], remainder: total > 0n ? total : 0n };

  const allocations: Allocation[] = [];
  let sent = 0n;
  for (const r of recipients) {
    if (r.weight <= 0n) continue;
    const amount = (total * r.weight) / totalWeight;
    if (amount < minUnits || amount === 0n) continue;
    allocations.push({ owner: r.owner, amount });
    sent += amount;
  }
  return { allocations, remainder: total - sent };
}
