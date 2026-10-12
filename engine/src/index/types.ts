export interface Candidate {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  createdAt: number;
  marketCapUsd: number;
  liquidityUsd: number;
  volume24hUsd: number;
  buys24h: number;
  sells24h: number;
  priceUsd: number;
  priceChange24h: number;
  dex: string;
  pairUrl: string;
  /** Pump.fun reports these; we drop them at the source. */
  banned?: boolean;
  nsfw?: boolean;
}

export interface Verdict {
  candidate: Candidate;
  hidden: boolean;
  reasons: string[];
}

export interface Constituent extends Candidate {
  weight: number;
}
