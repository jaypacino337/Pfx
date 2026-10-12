import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createCloseAccountInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { Config } from "../config.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/**
 * Sign, send and confirm a versioned tx. Re-broadcasts every 2s until it
 * confirms or its blockhash expires, so a dropped packet never stalls an epoch
 * and an expired tx can never land later and double-spend.
 */
export async function sendVersioned(conn: Connection, tx: VersionedTransaction, signer: Keypair): Promise<string> {
  tx.sign([signer]);
  const raw = tx.serialize();
  const sig = bs58.encode(tx.signatures[0]!);
  const blockhash = tx.message.recentBlockhash;
  await conn.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 0 });

  const deadline = Date.now() + 120_000;
  for (;;) {
    await sleep(2_000);
    const { value } = await conn.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`Tx ${sig} failed: ${JSON.stringify(st.err)}`);
    if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") return sig;

    const valid = await conn.isBlockhashValid(blockhash, { commitment: "confirmed" }).then((r) => r.value).catch(() => true);
    if (!valid || Date.now() > deadline) {
      await sleep(2_000);
      const last = (await conn.getSignatureStatuses([sig], { searchTransactionHistory: true })).value[0];
      if (last && !last.err && last.confirmationStatus) return sig;
      throw new Error(`Tx ${sig} expired before confirming`);
    }
    await conn.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
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

/** Some fee paths pay in wrapped SOL. Close the keeper's WSOL account so it counts as spendable SOL. */
export async function unwrapWsol(conn: Connection, keeper: Keypair): Promise<string | null> {
  const ata = getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey, false, TOKEN_PROGRAM_ID);
  const info = await conn.getAccountInfo(ata, "confirmed");
  if (!info) return null;
  return sendInstructions(conn, keeper, [
    createCloseAccountInstruction(ata, keeper.publicKey, keeper.publicKey, [], TOKEN_PROGRAM_ID),
  ]);
}

/** Retry flaky RPC reads (rate limits, timeouts) with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await sleep(1_000 * 2 ** i);
    }
  }
}

/** Which of `addresses` exist on chain. */
export async function existingAccounts(conn: Connection, addresses: PublicKey[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < addresses.length; i += 100) {
    const chunk = addresses.slice(i, i + 100);
    const infos = await withRetry(() => conn.getMultipleAccountsInfo(chunk, "confirmed"));
    infos.forEach((info, j) => {
      if (info) out.add(chunk[j]!.toBase58());
    });
  }
  return out;
}
