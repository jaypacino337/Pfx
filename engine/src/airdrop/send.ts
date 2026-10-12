import {
  ComputeBudgetProgram,
  PublicKey,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { Allocation } from "./allocate.js";
import { sendInstructions } from "../chain/wallet.js";

export interface SendResult {
  signatures: string[];
  sent: bigint;
  failed: Allocation[];
}

export interface BatchOpts {
  batch: number;
  priorityMicroLamports: number;
}

/**
 * One airdrop transaction: for each recipient, create their token account if
 * missing (idempotent, keeper pays rent) and transfer. Holders never need to do
 * anything to receive.
 */
export function buildAirdropBatch(
  payer: PublicKey,
  mint: PublicKey,
  programId: PublicKey,
  decimals: number,
  chunk: Allocation[],
  priorityMicroLamports: number,
): TransactionInstruction[] {
  const source = getAssociatedTokenAddressSync(mint, payer, true, programId);
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 * chunk.length + 20_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
  ];
  for (const a of chunk) {
    const owner = new PublicKey(a.owner);
    const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, mint, programId),
      createTransferCheckedInstruction(source, mint, ata, payer, a.amount, decimals, [], programId),
    );
  }
  return ixs;
}

export async function sendAirdrop(
  conn: Connection,
  keeper: Keypair,
  mint: PublicKey,
  programId: PublicKey,
  decimals: number,
  allocations: Allocation[],
  opts: BatchOpts,
): Promise<SendResult> {
  const result: SendResult = { signatures: [], sent: 0n, failed: [] };
  for (let i = 0; i < allocations.length; i += opts.batch) {
    const chunk = allocations.slice(i, i + opts.batch);
    const ixs = buildAirdropBatch(keeper.publicKey, mint, programId, decimals, chunk, opts.priorityMicroLamports);
    try {
      result.signatures.push(await sendInstructions(conn, keeper, ixs));
      result.sent += chunk.reduce((s, a) => s + a.amount, 0n);
    } catch (err) {
      console.error(`[airdrop] batch ${i / opts.batch} failed, rolls over:`, (err as Error).message);
      result.failed.push(...chunk);
    }
  }
  return result;
}
