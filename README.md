# Polymarket Realtime Data Logger

This repo has been trimmed down to only collect **realtime market data** (CLOB `market` websocket) and user activity (Data API polling and/or CLOB `user` websocket when available), with timestamps suitable for correlation / reverse engineering.

## What it writes (analysis-friendly)

For each `slugId`, it writes to:

- `./<out>/<address>/by_slug/<slugId>/market.jsonl` — realtime market events (ms timestamps)
- `./<out>/<address>/by_slug/<slugId>/meta.json` — Gamma mapping (conditionId + token IDs + outcomes)

Each JSONL line is a “unified event record” with:
- `source`: `market_ws` / `user_ws` / `rest_poll`
- `receivedAtMs`: local receive time (ms)
- `eventAtMs`: server event time (ms when available)
- `slugId`, `conditionId`, `assetId`
- `data`: raw payload

## Run

### Market realtime websocket (recommended)

```bash
npm run store-user-trades -- --mode ws --ws-mode market --user 0x... --slug-prefix btc-updown-15m --out ./dataset --raw
```

### Hybrid: market websocket + user trades polling → one unified per-slug timeline (recommended for correlation)

```bash
npm run store-user-trades -- --mode ws --ws-mode market --with-rest --unified --user 0x... --slug-prefix btc-updown-15m --out ./dataset --interval 0.05 --limit 100 --raw
```

This writes **both** sources to:
- `./dataset/<address>/by_slug/<slugId>/events.jsonl`

### Alternative: on-chain monitoring (Polygon) instead of REST polling

Set in `.env`:
- `POLYGON_WS_URL` (a Polygon websocket RPC, e.g. Alchemy/Infura `wss://...`)

Run:

```bash
npm run store-user-trades -- --mode ws --ws-mode market --with-onchain --onchain-mode pending --unified --user 0x... --slug-prefix btc-updown-15m --out ./dataset
```

This writes `type:"onchain_tx"` events (mempool / block) into the same `events.jsonl` timeline when it can detect the market token IDs inside the transaction calldata.

### User websocket (requires valid CLOB ws credentials)

Set in `.env`:
- `CLOB_API_KEY`
- `CLOB_API_SECRET`
- `CLOB_API_PASSPHRASE`

Then:

```bash
npm run store-user-trades -- --mode ws --ws-mode user --user 0x... --slug-prefix btc-updown-15m --out ./user_trade_logs_dual_ws --raw
```

## Files

- Main script: `src/scripts/storeUserTradesRealtime.ts`
