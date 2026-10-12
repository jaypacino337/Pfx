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

npm run index             # screen the market, print the basket + hidden outliers (no wallet needed)
npm run preflight         # go/no-go check before going live (read-only)
npm run epoch             # settle one epoch now
npm start                 # run forever: snapshot every 5 min, settle every 45 min
npm test                  # unit tests: screen, weights, eligibility, allocation, send planning
npm run test:chain        # simulate real buy + airdrop txs on mainnet (read-only, nothing signed)
```

`DRY_RUN=true` is the default. Dry runs screen the live market, take real holder snapshots (if `PFX_MINT` is set), check token accounts and compute every allocation, but never sign a transaction.

## Go-live runbook

**1. Launch PFX on pump.fun** from the wallet that will be the keeper. Only the coin's creator can claim its creator fees. If you launched from another wallet, use that wallet's key as the keeper.

**2. Prepare the server.** Any small VPS works (1 vCPU, 1 GB RAM).
- A paid Solana RPC (Helius, Triton, QuickNode). Live mode refuses the public RPC.
- A free Jupiter API key from portal.jup.ag (optional, raises rate limits).
- A Discord webhook or Telegram bot for alerts.

**3. Configure** `engine/.env`: `RPC_URL`, `KEEPER_SECRET_KEY`, `PFX_MINT`, alerts. Keep `DRY_RUN=true`. `chmod 600 engine/.env`.

**4. Deploy** (Docker, with automatic HTTPS for your domain):
```bash
DOMAIN=pfx.example.com docker compose up -d --build
docker compose logs -f engine
```
Or without Docker: `deploy/pfx-engine.service` (systemd) plus any static host for `web/`.

**5. Watch two or three dry epochs** (about 2 hours). Check the HQ site: basket, hidden outliers, holder counts, wallet checker. The first epoch only records the holder baseline; payouts start from the second.

**6. Preflight.** `docker compose exec engine node --import tsx src/main.ts preflight` (or `npm run preflight`). It must say **GO**: keeper is the creator, snapshot works, every basket coin quotes cleanly, fee claim simulates.

**7. Go live.** Set `DRY_RUN=false`, keep `MAX_BUY_SOL_PER_EPOCH` low for the first day, then `docker compose up -d`. Watch the first live epoch's alert and the transaction links on HQ.

**Kill switch:** `docker compose exec engine touch /state/PAUSE` (or `PAUSED=true`). Settlement stops at the next epoch; snapshots continue. Remove the file to resume.

## Safety rails

| Rail | What it does |
|---|---|
| Dry run default | Nothing is signed until `DRY_RUN=false`. Live mode refuses to start without a keeper, mint and paid RPC. |
| Creator check | Preflight reads the creator from pump.fun's bonding curve on chain and blocks if it isn't the keeper. |
| Spend caps | `MAX_BUY_SOL_PER_EPOCH`, `SOL_RESERVE`, `BUY_SHARE`, and buys skip quotes with more than `MAX_PRICE_IMPACT_PCT` impact. |
| Token checks | Coins with transfer fees, transfer hooks, freeze authority, permanent delegates and similar are never bought. The next coin takes the slot. |
| Account cost | A holder without a token account only gets a drop worth `NEW_ACCOUNT_VALUE_MULTIPLE`× the rent. Airdrops never take the keeper below `GAS_FLOOR_SOL`. Biggest holders are paid first if gas runs short. |
| Nothing lost | Small shares, rounding dust, failed batches and coins that leave the basket stay in the keeper and go out in later epochs. |
| Crash safe | The epoch is committed before any airdrop is sent, and each airdrop sends the keeper's real balance. A crash mid-drop never pays anyone twice. |
| One engine | A lease lock in the state dir refuses a second engine, even across containers. |
| Clean stop | SIGTERM finishes the current step before exiting, so an airdrop is never left half sent. |
| Confirmation | Transactions are re-broadcast until confirmed or their blockhash expires, so a dropped tx can't land late. |
| Alerts | Every live epoch result and every failure goes to Discord or Telegram. |

## Operating notes

- **Rent**: on chain the rent for a holder token account is about 0.0015-0.002 SOL, paid by the keeper the first time a holder receives a given coin. In a dry run with 2,000 eligible holders and a 500 SOL budget, account rent was about 3% of the budget. With small budgets, shares that can't cover rent roll over until they can.
- **Economics**: each holder's share is split across 5 coins, so tiny holders need a bigger pot before they clear `MIN_ALLOCATION_USD`. Until then their share accumulates in the treasury.
- **Keys**: the keeper key holds the treasury. Use a dedicated wallet; everything above `SOL_RESERVE` in it is treated as buy budget.
- **APIs**: pump.fun's frontend API, DexScreener, Jupiter and PumpPortal are third-party services. Each buy, claim and airdrop is its own transaction. A failure is logged and alerted, and the funds roll over.

Memecoins are extremely volatile. Nothing here is financial advice.
