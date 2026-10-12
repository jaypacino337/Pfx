import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Blank values in .env (e.g. `JUP_API_BASE=`) count as unset. */
function str(name: string, fallback = ""): string {
  const raw = process.env[name]?.trim();
  return raw ? raw : fallback;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export type Weighting = "equal" | "mcap";

export interface ScreenFilters {
  /** Coins younger than this are hidden (fresh launches are mostly bot-pumped). */
  minAgeHours: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  minSells24h: number;
  /** buys / sells over 24h. Wash-bot coins show 50:1; organic coins sit near 1. */
  maxBuySellRatio: number;
  /** marketCap / liquidity. A $1B coin with $3M of liquidity is not a $1B coin. */
  maxMcapToLiquidity: number;
  /** Robust z-score (median/MAD) cut-off on log(mcap/liquidity) across survivors. */
  madZ: number;
}

export interface HolderRules {
  /** Wallets holding less than this many whole PFX are ignored as dust. */
  minBalance: number;
  /** No single wallet may weigh more than this % of the eligible supply. */
  maxWalletPct: number;
  /** IQR multiplier for the whale fence on log10(balance). */
  iqrK: number;
  /** Balance drops smaller than this fraction are ignored (rounding / fees). */
  sellTolerance: number;
  excludeOwners: string[];
}

export const config = {
  rpcUrl: str("RPC_URL", "https://api.mainnet-beta.solana.com"),
  keeperSecret: str("KEEPER_SECRET_KEY", ""),
  keeperKeypairPath: str("KEEPER_KEYPAIR_PATH", ""),
  pfxMint: str("PFX_MINT", ""),
  dryRun: bool("DRY_RUN", true),
  dryRunBudgetSol: num("DRY_RUN_BUDGET_SOL", 1),

  genesisMs: num("EPOCH_GENESIS_MS", Date.UTC(2026, 0, 1)),
  epochMinutes: num("EPOCH_MINUTES", 45),
  snapshotMinutes: num("SNAPSHOT_MINUTES", 5),

  indexSize: num("INDEX_SIZE", 5),
  weighting: (str("INDEX_WEIGHTING", "equal")) as Weighting,
  maxWeight: num("INDEX_MAX_WEIGHT", 0.4),
  candidatePool: num("CANDIDATE_POOL", 100),
  blacklist: list("INDEX_BLACKLIST"),

  filters: {
    minAgeHours: num("FILTER_MIN_AGE_HOURS", 72),
    minLiquidityUsd: num("FILTER_MIN_LIQUIDITY_USD", 250_000),
    minVolume24hUsd: num("FILTER_MIN_VOLUME_USD", 50_000),
    minSells24h: num("FILTER_MIN_SELLS", 200),
    maxBuySellRatio: num("FILTER_MAX_BUY_SELL_RATIO", 4),
    maxMcapToLiquidity: num("FILTER_MAX_MCAP_TO_LIQ", 60),
    madZ: num("FILTER_MAD_Z", 3.5),
  } satisfies ScreenFilters,

  holders: {
    minBalance: num("HOLDER_MIN_BALANCE", 10_000),
    maxWalletPct: num("HOLDER_MAX_WALLET_PCT", 3),
    iqrK: num("HOLDER_IQR_K", 3),
    sellTolerance: num("HOLDER_SELL_TOLERANCE", 0.0001),
    excludeOwners: list("HOLDER_EXCLUDE"),
  } satisfies HolderRules,

  /** Lamports kept in the keeper for tx fees and ATA rent. */
  solReserveLamports: Math.round(num("SOL_RESERVE", 0.25) * 1e9),
  /** Share of spendable SOL used for buys each epoch (rest stays as runway). */
  buyShare: num("BUY_SHARE", 0.9),
  slippageBps: num("SLIPPAGE_BPS", 300),
  priorityMicroLamports: num("PRIORITY_MICROLAMPORTS", 50_000),
  /** Allocations worth less than this are not sent; they roll into the next epoch. */
  minAllocationUsd: num("MIN_ALLOCATION_USD", 0.5),
  airdropBatch: num("AIRDROP_BATCH", 5),

  /** Hard cap on SOL spent buying the index in one epoch. */
  maxBuySolPerEpoch: num("MAX_BUY_SOL_PER_EPOCH", 5),
  /** Skip a buy whose quoted price impact is above this. */
  maxPriceImpactPct: num("MAX_PRICE_IMPACT_PCT", 3),
  /** A brand-new token account costs rent; only open one if the drop is worth this many times the rent. */
  newAccountValueMultiple: num("NEW_ACCOUNT_VALUE_MULTIPLE", 2),
  /** Never let an airdrop take the keeper below this many lamports. */
  gasFloorLamports: Math.round(num("GAS_FLOOR_SOL", 0.02) * 1e9),

  creatorFeePool: str("CREATOR_FEE_POOL", "pump"),
  claimFees: bool("CLAIM_FEES", true),

  jupApiKey: str("JUP_API_KEY", ""),
  jupApi: str("JUP_API_BASE", str("JUP_API_KEY") ? "https://api.jup.ag" : "https://lite-api.jup.ag"),

  /** Settle nothing while true (or while state/PAUSE exists). Snapshots keep running. */
  paused: bool("PAUSED", false),

  discordWebhook: str("DISCORD_WEBHOOK_URL", ""),
  telegramToken: str("TELEGRAM_BOT_TOKEN", ""),
  telegramChatId: str("TELEGRAM_CHAT_ID", ""),

  stateDir: path.resolve(root, str("STATE_DIR", "state")),
  publishDir: path.resolve(root, str("PUBLISH_DIR", "../web/data")),
};

export type Config = typeof config;

/** Refuse to start on settings that would misbehave with real money. */
export function validateConfig(cfg: Config): void {
  const errors: string[] = [];
  if (!["equal", "mcap"].includes(cfg.weighting)) errors.push(`INDEX_WEIGHTING must be "equal" or "mcap"`);
  if (cfg.epochMinutes < 5) errors.push("EPOCH_MINUTES must be at least 5");
  if (cfg.snapshotMinutes <= 0 || cfg.snapshotMinutes >= cfg.epochMinutes) errors.push("SNAPSHOT_MINUTES must be between 0 and EPOCH_MINUTES");
  if (cfg.buyShare <= 0 || cfg.buyShare > 1) errors.push("BUY_SHARE must be in (0, 1]");
  if (cfg.indexSize < 1 || cfg.indexSize > 20) errors.push("INDEX_SIZE must be 1-20");
  if (cfg.airdropBatch < 1 || cfg.airdropBatch > 6) errors.push("AIRDROP_BATCH must be 1-6 (bigger batches exceed the tx size limit)");
  if (cfg.slippageBps <= 0 || cfg.slippageBps > 2_000) errors.push("SLIPPAGE_BPS must be 1-2000");
  if (!cfg.dryRun) {
    if (!cfg.keeperSecret && !cfg.keeperKeypairPath) errors.push("Live mode needs KEEPER_SECRET_KEY or KEEPER_KEYPAIR_PATH");
    if (!cfg.pfxMint) errors.push("Live mode needs PFX_MINT");
    if (cfg.rpcUrl.includes("api.mainnet-beta.solana.com")) errors.push("Live mode needs a paid RPC_URL (the public RPC rate-limits snapshots)");
  }
  if (errors.length) throw new Error(`Invalid configuration:\n  - ${errors.join("\n  - ")}`);
}
