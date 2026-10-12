import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Config } from "./config.js";
import { fetchCandidates, fetchUsdPrice } from "./index/sources.js";
import { screen } from "./index/outliers.js";
import { selectIndex } from "./index/selector.js";
import type { Constituent, Verdict } from "./index/types.js";
import { evaluateEpoch, summarize, type HolderRow, type Snapshot } from "./holders/eligibility.js";
import { getMintInfo, offCurveOwners, takeSnapshot } from "./holders/snapshot.js";
import { allocate } from "./airdrop/allocate.js";
import { sendAirdrop } from "./airdrop/send.js";
import { claimCreatorFees } from "./chain/fees.js";
import { buyWithSol, WSOL } from "./chain/swap.js";
import { connect, loadKeeper, solBalance } from "./chain/wallet.js";
import {
  epochAt,
  loadState,
  publishEpoch,
  publishLatest,
  publishWallets,
  saveState,
  type EngineState,
  type EpochReport,
  type HiddenCoin,
  type Latest,
  type TokenDrop,
  type WalletEntry,
} from "./state.js";

const MIN_BUY_LAMPORTS = 1_000_000; // 0.001 SOL

export interface IndexView {
  index: Constituent[];
  hidden: HiddenCoin[];
  screened: number;
  verdicts: Verdict[];
}

export async function screenIndex(cfg: Config): Promise<IndexView> {
  const candidates = await fetchCandidates(cfg.candidatePool);
  const exclude = [...cfg.blacklist, cfg.pfxMint].filter(Boolean);
  const verdicts = screen(candidates, cfg.filters, { exclude });
  const index = selectIndex(verdicts, cfg.indexSize, cfg.weighting, cfg.maxWeight);
  const hidden = verdicts
    .filter((v) => v.hidden)
    .sort((a, b) => b.candidate.marketCapUsd - a.candidate.marketCapUsd)
    .map(({ candidate: c, reasons }) => ({
      mint: c.mint,
      symbol: c.symbol,
      name: c.name,
      image: c.image,
      marketCapUsd: c.marketCapUsd,
      liquidityUsd: c.liquidityUsd,
      reasons,
    }));
  return { index, hidden, screened: candidates.length, verdicts };
}

interface HolderView {
  snapshot: Snapshot;
  rows: HolderRow[];
  decimals: number;
  bootstrap: boolean;
}

async function holderPass(cfg: Config, conn: Connection, state: EngineState): Promise<HolderView | null> {
  if (!cfg.pfxMint) return null;
  const mint = new PublicKey(cfg.pfxMint);
  const info = await getMintInfo(conn, mint);
  const snapshot = await takeSnapshot(conn, mint, info.programId);
  const snaps = [...state.snapshots, snapshot];
  const owners = new Set<string>();
  for (const s of snaps) for (const o of Object.keys(s.balances)) owners.add(o);
  const rows = evaluateEpoch(snaps, cfg.holders, { decimals: info.decimals, offCurve: offCurveOwners(owners) });
  return { snapshot, rows, decimals: info.decimals, bootstrap: state.snapshots.length === 0 };
}

function walletBook(
  rows: HolderRow[],
  decimals: number,
  received: Record<string, WalletEntry["received"]>,
): Record<string, WalletEntry> {
  const total = rows.reduce((a, r) => a + r.weight, 0n);
  const scale = 10 ** decimals;
  const out: Record<string, WalletEntry> = {};
  for (const r of rows) {
    out[r.owner] = {
      status: r.status,
      weightUi: Number(r.weight) / scale,
      sharePct: total > 0n ? (Number(r.weight) / Number(total)) * 100 : 0,
      received: received[r.owner] ?? [],
    };
  }
  return out;
}

