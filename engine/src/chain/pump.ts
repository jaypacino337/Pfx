import { PublicKey, type Connection } from "@solana/web3.js";

export const PUMP_PROGRAM = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");

/**
 * Read a pump.fun coin's creator from its bonding-curve account. The creator
 * is the wallet that can claim the coin's creator fees, so it must be the keeper.
 * Layout: 8 discriminator · 5×u64 reserves/supply · bool complete · creator pubkey.
 */
export async function pumpCreator(conn: Connection, mint: PublicKey): Promise<{ creator: string; graduated: boolean } | null> {
  const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), mint.toBuffer()], PUMP_PROGRAM);
  const acct = await conn.getAccountInfo(curve, "confirmed");
  if (!acct || acct.data.length < 81) return null;
  return {
    creator: new PublicKey(acct.data.subarray(49, 81)).toBase58(),
    graduated: acct.data[48] === 1,
  };
}
