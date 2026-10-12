import fs from "node:fs";
import path from "node:path";
import type { Config, ScreenFilters } from "./config.js";
import type { Snapshot } from "./holders/eligibility.js";
import type { Constituent } from "./index/types.js";

export interface TokenDrop {
  mint: string;
  symbol: string;
  image: string;
  weight: number;
  solSpent: number;
  amountUi: number;
  valueUsd: number;
  recipients: number;
  /** Token accounts the keeper opened (and paid rent for) this drop. */
  newAccounts: number;
  /** Holders whose share was too small to justify opening an account; rolls over. */
  skippedSmall: number;
  rolledOverUi: number;
  buySignature?: string;
  signatures: string[];
}

export interface EpochReport {
  epoch: number;
  at: number;
  mode: "live" | "dry";
  bootstrap: boolean;
  feesClaimedSol: number;
  solSpent: number;
  solUsd: number;
  /** USD value of the index tokens bought this epoch. */
  boughtUsd: number;
  rentSol: number;
  recipients: number;
  forfeited: number;
  valueUsd: number;
  tokens: TokenDrop[];
  notes: string[];
}

export interface HeldToken {
  mint: string;
  symbol: string;
  image: string;
}

export interface HiddenCoin {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  marketCapUsd: number;
  liquidityUsd: number;
  reasons: string[];
}

export interface WalletEntry {
  status: string;
  weightUi: number;
  sharePct: number;
  received: { symbol: string; amountUi: number; valueUsd: number }[];
}

export interface Latest {
  project: "PFX";
  updatedAt: number;
  mode: "live" | "dry";
  paused: boolean;
  epochMinutes: number;
  genesisMs: number;
  epoch: number;
  nextEpochAt: number;
  pfxMint: string;
  keeper: string;
  rules: {
    indexSize: number;
    weighting: string;
    minHoldPfx: number;
    maxWalletPct: number;
    snapshotMinutes: number;
    filters: ScreenFilters;
  };
  index: Constituent[];
  hidden: HiddenCoin[];
  screened: number;
  holders: Record<string, number> | null;
  lastDrop: EpochReport | null;
  history: Pick<EpochReport, "epoch" | "at" | "valueUsd" | "boughtUsd" | "recipients" | "forfeited" | "solSpent">[];
  totals: { epochs: number; valueUsd: number; boughtUsd: number; solSpent: number };
}

export interface EngineState {
  epoch: number;
  snapshots: Snapshot[];
  reports: EpochReport[];
  lastReceived?: Record<string, WalletEntry["received"]>;
  /** Index tokens the keeper may still hold; airdropped until empty, even after leaving the basket. */
  held?: HeldToken[];
  holdersSummary?: Record<string, number>;
}

export function epochAt(cfg: Config, now = Date.now()) {
  const ms = cfg.epochMinutes * 60_000;
  const epoch = Math.floor((now - cfg.genesisMs) / ms);
  return { epoch, startsAt: cfg.genesisMs + epoch * ms, nextEpochAt: cfg.genesisMs + (epoch + 1) * ms };
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function loadState(cfg: Config): EngineState {
  return readJson<EngineState>(path.join(cfg.stateDir, "engine.json"), {
    epoch: 1,
    snapshots: [],
    reports: [],
  });
}

export function saveState(cfg: Config, s: EngineState): void {
  writeJson(path.join(cfg.stateDir, "engine.json"), { ...s, reports: s.reports.slice(-200) });
}

export function publishLatest(cfg: Config, latest: Latest): void {
  writeJson(path.join(cfg.publishDir, "latest.json"), latest);
}

export function publishWallets(cfg: Config, wallets: Record<string, WalletEntry>): void {
  writeJson(path.join(cfg.publishDir, "wallets.json"), { updatedAt: Date.now(), wallets });
}

export function publishEpoch(cfg: Config, report: EpochReport): void {
  writeJson(path.join(cfg.publishDir, "epochs", `${report.epoch}.json`), report);
}
