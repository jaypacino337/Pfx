import { config } from "./config.js";
import { refreshIndex, runEpoch, snapshotTick } from "./epoch.js";
import { epochAt } from "./state.js";

const usd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`;

async function printIndex(): Promise<void> {
  const view = await refreshIndex(config);
  console.log(`\nPFX · Pump.fun Index — ${view.screened} coins screened, ${view.hidden.length} outliers hidden\n`);
  console.table(
    view.index.map((c) => ({
      symbol: c.symbol,
      weight: `${(c.weight * 100).toFixed(1)}%`,
      mcap: usd(c.marketCapUsd),
      liquidity: usd(c.liquidityUsd),
      vol24h: usd(c.volume24hUsd),
      "b/s": (c.buys24h / Math.max(1, c.sells24h)).toFixed(2),
      mint: c.mint,
    })),
  );
  console.log("Top hidden outliers:");
  console.table(view.hidden.slice(0, 10).map((h) => ({ symbol: h.symbol, mcap: usd(h.marketCapUsd), why: h.reasons.join("; ") })));
}

async function loop(): Promise<void> {
  const snapMs = config.snapshotMinutes * 60_000;
  console.log(
    `PFX engine · ${config.dryRun ? "DRY RUN" : "LIVE"} · airdrop every ${config.epochMinutes}m · snapshot every ${config.snapshotMinutes}m`,
  );

  let nextEpoch = epochAt(config).nextEpochAt;
  let nextSnap = Date.now();
  await refreshIndex(config).catch((e: Error) => console.error("[index]", e.message));

  for (;;) {
    const now = Date.now();
    if (now >= nextEpoch) {
      await runEpoch(config).catch((e: Error) => console.error("[epoch] failed:", e.stack ?? e.message));
      nextEpoch = epochAt(config).nextEpochAt;
      nextSnap = Date.now() + snapMs;
    } else if (now >= nextSnap) {
      await snapshotTick(config).catch((e: Error) => console.error("[snapshot]", e.message));
      await refreshIndex(config).catch((e: Error) => console.error("[index]", e.message));
      nextSnap = Math.min(now + snapMs, nextEpoch - 30_000);
      if (nextSnap <= now) nextSnap = nextEpoch;
    }
    const wait = Math.max(1_000, Math.min(nextEpoch, nextSnap) - Date.now());
    await new Promise((r) => setTimeout(r, wait));
  }
}

const cmd = process.argv[2] ?? "run";
const commands: Record<string, () => Promise<unknown>> = {
  index: printIndex,
  snapshot: () => snapshotTick(config),
  epoch: () => runEpoch(config),
  run: loop,
};

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}
fn().catch((e: Error) => {
  console.error(e.stack ?? e.message);
  process.exit(1);
});
