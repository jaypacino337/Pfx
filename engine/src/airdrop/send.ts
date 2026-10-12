import { ComputeBudgetProgram, PublicKey, type Connection, type Keypair } from "@solana/web3.js";
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

/**
 * Push `allocations` of one token from the keeper to holders, `batch` recipients
 * per transaction. Each recipient's token account is created if missing
 * (idempotent), so holders never need to do anything to receive.
 */
export async function sendAirdrop(
  conn: Connection,
  keeper: Keypair,
  mint: PublicKey,
  programId: PublicKey,
  decimals: number,
  allocations: Allocation[],
  opts: { batch: number; priorityMicroLamports: number },
): Promise<SendResult> {
  const source = getAssociatedTokenAddressSync(mint, keeper.publicKey, true, programId);
  const result: SendResult = { signatures: [], sent: 0n, failed: [] };

  for (let i = 0; i < allocations.length; i += opts.batch) {
    const chunk = allocations.slice(i, i + opts.batch);
    const ixs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 * chunk.length + 20_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: opts.priorityMicroLamports }),
    ];
    for (const a of chunk) {
      const owner = new PublicKey(a.owner);
      const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
      ixs.push(
        createAssociatedTokenAccountIdempotentInstruction(keeper.publicKey, ata, owner, mint, programId),
        createTransferCheckedInstruction(source, mint, ata, keeper.publicKey, a.amount, decimals, [], programId),
      );
    }
    try {
      result.signatures.push(await sendInstructions(conn, keeper, ixs));
      result.sent += chunk.reduce((s, a) => s + a.amount, 0n);
    } catch (err) {
      console.error(`[airdrop] batch ${i / opts.batch} failed, will roll over:`, (err as Error).message);
      result.failed.push(...chunk);
    }
  }
  return result;
}
