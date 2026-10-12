import { config, validateConfig } from "./config.js";
import { refreshIndex, runEpoch, snapshotTick } from "./epoch.js";
import { acquireLock, heartbeat, notify } from "./ops.js";
import { preflight } from "./preflight.js";
import { epochAt } from "./state.js";

// Timestamp every log line; production logs are read after the fact.
for (const level of ["log", "warn", "error"] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => orig(new Date().toISOString(), ...args);
}

const usd = (n: number) =>
  n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`;

async function printIndex(): Promise<void> {
  const view = await refreshIndex(config);
  console.log(`PFX · Pump.fun Index: ${view.screened} coins screened, ${view.hidden.length} outliers hidden`);
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

let stopping = false;
let wake: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  if (stopping) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, ms);
    wake = () => {
      clearTimeout(t);
      r();
    };
  });
}

async function loop(): Promise<void> {
  const snapMs = config.snapshotMinutes * 60_000;
  console.log(
    `PFX engine · ${config.dryRun ? "DRY RUN" : "LIVE"} · airdrop every ${config.epochMinutes}m · snapshot every ${config.snapshotMinutes}m`,
  );
  if (!config.dryRun) await notify(config, "PFX engine started (LIVE)");

  let nextEpoch = epochAt(config).nextEpochAt;
  let nextSnap = Date.now();
  let failures = 0;
  await refreshIndex(config).catch((e: Error) => console.error("[index]", e.message));

  while (!stopping) {
    heartbeat(config);
    const now = Date.now();
    if (now >= nextEpoch) {
      try {
        await runEpoch(config);
        failures = 0;
      } catch (e) {
        failures++;
        const msg = (e as Error).stack ?? String(e);
        console.error("[epoch] failed:", msg);
        await notify(config, `PFX epoch failed (${failures} in a row): ${(e as Error).message}`);
      }
      nextEpoch = epochAt(config).nextEpochAt;
      nextSnap = Date.now() + snapMs;
    } else if (now >= nextSnap) {
      await snapshotTick(config).catch((e: Error) => console.error("[snapshot]", e.message));
      await refreshIndex(config).catch((e: Error) => console.error("[index]", e.message));
      nextSnap = Math.min(now + snapMs, nextEpoch - 30_000);
      if (nextSnap <= now) nextSnap = nextEpoch;
    }
    await sleep(Math.max(1_000, Math.min(nextEpoch, nextSnap) - Date.now()));
  }
  console.log("PFX engine stopped cleanly");
}

const cmd = process.argv[2] ?? "run";
const commands: Record<string, () => Promise<unknown>> = {
  index: printIndex,
  snapshot: () => snapshotTick(config),
  epoch: () => runEpoch(config),
  preflight: async () => {
    if (!(await preflight(config))) process.exitCode = 1;
  },
  run: loop,
};

const fn = commands[cmd];
if (!fn) {
  console.error(`Unknown command "${cmd}". Use: ${Object.keys(commands).join(" | ")}`);
  process.exit(1);
}

if (cmd !== "preflight") {
  try {
    validateConfig(config);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

// Anything that moves money takes the lock, so two engines can never overlap.
const release = cmd === "index" || cmd === "preflight" ? () => {} : acquireLock(config);

// SIGTERM/SIGINT: finish the step in progress (never abandon an airdrop midway), then exit.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1);
    console.log(`${sig} received, finishing the current step before exiting (send again to force)`);
    stopping = true;
    wake?.();
  });
}

fn()
  .catch((e: Error) => {
    console.error(e.stack ?? e.message);
    process.exitCode = 1;
  })
  .finally(() => {
    release();
    // Idle keep-alive sockets must not hold the process open after a clean stop.
    setTimeout(() => process.exit(), 500).unref();
  });
