import { PublicKey, type Connection, type Keypair } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Config } from "./config.js";
import { fetchCandidates, fetchDexPairs, fetchUsdPrice } from "./index/sources.js";
import { screen } from "./index/outliers.js";
import { selectIndex } from "./index/selector.js";
import type { Constituent, Verdict } from "./index/types.js";
import { evaluateEpoch, summarize, type HolderRow, type Snapshot } from "./holders/eligibility.js";
import { getMintInfo, offCurveOwners, takeSnapshot, type MintInfo } from "./holders/snapshot.js";
import { allocate, type Allocation } from "./airdrop/allocate.js";
import { feePerRecipient, planSends } from "./airdrop/plan.js";
import { sendAirdrop } from "./airdrop/send.js";
import { claimCreatorFees } from "./chain/fees.js";
import { buyWithSol, WSOL } from "./chain/swap.js";
import { connect, existingAccounts, loadKeeper, solBalance, unwrapWsol, withRetry } from "./chain/wallet.js";
import { isPaused, notify } from "./ops.js";
import {
  epochAt,
  loadState,
  publishEpoch,
  publishLatest,
  publishWallets,
  saveState,
  type EngineState,
  type EpochReport,
  type HeldToken,
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

/**
 * Screen the market and pick the basket. With an RPC connection, each pick's
 * mint is also checked on chain; a coin we couldn't safely airdrop (freeze
 * authority, transfer hook, ...) is hidden and the next coin takes its slot.
 */
export async function screenIndex(cfg: Config, conn?: Connection): Promise<IndexView> {
  const candidates = await fetchCandidates(cfg.candidatePool);
  const exclude = [...cfg.blacklist, cfg.pfxMint].filter(Boolean);
  const verdicts = screen(candidates, cfg.filters, { exclude });
  let index = selectIndex(verdicts, cfg.indexSize, cfg.weighting, cfg.maxWeight);
  if (conn) {
    const checked = new Set<string>();
    for (let round = 0; round < 10; round++) {
      let changed = false;
      for (const c of index) {
        if (checked.has(c.mint)) continue;
        checked.add(c.mint);
        const info = await getMintInfo(conn, new PublicKey(c.mint)).catch(() => null);
        const reasons = info ? info.blockers : ["mint unreadable"];
        if (reasons.length) {
          const v = verdicts.find((x) => x.candidate.mint === c.mint)!;
          v.hidden = true;
          v.reasons.push(...reasons);
          changed = true;
        }
      }
      if (!changed) break;
      index = selectIndex(verdicts, cfg.indexSize, cfg.weighting, cfg.maxWeight);
    }
  }
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

async function holderPass(
  cfg: Config,
  conn: Connection,
  state: EngineState,
  keeper: string | undefined,
): Promise<HolderView | null> {
  if (!cfg.pfxMint) return null;
  const mint = new PublicKey(cfg.pfxMint);
  const info = await getMintInfo(conn, mint);
  const snapshot = await withRetry(() => takeSnapshot(conn, mint, info.programId), 4);
  const snaps = [...state.snapshots, snapshot];
  const owners = new Set<string>();
  for (const s of snaps) for (const o of Object.keys(s.balances)) owners.add(o);
  const rules = { ...cfg.holders, excludeOwners: [...cfg.holders.excludeOwners, ...(keeper ? [keeper] : [])] };
  const rows = evaluateEpoch(snaps, rules, { decimals: info.decimals, offCurve: offCurveOwners(owners) });
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

function buildLatest(cfg: Config, state: EngineState, view: IndexView, keeper: string): Latest {
  const { nextEpochAt } = epochAt(cfg);
  const reports = state.reports;
  return {
    project: "PFX",
    updatedAt: Date.now(),
    mode: cfg.dryRun ? "dry" : "live",
    paused: isPaused(cfg),
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
    holders: state.holdersSummary ?? null,
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
  const view = await screenIndex(cfg, connect(cfg));
  const state = loadState(cfg);
  publishLatest(cfg, buildLatest(cfg, state, view, keeperOrNull(cfg)?.publicKey.toBase58() ?? ""));
  return view;
}

/** Intra-epoch snapshot: catches anyone who sells and re-buys before the drop. */
export async function snapshotTick(cfg: Config): Promise<void> {
  if (!cfg.pfxMint) {
    console.log("[snapshot] PFX_MINT not set, nothing to watch yet");
    return;
  }
  const conn = connect(cfg);
  const state = loadState(cfg);
  const keeper = keeperOrNull(cfg)?.publicKey.toBase58();
  const holders = await holderPass(cfg, conn, state, keeper);
  if (!holders) return;
  state.snapshots.push(holders.snapshot);
  state.holdersSummary = summarize(holders.rows);
  saveState(cfg, state);
  publishWallets(cfg, walletBook(holders.rows, holders.decimals, state.lastReceived ?? {}));
  console.log(`[snapshot] epoch ${state.epoch} · ${state.snapshots.length} snapshots ·`, state.holdersSummary);
}

interface DropToken {
  mint: string;
  symbol: string;
  image: string;
  weight: number;
  priceUsd: number;
}

/**
 * Settle the epoch: claim fees → buy the index → airdrop to holders who didn't sell.
 *
 * Crash safety: the epoch transition (new snapshot baseline, next drop number)
 * is saved after the buys and before any airdrop is sent. The airdrop always
 * sends the keeper's whole balance of each token, so anything a crash leaves
 * behind simply goes out with the next epoch. Nothing is paid twice.
 */
export async function runEpoch(cfg: Config): Promise<EpochReport | null> {
  if (isPaused(cfg)) {
    console.log("[epoch] paused: skipping settlement (remove state/PAUSE or set PAUSED=false)");
    await refreshIndex(cfg);
    return null;
  }

  const state = loadState(cfg);
  const conn = connect(cfg);
  const live = !cfg.dryRun;
  const keeper = live ? loadKeeper(cfg) : keeperOrNull(cfg);
  const keeperKey = keeper?.publicKey.toBase58();
  const dropNo = state.epoch;
  const notes: string[] = [];
  console.log(`━━ PFX epoch ${dropNo} · ${live ? "LIVE" : "DRY RUN"} ━━`);

  const view = await screenIndex(cfg, conn);
  console.log(`[index] ${view.screened} screened · ${view.hidden.length} hidden ·`, view.index.map((c) => c.symbol).join(", "));

  // Holder snapshot first: if the RPC fails here, nothing has been spent.
  const holders = await holderPass(cfg, conn, state, keeperKey);
  const solUsd = await fetchUsdPrice(WSOL, cfg.jupApi);
  if (!(solUsd > 0)) throw new Error("No SOL price from Jupiter; refusing to settle blind");

  // 1. Fees
  let feesClaimedSol = 0;
  let budgetLamports = Math.round(cfg.dryRunBudgetSol * 1e9);
  if (live && keeper) {
    const before = await solBalance(conn, keeper.publicKey);
    if (cfg.claimFees) {
      const sig = await claimCreatorFees(conn, keeper, cfg).catch((e: Error) => (console.warn("[fees]", e.message), null));
      if (sig) console.log(`[fees] claimed · ${sig}`);
    }
    await unwrapWsol(conn, keeper).catch((e: Error) => console.warn("[fees] unwrap WSOL:", e.message));
    const after = await solBalance(conn, keeper.publicKey);
    feesClaimedSol = Math.max(0, after - before) / 1e9;
    budgetLamports = Math.max(0, Math.floor((after - cfg.solReserveLamports) * cfg.buyShare));
  }
  budgetLamports = Math.min(budgetLamports, Math.round(cfg.maxBuySolPerEpoch * 1e9));
  console.log(`[budget] ${(budgetLamports / 1e9).toFixed(4)} SOL · fees ${feesClaimedSol.toFixed(4)} SOL`);

  // 2. Buy the index (only tokens we can actually airdrop)
  const mintInfo = new Map<string, MintInfo>();
  const buys = new Map<string, { lamports: number; signature?: string }>();
  for (const c of view.index) {
    const info = await getMintInfo(conn, new PublicKey(c.mint)).catch(() => null);
    if (!info) {
      notes.push(`${c.symbol}: mint unreadable, skipped`);
      continue;
    }
    if (info.blockers.length) {
      notes.push(`${c.symbol}: ${info.blockers.join(", ")}, skipped`);
      console.warn(`[buy] ${c.symbol} skipped: ${info.blockers.join(", ")}`);
      continue;
    }
    mintInfo.set(c.mint, info);
    const lamports = Math.floor(budgetLamports * c.weight);
    if (lamports < MIN_BUY_LAMPORTS) continue;
    if (live && keeper) {
      try {
        const { signature } = await buyWithSol(conn, keeper, cfg, c.mint, lamports);
        buys.set(c.mint, { lamports, signature });
        console.log(`[buy] ${c.symbol} ← ${(lamports / 1e9).toFixed(4)} SOL · ${signature}`);
      } catch (e) {
        notes.push(`${c.symbol}: buy failed (${(e as Error).message.slice(0, 120)})`);
        console.error(`[buy] ${c.symbol} failed: ${(e as Error).message}`);
      }
    } else {
      buys.set(c.mint, { lamports });
    }
  }

  // Tokens to airdrop: this basket, plus anything still held from earlier baskets.
  const dropList: DropToken[] = view.index.filter((c) => mintInfo.has(c.mint));
  const held = new Map((state.held ?? []).map((h) => [h.mint, h]));
  for (const c of dropList) held.set(c.mint, { mint: c.mint, symbol: c.symbol, image: c.image });
  if (live) {
    const carry = [...held.values()].filter((h) => !dropList.some((d) => d.mint === h.mint));
    if (carry.length) {
      const pairs = await fetchDexPairs(carry.map((h) => h.mint)).catch(() => new Map());
      for (const h of carry) {
        const info = await getMintInfo(conn, new PublicKey(h.mint)).catch(() => null);
        if (!info) continue;
        mintInfo.set(h.mint, info);
        dropList.push({ ...h, weight: 0, priceUsd: Number(pairs.get(h.mint)?.priceUsd ?? 0) });
      }
    }
  }

  // Commit the epoch transition before any airdrop leaves the keeper.
  state.snapshots = holders ? [holders.snapshot] : [];
  state.epoch = dropNo + 1;
  state.held = [...held.values()];
  if (holders) state.holdersSummary = summarize(holders.rows);
  saveState(cfg, state);

  // 3. Airdrop
  const recipients = holders && !holders.bootstrap
    ? holders.rows.filter((r) => r.weight > 0n).map((r) => ({ owner: r.owner, weight: r.weight }))
    : [];
  if (holders?.bootstrap) notes.push("first epoch: holder baseline recorded, drops start next epoch");

  const received: Record<string, WalletEntry["received"]> = {};
  const tokens: TokenDrop[] = [];
  let rentLamportsTotal = 0;
  const feeEach = feePerRecipient(cfg.airdropBatch, cfg.priorityMicroLamports);

  for (const t of dropList) {
    // One token's failure (RPC outage, bad mint) must not block the others; its balance rolls over.
    try {
      const info = mintInfo.get(t.mint)!;
      const mint = new PublicKey(t.mint);
      const scale = 10 ** info.decimals;
      const buy = buys.get(t.mint);

      let total = 0n;
      if (live && keeper) {
        const ata = getAssociatedTokenAddressSync(mint, keeper.publicKey, true, info.programId);
        total = await conn
          .getTokenAccountBalance(ata, "confirmed")
          .then((b) => BigInt(b.value.amount))
          .catch(() => 0n);
      } else if (buy && t.priceUsd > 0) {
        total = BigInt(Math.floor((((buy.lamports / 1e9) * solUsd) / t.priceUsd) * scale));
      }
      if (total === 0n) {
        held.delete(t.mint);
        continue;
      }

      const minUnits = t.priceUsd > 0 ? BigInt(Math.ceil((cfg.minAllocationUsd / t.priceUsd) * scale)) : total + 1n;
      const { allocations } = allocate(total, recipients, minUnits);

      let toSend: Allocation[] = allocations;
      let newAccounts = 0;
      let skippedRent = 0;
      let skippedGas = 0;
      if (allocations.length) {
        const atas = allocations.map((a) => getAssociatedTokenAddressSync(mint, new PublicKey(a.owner), true, info.programId));
        const existing = await existingAccounts(conn, atas);
        const hasAccount = new Map(allocations.map((a, i) => [a.owner, existing.has(atas[i]!.toBase58())]));
        const rentLamports = await conn.getMinimumBalanceForRentExemption(info.accountLen);
        const available =
          live && keeper ? (await solBalance(conn, keeper.publicKey)) - cfg.gasFloorLamports : Number.MAX_SAFE_INTEGER;
        const plan = planSends({
          allocations: [...allocations].sort((a, b) => (b.amount > a.amount ? 1 : -1)),
          hasAccount: (o) => hasAccount.get(o) ?? false,
          rentLamports,
          feeLamportsPerRecipient: feeEach,
          availableLamports: available,
          unitUsd: t.priceUsd / scale,
          minNewAccountUsd: Math.max(cfg.minAllocationUsd, ((rentLamports / 1e9) * solUsd) * cfg.newAccountValueMultiple),
        });
        toSend = plan.send;
        newAccounts = plan.newAccounts;
        rentLamportsTotal += plan.newAccounts * rentLamports;
        skippedRent = plan.skipped.filter((s) => s.reason === "worth less than account rent").length;
        skippedGas = plan.skipped.filter((s) => s.reason === "keeper low on SOL").length;
        if (skippedGas) notes.push(`${t.symbol}: ${skippedGas} holders deferred, keeper low on SOL`);
      }

      let signatures: string[] = [];
      let sent = toSend.reduce((a, x) => a + x.amount, 0n);
      let paid = toSend;
      if (live && keeper && toSend.length) {
        const res = await sendAirdrop(conn, keeper, mint, info.programId, info.decimals, toSend, {
          batch: cfg.airdropBatch,
          priorityMicroLamports: cfg.priorityMicroLamports,
        });
        signatures = res.signatures;
        sent = res.sent;
        const failed = new Set(res.failed.map((f) => f.owner));
        paid = toSend.filter((a) => !failed.has(a.owner));
        if (res.failed.length) notes.push(`${t.symbol}: ${res.failed.length} transfers failed, roll over`);
      }

      for (const a of paid) {
        const amountUi = Number(a.amount) / scale;
        (received[a.owner] ??= []).push({ symbol: t.symbol, amountUi, valueUsd: amountUi * t.priceUsd });
      }
      if (live && total - sent === 0n) held.delete(t.mint);

      const amountUi = Number(sent) / scale;
      tokens.push({
        mint: t.mint,
        symbol: t.symbol,
        image: t.image,
        weight: t.weight,
        solSpent: (buy?.lamports ?? 0) / 1e9,
        amountUi,
        valueUsd: amountUi * t.priceUsd,
        recipients: paid.length,
        newAccounts,
        skippedSmall: skippedRent,
        rolledOverUi: Number(total - sent) / scale,
        buySignature: buy?.signature,
        signatures,
      });
      console.log(
        `[drop] ${t.symbol}: ${amountUi.toLocaleString()} to ${paid.length} holders · ${newAccounts} new accounts · ${skippedRent} too small`,
      );
    } catch (e) {
      notes.push(`${t.symbol}: airdrop skipped this epoch (${(e as Error).message.slice(0, 120)}), rolls over`);
      console.error(`[drop] ${t.symbol} failed, rolls over:`, (e as Error).message);
    }
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
    rentSol: rentLamportsTotal / 1e9,
    recipients: Object.keys(received).length,
    forfeited: summary?.sold ?? 0,
    valueUsd: tokens.reduce((a, t) => a + t.valueUsd, 0),
    tokens,
    notes,
  };

  state.reports.push(report);
  state.lastReceived = received;
  state.held = [...held.values()];
  saveState(cfg, state);

  publishEpoch(cfg, report);
  publishLatest(cfg, buildLatest(cfg, state, view, keeperKey ?? ""));
  if (holders) publishWallets(cfg, walletBook(holders.rows, holders.decimals, received));

  const line = `PFX epoch ${dropNo}${live ? "" : " (dry run)"}: bought ${solSpent.toFixed(3)} SOL of ${tokens
    .filter((t) => t.weight > 0)
    .map((t) => t.symbol)
    .join(", ")} · airdropped $${report.valueUsd.toFixed(2)} to ${report.recipients} wallets · ${report.forfeited} forfeited`;
  console.log(`[done] ${line}`);
  if (live) await notify(cfg, [line, ...notes.map((n) => `• ${n}`)].join("\n"));
  return report;
}
