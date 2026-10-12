import { describe, expect, it } from "vitest";
import { robustZ, screen } from "../src/index/outliers.js";
import { capWeights, selectIndex } from "../src/index/selector.js";
import { evaluateEpoch, type Snapshot } from "../src/holders/eligibility.js";
import { allocate } from "../src/airdrop/allocate.js";
import type { Candidate } from "../src/index/types.js";
import type { HolderRules, ScreenFilters } from "../src/config.js";

const NOW = Date.UTC(2026, 9, 12);
const DAY = 86_400_000;

const filters: ScreenFilters = {
  minAgeHours: 72,
  minLiquidityUsd: 250_000,
  minVolume24hUsd: 50_000,
  minSells24h: 200,
  maxBuySellRatio: 4,
  maxMcapToLiquidity: 60,
  madZ: 3.5,
};

function coin(symbol: string, over: Partial<Candidate> = {}): Candidate {
  return {
    mint: `${symbol}mint`,
    symbol,
    name: symbol,
    image: "",
    createdAt: NOW - 30 * DAY,
    marketCapUsd: 50_000_000,
    liquidityUsd: 2_500_000,
    volume24hUsd: 300_000,
    buys24h: 1_000,
    sells24h: 1_000,
    priceUsd: 0.05,
    priceChange24h: 0,
    dex: "pumpswap",
    pairUrl: "",
    ...over,
  };
}

describe("outlier screen", () => {
  it("keeps organic coins and hides wash-traded, unbacked, new and copycat ones", () => {
    const v = screen(
      [
        coin("GOOD"),
        coin("WASH", { buys24h: 74_000, sells24h: 1_400 }),
        coin("FAKE", { marketCapUsd: 1_450_000_000, liquidityUsd: 3_300_000 }),
        coin("BABY", { createdAt: NOW - 5 * 3_600_000 }),
        coin("GOOD", { mint: "copy", liquidityUsd: 900_000 }),
        coin("DRY", { liquidityUsd: 40_000, marketCapUsd: 400_000 }),
      ],
      filters,
      { now: NOW },
    );
    const byMint = Object.fromEntries(v.map((x) => [x.candidate.mint, x]));
    expect(byMint["GOODmint"]!.hidden).toBe(false);
    expect(byMint["WASHmint"]!.reasons.join()).toMatch(/wash buys/);
    expect(byMint["FAKEmint"]!.reasons.join()).toMatch(/unbacked mcap/);
    expect(byMint["BABYmint"]!.reasons.join()).toMatch(/too new/);
    expect(byMint["copy"]!.reasons).toContain("copycat ticker");
    expect(byMint["DRYmint"]!.reasons).toContain("thin liquidity");
  });

  it("excludes the PFX mint itself", () => {
    const [v] = screen([coin("PFX")], filters, { now: NOW, exclude: ["PFXmint"] });
    expect(v!.hidden).toBe(true);
  });

  it("robust z flags the lone extreme value", () => {
    const z = robustZ([1, 1.1, 0.9, 1.05, 0.95, 9]);
    expect(z[5]!).toBeGreaterThan(3.5);
    expect(Math.abs(z[0]!)).toBeLessThan(1);
  });
});

describe("index selection", () => {
  it("picks the top 5 by market cap among survivors, equal weighted", () => {
    const coins = ["A", "B", "C", "D", "E", "F", "G"].map((s, i) =>
      coin(s, { marketCapUsd: (10 - i) * 10_000_000, liquidityUsd: 2_000_000 }),
    );
    const idx = selectIndex(screen(coins, filters, { now: NOW }), 5, "equal", 0.4);
    expect(idx.map((c) => c.symbol)).toEqual(["A", "B", "C", "D", "E"]);
    for (const c of idx) expect(c.weight).toBeCloseTo(0.2);
  });

  it("caps market-cap weights and redistributes the excess", () => {
    const w = capWeights([100, 10, 10, 10, 10], 0.4);
    expect(w[0]).toBeCloseTo(0.4);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(Math.max(...w)).toBeLessThanOrEqual(0.4 + 1e-9);
  });
});

