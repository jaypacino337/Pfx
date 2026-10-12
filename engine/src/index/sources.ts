import type { Candidate } from "./types.js";

const PUMP_API = "https://frontend-api-v3.pump.fun";
const DEX_API = "https://api.dexscreener.com";

async function getJson<T>(url: string, init?: RequestInit, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
      return (await res.json()) as T;
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 1_000 * 2 ** i));
    }
  }
  throw last;
}

interface PumpCoin {
  mint: string;
  name: string;
  symbol: string;
  image_uri?: string;
  created_timestamp: number;
  complete?: boolean;
  is_banned?: boolean;
  nsfw?: boolean;
}

interface DexPair {
  dexId: string;
  url: string;
  baseToken: { address: string; symbol: string };
  priceUsd?: string;
  txns?: { h24?: { buys: number; sells: number } };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

/** Pump.fun's own ranking by market cap. Raw — full of noise; screen() cleans it. */
export async function fetchPumpCoins(limit: number): Promise<PumpCoin[]> {
  const pageSize = 50;
  const out: PumpCoin[] = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    const url = `${PUMP_API}/coins?offset=${offset}&limit=${Math.min(pageSize, limit - offset)}&sort=market_cap&order=DESC&includeNsfw=false`;
    const page = await getJson<PumpCoin[]>(url);
    out.push(...page);
    if (page.length < pageSize) break;
  }
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.mint) ? false : (seen.add(c.mint), true)));
}

/** Deepest DexScreener pair per mint. */
export async function fetchDexPairs(mints: string[]): Promise<Map<string, DexPair>> {
  const best = new Map<string, DexPair>();
  for (let i = 0; i < mints.length; i += 30) {
    const chunk = mints.slice(i, i + 30);
    const pairs = await getJson<DexPair[]>(`${DEX_API}/tokens/v1/solana/${chunk.join(",")}`);
    for (const p of pairs) {
      const mint = p.baseToken.address;
      const cur = best.get(mint);
      if (!cur || (p.liquidity?.usd ?? 0) > (cur.liquidity?.usd ?? 0)) best.set(mint, p);
    }
  }
  return best;
}

export async function fetchCandidates(limit: number): Promise<Candidate[]> {
  const coins = (await fetchPumpCoins(limit)).filter((c) => c.complete !== false);
  const pairs = await fetchDexPairs(coins.map((c) => c.mint));
  const out: Candidate[] = [];
  for (const c of coins) {
    const p = pairs.get(c.mint);
    if (!p) continue;
    out.push({
      mint: c.mint,
      symbol: c.symbol.trim(),
      name: c.name.trim(),
      image: c.image_uri ?? "",
      createdAt: c.created_timestamp,
      marketCapUsd: p.marketCap ?? p.fdv ?? 0,
      liquidityUsd: p.liquidity?.usd ?? 0,
      volume24hUsd: p.volume?.h24 ?? 0,
      buys24h: p.txns?.h24?.buys ?? 0,
      sells24h: p.txns?.h24?.sells ?? 0,
      priceUsd: Number(p.priceUsd ?? 0),
      priceChange24h: p.priceChange?.h24 ?? 0,
      dex: p.dexId,
      pairUrl: p.url,
      banned: c.is_banned,
      nsfw: c.nsfw,
    });
  }
  return out;
}

export async function fetchUsdPrice(mint: string, jupApi: string): Promise<number> {
  const data = await getJson<Record<string, { usdPrice?: number }>>(`${jupApi}/price/v3?ids=${mint}`);
  return data[mint]?.usdPrice ?? 0;
}
