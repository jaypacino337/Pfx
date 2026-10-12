import { Connection, PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";
import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getAccountLenForMint,
  getExtensionTypes,
  getMint,
} from "@solana/spl-token";
import bs58 from "bs58";
import type { Snapshot } from "./eligibility.js";

export interface MintInfo {
  programId: PublicKey;
  decimals: number;
  supply: bigint;
  /** Bytes of a holder token account for this mint (165, or more with Token-2022 extensions). */
  accountLen: number;
  /** Reasons PFX can't safely buy-and-airdrop this token. Empty means fine. */
  blockers: string[];
}

/** Token-2022 features that break a plain push airdrop or let the issuer claw tokens back. */
const BLOCKING: Partial<Record<ExtensionType, string>> = {
  [ExtensionType.TransferFeeConfig]: "transfer fee",
  [ExtensionType.TransferHook]: "transfer hook",
  [ExtensionType.NonTransferable]: "non-transferable",
  [ExtensionType.DefaultAccountState]: "accounts start frozen",
  [ExtensionType.PermanentDelegate]: "permanent delegate",
  [ExtensionType.PausableConfig]: "pausable",
  [ExtensionType.ConfidentialTransferMint]: "confidential transfers",
};

export async function getMintInfo(conn: Connection, mint: PublicKey): Promise<MintInfo> {
  const acct = await conn.getAccountInfo(mint);
  if (!acct) throw new Error(`Mint ${mint.toBase58()} not found`);
  const programId = acct.owner;
  const info = await getMint(conn, mint, "confirmed", programId);
  const blockers = getExtensionTypes(info.tlvData)
    .map((t) => BLOCKING[t])
    .filter((x): x is string => Boolean(x));
  if (info.freezeAuthority) blockers.push("freeze authority set");
  return {
    programId,
    decimals: info.decimals,
    supply: info.supply,
    accountLen: getAccountLenForMint(info),
    blockers,
  };
}

/**
 * Every holder of `mint`, aggregated per owner wallet. Works for both SPL Token
 * and Token-2022 (new pump.fun coins are Token-2022).
 */
export async function takeSnapshot(conn: Connection, mint: PublicKey, programId: PublicKey): Promise<Snapshot> {
  const filters: GetProgramAccountsFilter[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
  if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
    // Token-2022 accounts have variable size; byte 165 is AccountType (2 = Account).
    filters.push({ memcmp: { offset: 165, bytes: bs58.encode(Uint8Array.of(2)) } });
  } else {
    filters.push({ dataSize: 165 });
  }

  const accounts = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters,
    dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
  });

  const balances: Record<string, bigint> = {};
  for (const { account } of accounts) {
    const data = Buffer.from(account.data);
    if (data.length < 40) continue;
    const amount = data.readBigUInt64LE(32);
    if (amount === 0n) continue;
    const owner = new PublicKey(data.subarray(0, 32)).toBase58();
    balances[owner] = (balances[owner] ?? 0n) + amount;
  }

  return {
    takenAt: Date.now(),
    balances: Object.fromEntries(Object.entries(balances).map(([k, v]) => [k, v.toString()])),
  };
}

/** Owners that are PDAs (pools, bonding curves, program vaults) — not people. */
export function offCurveOwners(owners: Iterable<string>): string[] {
  const out: string[] = [];
  for (const o of owners) {
    if (!PublicKey.isOnCurve(new PublicKey(o).toBytes())) out.push(o);
  }
  return out;
}