function buildLatest(
  cfg: Config,
  state: EngineState,
  view: IndexView,
  holders: Record<string, number> | null,
  keeper: string,
): Latest {
  const { nextEpochAt } = epochAt(cfg);
  const reports = state.reports;
  return {
    project: "PFX",
    updatedAt: Date.now(),
    mode: cfg.dryRun ? "dry" : "live",
    epochMinutes: cfg.epochMinutes,
    genesisMs: cfg.genesisMs,
    epoch: state.epoch,
    nextEpochAt,
    pfxMint: cfg.pfxMint,
    keeper,
    rules: {
      indexSize: cfg.indexSize,
      weighting: cfg.weighting,
      minHoldPfx: cfg.holders.minBalance,
      maxWalletPct: cfg.holders.maxWalletPct,
      snapshotMinutes: cfg.snapshotMinutes,
      filters: cfg.filters,
    },
    index: view.index,
    hidden: view.hidden,
    screened: view.screened,
    holders,
    lastDrop: reports.at(-1) ?? null,
    history: reports.slice(-48).map(({ epoch, at, valueUsd, boughtUsd, recipients, forfeited, solSpent }) => ({
      epoch,
      at,
      valueUsd,
      boughtUsd: boughtUsd ?? 0,
      recipients,
      forfeited,
      solSpent,
    })),
    totals: {
      epochs: reports.length,
      valueUsd: reports.reduce((a, r) => a + r.valueUsd, 0),
      boughtUsd: reports.reduce((a, r) => a + (r.boughtUsd ?? 0), 0),
      solSpent: reports.reduce((a, r) => a + r.solSpent, 0),
    },
  };
}

function keeperOrNull(cfg: Config): Keypair | null {
  try {
    return loadKeeper(cfg);
  } catch {
    return null;
  }
}

/** Screen the market and publish the current index. No wallet needed. */
export async function refreshIndex(cfg: Config): Promise<IndexView> {
  const view = await screenIndex(cfg);
  const state = loadState(cfg);
  publishLatest(cfg, buildLatest(cfg, state, view, null, keeperOrNull(cfg)?.publicKey.toBase58() ?? ""));
  return view;
}

/** Intra-epoch snapshot: catches anyone who sells and re-buys before the drop. */
export async function snapshotTick(cfg: Config): Promise<void> {
  if (!cfg.pfxMint) {
    console.log("[snapshot] PFX_MINT not set — nothing to watch yet");
    return;
  }
  const conn = connect(cfg);
  const state = loadState(cfg);
  const holders = await holderPass(cfg, conn, state);
  if (!holders) return;
  state.snapshots.push(holders.snapshot);
  saveState(cfg, state);
  const summary = summarize(holders.rows);
  publishWallets(cfg, walletBook(holders.rows, holders.decimals, state.lastReceived ?? {}));
  console.log(`[snapshot] epoch ${state.epoch} · ${state.snapshots.length} snapshots ·`, summary);
}

