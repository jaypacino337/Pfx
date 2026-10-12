import { VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import type { Config } from "../config.js";
import { sendVersioned } from "./wallet.js";

/**
 * Claim the PFX creator fees from pump.fun into the keeper wallet. The keeper
 * must be the coin's creator (or the fee recipient it was assigned to).
 * Uses PumpPortal's local-transaction API: it builds the tx, we sign it.
 */
export async function claimCreatorFees(conn: Connection, keeper: Keypair, cfg: Config): Promise<string | null> {
  const body: Record<string, unknown> = {
    publicKey: keeper.publicKey.toBase58(),
    action: "collectCreatorFee",
    priorityFee: 0.000005,
    pool: cfg.creatorFeePool,
  };
  if (cfg.creatorFeePool !== "pump" && cfg.pfxMint) body.mint = cfg.pfxMint;

  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) {
    // Nothing to claim also comes back as a non-200 — not fatal for the epoch.
    console.warn(`[fees] claim skipped: ${res.status} ${await res.text().catch(() => "")}`);
    return null;
  }
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  return sendVersioned(conn, tx, keeper);
}
