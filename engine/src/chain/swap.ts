import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import type { Config } from "../config.js";
import { sendVersioned } from "./wallet.js";

export const WSOL = "So11111111111111111111111111111111111111112";

export interface Quote {
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  [k: string]: unknown;
}

function headers(cfg: Config): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.jupApiKey) h["x-api-key"] = cfg.jupApiKey;
  return h;
}

export async function quoteBuy(cfg: Config, outputMint: string, lamports: number): Promise<Quote> {
  const url =
    `${cfg.jupApi}/swap/v1/quote?inputMint=${WSOL}&outputMint=${outputMint}` +
    `&amount=${Math.floor(lamports)}&slippageBps=${cfg.slippageBps}&restrictIntermediateTokens=true`;
  const res = await fetch(url, { headers: headers(cfg), signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Jupiter quote ${res.status}: ${await res.text()}`);
  return (await res.json()) as Quote;
}

/** Market-buy `outputMint` with SOL through Jupiter (routes PumpSwap, Raydium, Meteora, bonding curves). */
export async function buyWithSol(
  conn: Connection,
  keeper: Keypair,
  cfg: Config,
  outputMint: string,
  lamports: number,
): Promise<{ signature: string; quote: Quote }> {
  const quote = await quoteBuy(cfg, outputMint, lamports);
  const res = await fetch(`${cfg.jupApi}/swap/v1/swap`, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: keeper.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: "high" } },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`Jupiter swap ${res.status}: ${await res.text()}`);
  const { swapTransaction } = (await res.json()) as { swapTransaction: string };
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
  return { signature: await sendVersioned(conn, tx, keeper), quote };
}
