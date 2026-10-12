import { describe, expect, it } from "vitest";
import { feePerRecipient, planSends } from "../src/airdrop/plan.js";

describe("send planning", () => {
  const base = {
    rentLamports: 2_039_280,
    feeLamportsPerRecipient: 2_000,
    unitUsd: 1e-6, // 1 token = $1
    minNewAccountUsd: 0.44,
  };

  it("skips new accounts whose drop is worth less than the rent, but pays existing ones", () => {
    const plan = planSends({
      ...base,
      allocations: [
        { owner: "big-new", amount: 5_000_000n },
        { owner: "small-new", amount: 100_000n },
        { owner: "small-old", amount: 100_000n },
      ],
      hasAccount: (o) => o.endsWith("old"),
      availableLamports: 1e9,
    });
    expect(plan.send.map((a) => a.owner)).toEqual(["big-new", "small-old"]);
    expect(plan.skipped[0]).toMatchObject({ owner: "small-new", reason: "worth less than account rent" });
    expect(plan.newAccounts).toBe(1);
  });

  it("stops before the keeper runs out of gas and defers the rest", () => {
    const plan = planSends({
      ...base,
      allocations: [1, 2, 3].map((i) => ({ owner: `new${i}`, amount: 5_000_000n })),
      hasAccount: () => false,
      availableLamports: 2 * (2_039_280 + 2_000),
    });
    expect(plan.send).toHaveLength(2);
    expect(plan.skipped[0]!.reason).toBe("keeper low on SOL");
  });
});

describe("fee estimate", () => {
  it("covers base fee and priority fee per recipient", () => {
    expect(feePerRecipient(5, 50_000)).toBe(Math.ceil((5_000 + Math.ceil((50_000 * 220_000) / 1e6)) / 5));
  });
});
