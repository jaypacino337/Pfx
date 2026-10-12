# PFX — the Pump.fun Index

Hold PFX. Every 45 minutes PFX buys the top 5 pump.fun coins and airdrops them to every wallet that held through the whole epoch. If you sell during an epoch, you forfeit that epoch's drop. Bot-pumped outlier coins are filtered out before anything is bought.

```
engine/   TypeScript keeper: claims fees, picks the index, buys, snapshots holders, airdrops
web/      PFX HQ: static dashboard (countdown, basket, hidden outliers, wallet check, log)
```

## How an epoch works

1. **Claim fees.** The keeper (PFX's creator wallet) claims pump.fun creator fees through PumpPortal.
2. **Screen and pick.** It pulls about 100 coins from pump.fun's market-cap leaderboard, joins them with DexScreener pool data, and hides outliers. The top 5 survivors by market cap become the basket (equal weight by default).
3. **Buy.** Spendable SOL is split by weight and bought through Jupiter.
4. **Airdrop.** It compares a final holder snapshot with the snapshots taken every 5 minutes during the epoch. Wallets that never dipped below their epoch-start balance are paid pro rata, in all five tokens.

### Coin outliers (hidden from the index)

pump.fun's leaderboard is dominated by coins with fake numbers. On the day this was built, the #1 coin claimed a $1.46B market cap with $3.3M of liquidity and 53 buys for every sell. A coin is hidden if any of these apply:

| Rule | Default |
|---|---|
| Too new | < 72 h old |
| Thin liquidity | < $250K |
| Low volume | < $50K / 24h |
| Almost no sells | < 200 sells / 24h |
| Wash buys | buy/sell ratio > 4 |
| Unbacked market cap | mcap / liquidity > 60 |
| Copycat ticker | only the deepest pool per ticker survives |
| Statistical outlier | robust z-score (median/MAD) of log(mcap/liq) > 3.5 |

### Holder rules (the epoch)

- **eligible**: held at least `HOLDER_MIN_BALANCE` at epoch start and never dipped below it. Paid on the epoch-start balance.
- **sold**: balance dropped below its epoch-start level at any snapshot (a sell or a transfer out). Forfeits this epoch.
- **pending**: arrived mid-epoch. Starts counting next epoch, so buying right before the drop gets nothing extra.
- **capped**: whale outlier. Still paid, but weight is clipped to the lower of `HOLDER_MAX_WALLET_PCT` and an IQR fence on log balances.
- **excluded**: pools, the bonding curve, program wallets (off-curve owners) and `HOLDER_EXCLUDE`.
- **dust**: below the minimum.

Shares worth less than `MIN_ALLOCATION_USD`, rounding dust and failed batches stay in the keeper and roll into the next epoch.

## Run it

```bash
cd engine
npm install
cp .env.example .env      # fill RPC_URL, keeper wallet, PFX_MINT

npm run index             # screen the market and print the basket + hidden outliers (no wallet needed)
npm run epoch             # settle one epoch now
npm start                 # run forever: snapshot every 5 min, settle every 45 min
npm test                  # unit tests for the screen, weights, eligibility and allocation
```

`DRY_RUN=true` is the default. Dry runs screen the live market, take real holder snapshots (if `PFX_MINT` is set) and compute every allocation, but never sign a transaction. Flip it to `false` only after watching a few dry epochs.

The engine writes `web/data/latest.json`, `web/data/wallets.json` and `web/data/epochs/<n>.json`. Serve `web/` with any static host (Vercel, Netlify, Cloudflare Pages, nginx) next to the engine, or sync `web/data` to wherever the site lives.

```bash
cd web && python3 -m http.server 8080
```

## Operating notes

- **RPC**: holder snapshots use `getProgramAccounts`. The public RPC worked during testing, but use a paid RPC in production.
- **Rent**: every first-time recipient of a token needs a token account (~0.002 SOL each, paid by the keeper). With many holders and 5 tokens this is the main running cost. Raise `MIN_ALLOCATION_USD` to keep it in check. `SOL_RESERVE` covers it.
- **Keys**: the keeper key holds the treasury. Run the engine on a machine you control and keep `.env` out of git (it's ignored).
- **APIs**: pump.fun's frontend API, DexScreener, Jupiter and PumpPortal are third-party services. Every buy, claim and airdrop is a separate transaction that can fail without breaking the epoch. Failures are logged and the funds roll over.

Memecoins are extremely volatile. Nothing here is financial advice.
