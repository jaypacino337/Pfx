/**
 * Simulates real PFX airdrop transactions on mainnet against the real token
 * programs and the real basket coins (SPL Token and Token-2022). An existing
 * large holder of each coin stands in for the keeper. Read-only: nothing is
 * signed or sent (sigVerify is off for the simulation).
 *
 *   npm run test:chain            (uses RPC_URL, defaults to public mainnet)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync, unpackAccount } from "@solana/spl-token";
import { buildAirdropBatch } from "../../src/airdrop/send.js";
import { getMintInfo } from "../../src/holders/snapshot.js";
import type { Allocation } from "../../src/airdrop/allocate.js";
import { config } from "../../src/config.js";
import { quoteBuy } from "../../src/chain/swap.js";

const BATCH = 5;
const PRIORITY = 50_000;
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const latest = JSON.parse(fs.readFileSync(new URL("../../../web/data/latest.json", import.meta.url), "utf8")) as {
  index: { symbol: string; mint: string }[];
};
const coins = [
  ...latest.index.map((c) => ({ symbol: c.symbol, mint: c.mint })),
  // A fresh pump.fun Token-2022 coin, the same kind of token PFX itself will be.
  { symbol: "UDR (Token-2022)", mint: "wjEYRUp7SowPSp3eEGozus9kmCBbzTMVpzd5NdQpump" },
];

/**
 * A real wallet (not a pool) holding the coin and some SOL for rent, found
 * from the coin's recent trades. (getTokenLargestAccounts is blocked on the
 * public RPC.)
 */
async function findStandInKeeper(mint: PublicKey, programId: PublicKey) {
  const sigs = await conn.getSignaturesForAddress(mint, { limit: 25 }, "confirmed");
  for (const { signature, err } of sigs) {
    if (err) continue;
    const tx = await conn
      .getParsedTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })
      .catch(() => null); // newer tx versions the client can't parse: just try the next one
    for (const b of tx?.meta?.postTokenBalances ?? []) {
      const min = 10n ** BigInt(b.uiTokenAmount.decimals + 1);
      if (b.mint !== mint.toBase58() || !b.owner || BigInt(b.uiTokenAmount.amount) < min) continue;
      const owner = new PublicKey(b.owner);
      if (!PublicKey.isOnCurve(owner.toBytes())) continue;
      const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
      const info = await conn.getAccountInfo(ata, "confirmed");
      if (!info) continue;
      const acct = unpackAccount(ata, info, programId);
      if (acct.amount < min) continue;
      if ((await conn.getBalance(owner)) < 0.1e9) continue;
      return { owner, amount: acct.amount };
    }
  }
  return null;
}

async function simulate(payer: PublicKey, ixs: ReturnType<typeof buildAirdropBatch>) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(),
  );
  const size = tx.serialize().length;
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  return { size, err: sim.value.err, cu: sim.value.unitsConsumed ?? 0, logs: sim.value.logs ?? [] };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The public RPC throttles getTokenLargestAccounts hard; retry patiently.
async function patient<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= 5 || !/429/.test(String(e))) throw e;
      await sleep(8_000 * (i + 1));
    }
  }
}

let failed = 0;
for (const c of coins) {
  await sleep(3_000);
  try {
    const mint = new PublicKey(c.mint);
    const info = await getMintInfo(conn, mint);
    const keeper = await patient(() => findStandInKeeper(mint, info.programId));
    if (!keeper) {
      console.log(`- ${c.symbol}: no suitable stand-in holder, skipped`);
      continue;
    }
    // Five brand-new wallets: every recipient needs a token account created.
    const allocations: Allocation[] = Array.from({ length: BATCH }, () => ({
      owner: Keypair.generate().publicKey.toBase58(),
      amount: 10n ** BigInt(info.decimals),
    }));
    const ixs = buildAirdropBatch(keeper.owner, mint, info.programId, info.decimals, allocations, PRIORITY);
    const r = await simulate(keeper.owner, ixs);
    if (r.err) console.log(r.logs.slice(-8).join("\n"));
    assert.equal(r.err, null, `${c.symbol}: simulation failed ${JSON.stringify(r.err)}`);
    assert.ok(r.size <= 1232, `${c.symbol}: tx ${r.size} bytes > 1232`);
    assert.ok(r.cu <= 40_000 * BATCH + 20_000, `${c.symbol}: ${r.cu} CU over the limit we set`);
    // The buy leg: a real Jupiter swap tx for this wallet, simulated.
    if (latest.index.some((x) => x.mint === c.mint)) {
      const quote = await quoteBuy(config, c.mint, 10_000_000);
      const res = await fetch(`${config.jupApi}/swap/v1/swap`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quoteResponse: quote, userPublicKey: keeper.owner.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
      });
      assert.ok(res.ok, `${c.symbol}: Jupiter swap ${res.status}`);
      const { swapTransaction } = (await res.json()) as { swapTransaction: string };
      const swap = VersionedTransaction.deserialize(Buffer.from(swapTransaction, "base64"));
      const sim = await conn.simulateTransaction(swap, { sigVerify: false, replaceRecentBlockhash: true });
      if (sim.value.err) console.log((sim.value.logs ?? []).slice(-6).join("\n"));
      assert.equal(sim.value.err, null, `${c.symbol}: buy simulation failed ${JSON.stringify(sim.value.err)}`);
      console.log(`✔ ${c.symbol.padEnd(18)} buy 0.01 SOL via Jupiter (tx v${swap.version}) simulates OK`);
    }
    console.log(
      `✔ ${c.symbol.padEnd(18)} ${info.programId.toBase58().startsWith("Tokenz") ? "Token-2022" : "SPL Token "} · 5 new holders paid · ${r.size}/1232 bytes · ${r.cu}/${40_000 * BATCH + 20_000} CU`,
    );
  } catch (e) {
    failed++;
    console.error(`✖ ${c.symbol}: ${(e as Error).message}`);
  }
}
if (failed) process.exit(1);