describe("epoch eligibility — no selling in the epoch", () => {
  const rules: HolderRules = { minBalance: 10, maxWalletPct: 100, iqrK: 3, sellTolerance: 0, excludeOwners: ["dev"] };
  const snap = (t: number, balances: Record<string, number>): Snapshot => ({
    takenAt: t,
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, String(v)])),
  });

  const rows = evaluateEpoch(
    [
      snap(0, { holder: 1000, seller: 1000, flipper: 1000, late: 0, dust: 5, dev: 5000, adder: 500 }),
      snap(1, { holder: 1000, seller: 400, flipper: 0, late: 800, dust: 5, dev: 5000, adder: 900 }),
      snap(2, { holder: 1000, seller: 400, flipper: 1000, late: 800, dust: 5, dev: 5000, adder: 900 }),
    ],
    rules,
    { decimals: 0 },
  );
  const status = Object.fromEntries(rows.map((r) => [r.owner, r]));

  it("pays holders who never dipped", () => {
    expect(status.holder!.status).toBe("eligible");
    expect(status.holder!.weight).toBe(1000n);
  });
  it("forfeits anyone who sold", () => expect(status.seller!.status).toBe("sold"));
  it("catches sell-and-rebuy inside the epoch", () => expect(status.flipper!.status).toBe("sold"));
  it("mid-epoch buyers wait for the next epoch", () => expect(status.late!.status).toBe("pending"));
  it("buying more is fine but only the start balance counts", () => {
    expect(status.adder!.status).toBe("eligible");
    expect(status.adder!.weight).toBe(500n);
  });
  it("ignores dust and excluded wallets", () => {
    expect(status.dust!.status).toBe("dust");
    expect(status.dev!.status).toBe("excluded");
  });

  it("clips whale outliers instead of letting them take the pot", () => {
    const balances: Record<string, number> = { whale: 50_000_000 };
    for (let i = 0; i < 20; i++) balances[`h${i}`] = 1_000 + i * 100;
    const r = evaluateEpoch([snap(0, balances), snap(1, balances)], { ...rules, maxWalletPct: 3 }, { decimals: 0 });
    const whale = r.find((x) => x.owner === "whale")!;
    expect(whale.status).toBe("capped");
    const total = r.reduce((a, x) => a + x.weight, 0n);
    expect(Number(whale.weight) / Number(total)).toBeLessThan(0.5);
  });
});

describe("whale fence edge cases", () => {
  it("does not cap a crowd of identical wallets", () => {
    const balances: Record<string, string> = {};
    for (let i = 0; i < 30; i++) balances[`w${i}`] = "498237260035";
    const r = evaluateEpoch(
      [{ takenAt: 0, balances }, { takenAt: 1, balances }],
      { minBalance: 1, maxWalletPct: 10, iqrK: 3, sellTolerance: 0, excludeOwners: [] },
      { decimals: 6 },
    );
    expect(r.every((x) => x.status === "eligible")).toBe(true);
  });
});

describe("allocation", () => {
  it("splits pro rata in integers and never over-sends", () => {
    const { allocations, remainder } = allocate(1_000n, [
      { owner: "a", weight: 1n },
      { owner: "b", weight: 1n },
      { owner: "c", weight: 1n },
    ]);
    expect(allocations.map((a) => a.amount)).toEqual([333n, 333n, 333n]);
    expect(remainder).toBe(1n);
  });

  it("drops shares below the minimum and rolls them over", () => {
    const { allocations, remainder } = allocate(
      1_000n,
      [
        { owner: "big", weight: 99n },
        { owner: "tiny", weight: 1n },
      ],
      50n,
    );
    expect(allocations).toEqual([{ owner: "big", amount: 990n }]);
    expect(remainder).toBe(10n);
  });
});
