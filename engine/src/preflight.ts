import fs from "node:fs";
import path from "node:path";
import { PublicKey, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import type { Config } from "./config.js";
import { connect, loadKeeper, solBalance } from "./chain/wallet.js";
import { quoteBuy } from "./chain/swap.js";
import { pumpCreator } from "./chain/pump.js";
import { getMintInfo, takeSnapshot } from "./holders/snapshot.js";
import { screenIndex } from "./epoch.js";

type Status = "PASS" | "WARN" | "FAIL";
interface Check {
  status: Status;
  check: string;
  detail: string;
}

/**
 * Go/no-go before flipping DRY_RUN=false. Read-only: simulates the fee claim
 * and builds a swap, but never signs or sends anything.
 */
export async function preflight(cfg: Config): Promise<boolean> {
  const results: Check[] = [];
  const add = (status: Status, check: string, detail: string) => {
    results.push({ status, check, detail });
    console.log(`${status === "PASS" ? "✔" : status === "WARN" ? "!" : "✖"} ${status.padEnd(4)} ${check}: ${detail}`);
  };
  const step = async (check: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      add("FAIL", check, (e as Error).message.slice(0, 200));
    }
  };

  console.log(`PFX preflight · ${cfg.dryRun ? "DRY_RUN=true" : "DRY_RUN=false (LIVE)"}\n`);
  add(cfg.dryRun ? "WARN" : "PASS", "Mode", cfg.dryRun ? "dry run: nothing will be signed until DRY_RUN=false" : "live");

  const conn: Connection = connect(cfg);
  let keeper: Keypair | null = null;

  await step("RPC", async () => {
    const t = Date.now();
    const [version, slot] = await Promise.all([conn.getVersion(), conn.getSlot()]);
    const ms = Date.now() - t;
    const publicRpc = cfg.rpcUrl.includes("api.mainnet-beta.solana.com");
    add(publicRpc ? "WARN" : "PASS", "RPC", `${version["solana-core"]} · slot ${slot} · ${ms}ms${publicRpc ? " · public RPC is rate-limited, use a paid one" : ""}`);
  });

  try {
    keeper = loadKeeper(cfg);
  } catch (e) {
    add(cfg.dryRun ? "WARN" : "FAIL", "Keeper wallet", (e as Error).message);
  }
  if (keeper) await step("Keeper wallet", async () => {
    const pk = (keeper as unknown as Keypair).publicKey;
    const bal = (await solBalance(conn, pk)) / 1e9;
    const need = cfg.solReserveLamports / 1e9;
    add(bal >= need ? "PASS" : cfg.dryRun ? "WARN" : "FAIL", "Keeper wallet", `${pk.toBase58()} · ${bal.toFixed(4)} SOL (reserve ${need} SOL)`);
  });

  if (!cfg.pfxMint) {
    add(cfg.dryRun ? "WARN" : "FAIL", "PFX mint", "PFX_MINT not set");
  } else {
    await step("PFX mint", async () => {
      const mint = new PublicKey(cfg.pfxMint);
      const info = await getMintInfo(conn, mint);
      add("PASS", "PFX mint", `${cfg.pfxMint} · ${info.programId.toBase58().startsWith("Tokenz") ? "Token-2022" : "SPL Token"} · ${info.decimals} decimals`);

      const pump = await pumpCreator(conn, mint);
      if (!pump) add("WARN", "Creator", "no pump.fun bonding curve found for this mint");
      else {
        const k = (keeper as Keypair | null)?.publicKey.toBase58();
        const match = k === pump.creator;
        add(match ? "PASS" : "FAIL", "Creator", match
          ? `keeper is the creator · ${pump.graduated ? "graduated to PumpSwap" : "on bonding curve"}`
          : `creator is ${pump.creator}; keeper ${k ?? "(none)"} cannot claim fees. Use the creator wallet as keeper or set CLAIM_FEES=false and fund the keeper yourself`);
      }

      const t = Date.now();
      const snap = await takeSnapshot(conn, mint, info.programId);
      add("PASS", "Holder snapshot", `${Object.keys(snap.balances).length} holders in ${Date.now() - t}ms`);
    });
  }

  await step("Index", async () => {
    const view = await screenIndex(cfg, conn);
    add(view.index.length === cfg.indexSize ? "PASS" : "WARN", "Index", `${view.index.map((c) => c.symbol).join(", ")} (${view.hidden.length}/${view.screened} hidden)`);

    const probe = Math.round(Math.min(cfg.maxBuySolPerEpoch, 1) * 1e9 * 0.2);
    for (const c of view.index) {
      await step(`Quote ${c.symbol}`, async () => {
        const q = await quoteBuy(cfg, c.mint, probe);
        const impact = Number(q.priceImpactPct) * 100;
        add(impact <= cfg.maxPriceImpactPct ? "PASS" : "WARN", `Quote ${c.symbol}`, `${(probe / 1e9).toFixed(2)} SOL → impact ${impact.toFixed(3)}%`);
      });
    }
  });

  const k = keeper as Keypair | null;
  if (k && cfg.claimFees) {
    await step("Fee claim (simulated)", async () => {
      const body: Record<string, unknown> = { publicKey: k.publicKey.toBase58(), action: "collectCreatorFee", priorityFee: 0.000005, pool: cfg.creatorFeePool };
      if (cfg.creatorFeePool !== "pump" && cfg.pfxMint) body.mint = cfg.pfxMint;
      const res = await fetch("https://pumpportal.fun/api/trade-local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.status !== 200) {
        add("WARN", "Fee claim (simulated)", `PumpPortal ${res.status}: ${(await res.text()).slice(0, 120)}`);
        return;
      }
      const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
      const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, accounts: { encoding: "base64", addresses: [k.publicKey.toBase58()] } });
      if (sim.value.err) {
        add("WARN", "Fee claim (simulated)", `would fail now (${JSON.stringify(sim.value.err)}); normal when no fees have accrued yet`);
      } else {
        const after = sim.value.accounts?.[0]?.lamports ?? 0;
        const before = await solBalance(conn, k.publicKey);
        add("PASS", "Fee claim (simulated)", `claimable now ≈ ${((after - before) / 1e9).toFixed(4)} SOL`);
      }
    });
  }

  await step("Disk", async () => {
    for (const dir of [cfg.stateDir, cfg.publishDir]) {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, ".preflight");
      fs.writeFileSync(probe, "ok");
      fs.unlinkSync(probe);
    }
    add("PASS", "Disk", `writable: ${cfg.stateDir}, ${cfg.publishDir}`);
  });

  const alerts = cfg.discordWebhook || (cfg.telegramToken && cfg.telegramChatId);
  add(alerts ? "PASS" : "WARN", "Alerts", alerts ? "configured" : "no DISCORD_WEBHOOK_URL or TELEGRAM_* set; failures will only be in logs");

  const fails = results.filter((r) => r.status === "FAIL").length;
  const warns = results.filter((r) => r.status === "WARN").length;
  console.log(`\n${fails ? "NO-GO" : "GO"} · ${fails} failed · ${warns} warnings`);
  return fails === 0;
}
