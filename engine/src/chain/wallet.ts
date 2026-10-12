import fs from "node:fs";
import {
  Connection,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  type PublicKey,
  type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Config } from "../config.js";

export function connect(cfg: Config): Connection {
  return new Connection(cfg.rpcUrl, { commitment: "confirmed" });
}

export function loadKeeper(cfg: Config): Keypair {
  if (cfg.keeperSecret) {
    const s = cfg.keeperSecret.trim();
    const bytes = s.startsWith("[") ? Uint8Array.from(JSON.parse(s) as number[]) : bs58.decode(s);
    return Keypair.fromSecretKey(bytes);
  }
  if (cfg.keeperKeypairPath) {
    const raw = JSON.parse(fs.readFileSync(cfg.keeperKeypairPath, "utf8")) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(raw));
  }
  throw new Error("No keeper wallet: set KEEPER_SECRET_KEY or KEEPER_KEYPAIR_PATH");
}

/** Sign, send, and confirm a versioned tx, re-broadcasting until it lands or expires. */
export async function sendVersioned(conn: Connection, tx: VersionedTransaction, signer: Keypair): Promise<string> {
  tx.sign([signer]);
  const raw = tx.serialize();
  const { lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });

  for (;;) {
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`Tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
      throw new Error(`Tx ${sig} expired before confirming`);
    }
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

export async function sendInstructions(
  conn: Connection,
  payer: Keypair,
  ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: blockhash, instructions: ixs });
  return sendVersioned(conn, new VersionedTransaction(msg.compileToV0Message()), payer);
}

export async function solBalance(conn: Connection, owner: PublicKey): Promise<number> {
  return conn.getBalance(owner, "confirmed");
}
