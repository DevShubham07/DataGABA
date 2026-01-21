# Fly.io Deployment Summary

## Scripts Running

The deployment automatically runs these two scripts:

### 1. Data Collector
Equivalent to:
```bash
npm run store-user-trades -- \
  --mode ws \
  --ws-mode market \
  --with-rest \
  --unified \
  --user 0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d \
  --slug-prefix btc-updown-15m \
  --out /data/dataset \
  --interval 5 \
  --limit 100
```

### 2. Trade Merger
Equivalent to:
```bash
npm run match-trades -- \
  --user 0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d \
  --no-logger
```

## Configuration

### Required Environment Variables
- `TARGET_USER`: Set via `fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d`

### Optional Environment Variables
- `SLUG_PREFIX`: Defaults to `btc-updown-15m`
- `POLL_INTERVAL`: Defaults to `5` seconds
- `POLL_LIMIT`: Defaults to `100` trades per poll
- `DATA_DIR`: Defaults to `/data/dataset`
- `MERGED_DIR`: Defaults to `/data/merged_trades`

## Quick Deploy Commands

### Personal Account
```bash
# 1. Login
fly auth login

# 2. Create app (if not exists)
fly launch

# 3. Create volume
fly volumes create polymarket_data --size 10 --region iad

# 4. Set secrets
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d
fly secrets set SLUG_PREFIX=btc-updown-15m

# 5. Deploy
fly deploy

# 6. Monitor
fly logs
```

### Organization Account
```bash
# 1. Login
fly auth login

# 2. List organizations
fly orgs list

# 3. Create app in organization
fly launch --org YOUR_ORG_NAME

# 4. Create volume (replace YOUR_APP_NAME with your app name)
fly volumes create polymarket_data --size 10 --region iad --app YOUR_APP_NAME

# 5. Set secrets
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d --app YOUR_APP_NAME
fly secrets set SLUG_PREFIX=btc-updown-15m --app YOUR_APP_NAME

# 6. Deploy
fly deploy --app YOUR_APP_NAME

# 7. Monitor
fly logs --app YOUR_APP_NAME
```

## Data Storage

- **Raw events**: `/data/dataset/<user>/by_slug/<slugId>/events.jsonl`
- **Merged trades**: `/data/merged_trades/<user>/<slugId>.json`
- **Market prices**: `/data/merged_trades/<user>/<slugId>_prices.json`

All data is stored on a persistent Fly.io volume.