/** Settle the epoch: claim → buy the index → airdrop to holders who didn't sell. */
export async function runEpoch(cfg: Config): Promise<EpochReport> {
  const state = loadState(cfg);
  const conn = connect(cfg);
  const live = !cfg.dryRun;
  const keeper = live ? loadKeeper(cfg) : keeperOrNull(cfg);
  const dropNo = state.epoch;
  console.log(`\n━━ PFX epoch ${dropNo} · ${live ? "LIVE" : "DRY RUN"} ━━`);

  const view = await screenIndex(cfg);
  console.log(`[index] ${view.screened} screened · ${view.hidden.length} hidden ·`, view.index.map((c) => c.symbol).join(", "));

  const holders = await holderPass(cfg, conn, state);
  const solUsd = await fetchUsdPrice(WSOL, cfg.jupApi);

  // 1. Fees
  let feesClaimedSol = 0;
  let budgetLamports = Math.round(cfg.dryRunBudgetSol * 1e9);
  if (live && keeper) {
    const before = await solBalance(conn, keeper.publicKey);
    if (cfg.claimFees) {
      const sig = await claimCreatorFees(conn, keeper, cfg).catch((e: Error) => (console.warn("[fees]", e.message), null));
      if (sig) console.log(`[fees] claimed · ${sig}`);
    }
    const after = await solBalance(conn, keeper.publicKey);
    feesClaimedSol = Math.max(0, after - before) / 1e9;
    budgetLamports = Math.max(0, Math.floor((after - cfg.solReserveLamports) * cfg.buyShare));
  }
  console.log(`[budget] ${(budgetLamports / 1e9).toFixed(4)} SOL · fees ${feesClaimedSol.toFixed(4)} SOL`);

  // 2. Buy the index
  const buys = new Map<string, { lamports: number; signature?: string }>();
  for (const c of view.index) {
    const lamports = Math.floor(budgetLamports * c.weight);
    if (lamports < MIN_BUY_LAMPORTS) continue;
    if (live && keeper) {
      try {
        const { signature } = await buyWithSol(conn, keeper, cfg, c.mint, lamports);
        buys.set(c.mint, { lamports, signature });
        console.log(`[buy] ${c.symbol} ← ${(lamports / 1e9).toFixed(4)} SOL · ${signature}`);
      } catch (e) {
        console.error(`[buy] ${c.symbol} failed: ${(e as Error).message}`);
      }
    } else {
      buys.set(c.mint, { lamports });
    }
  }

  // 3. Airdrop
  const recipients = (holders?.rows ?? [])
    .filter((r) => r.weight > 0n && !holders?.bootstrap)
    .map((r) => ({ owner: r.owner, weight: r.weight }));
  const received: Record<string, WalletEntry["received"]> = {};
  const tokens: TokenDrop[] = [];

  for (const c of view.index) {
    const buy = buys.get(c.mint);
    let decimals = 6;
    let programId: PublicKey | null = null;
    let total = 0n;

    if (live && keeper) {
      const info = await getMintInfo(conn, new PublicKey(c.mint));
      decimals = info.decimals;
      programId = info.programId;
      const ata = getAssociatedTokenAddressSync(new PublicKey(c.mint), keeper.publicKey, true, programId);
      total = await conn
        .getTokenAccountBalance(ata, "confirmed")
        .then((b) => BigInt(b.value.amount))
        .catch(() => 0n);
    } else if (buy && c.priceUsd > 0) {
      total = BigInt(Math.floor((((buy.lamports / 1e9) * solUsd) / c.priceUsd) * 10 ** decimals));
    }

    const scale = 10 ** decimals;
    const minUnits = c.priceUsd > 0 ? BigInt(Math.ceil((cfg.minAllocationUsd / c.priceUsd) * scale)) : 1n;
    const { allocations } = allocate(total, recipients, minUnits);

    let signatures: string[] = [];
    let sent = allocations.reduce((a, x) => a + x.amount, 0n);
    if (live && keeper && programId && allocations.length) {
      const res = await sendAirdrop(conn, keeper, new PublicKey(c.mint), programId, decimals, allocations, {
        batch: cfg.airdropBatch,
        priorityMicroLamports: cfg.priorityMicroLamports,
      });
      signatures = res.signatures;
      sent = res.sent;
      const failed = new Set(res.failed.map((f) => f.owner));
      for (const a of allocations) if (failed.has(a.owner)) a.amount = 0n;
    }

    for (const a of allocations) {
      if (a.amount === 0n) continue;
      const amountUi = Number(a.amount) / scale;
      (received[a.owner] ??= []).push({ symbol: c.symbol, amountUi, valueUsd: amountUi * c.priceUsd });
    }

    const amountUi = Number(sent) / scale;
    tokens.push({
      mint: c.mint,
      symbol: c.symbol,
      image: c.image,
      weight: c.weight,
      solSpent: (buy?.lamports ?? 0) / 1e9,
      amountUi,
      valueUsd: amountUi * c.priceUsd,
      recipients: allocations.filter((a) => a.amount > 0n).length,
      rolledOverUi: Number(total - sent) / scale,
      buySignature: buy?.signature,
      signatures,
    });
    console.log(`[drop] ${c.symbol}: ${amountUi.toLocaleString()} to ${tokens.at(-1)!.recipients} holders`);
  }

  const summary = holders ? summarize(holders.rows) : null;
  const solSpent = [...buys.values()].reduce((a, b) => a + b.lamports, 0) / 1e9;
  const report: EpochReport = {
    epoch: dropNo,
    at: Date.now(),
    mode: live ? "live" : "dry",
    bootstrap: holders?.bootstrap ?? false,
    feesClaimedSol,
    solSpent,
    solUsd,
    boughtUsd: solSpent * solUsd,
    recipients: Object.keys(received).length,
    forfeited: summary?.sold ?? 0,
    valueUsd: tokens.reduce((a, t) => a + t.valueUsd, 0),
    tokens,
  };

  state.reports.push(report);
  state.snapshots = holders ? [holders.snapshot] : []; // end of this epoch = start of the next
  state.lastReceived = received;
  state.epoch = dropNo + 1;
  saveState(cfg, state);

  publishEpoch(cfg, report);
  publishLatest(cfg, buildLatest(cfg, state, view, summary, keeper?.publicKey.toBase58() ?? ""));
  if (holders) publishWallets(cfg, walletBook(holders.rows, holders.decimals, received));

  console.log(`[done] epoch ${dropNo} · $${report.valueUsd.toFixed(2)} to ${report.recipients} wallets · ${report.forfeited} forfeited`);
  return report;
}
