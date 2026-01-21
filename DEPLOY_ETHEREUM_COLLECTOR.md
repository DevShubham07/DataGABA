# Deploy Ethereum 1h Market Collector to Fly.io

This guide will help you deploy the Ethereum 1-hour market data collector to Fly.io.

## Prerequisites

1. **Fly.io account**: Sign up at [fly.io](https://fly.io)
2. **Fly CLI**: Install the Fly CLI tool
3. **Credit card**: Fly.io requires a payment method (they have a free tier)

## Step-by-Step Deployment

### 1. Install Fly CLI

```bash
# macOS
brew install flyctl

# Linux/WSL
curl -L https://fly.io/install.sh | sh

# Windows (PowerShell)
iwr https://fly.io/install.ps1 -useb | iex
```

### 2. Login to Fly.io

```bash
fly auth login
```

This will open a browser window for authentication.

### 3. Initialize Fly.io App

```bash
# From the project root
fly launch --name polymarket-ethereum-collector
```

When prompted:
- **App name**: `polymarket-ethereum-collector` (or choose your own)
- **Region**: Choose closest to you (e.g., `iad` for US East, `lhr` for London)
- **Postgres/Redis**: Say "No" (we're using volumes for file storage)
- **Deploy now**: Say "No" (we'll set up secrets first)

### 4. Create Persistent Volume

```bash
# Create a volume for data storage (10GB should be enough initially)
fly volumes create polymarket_ethereum_data --size 10 --region iad
```

Replace `iad` with your chosen region. You can check available regions with:
```bash
fly regions list
```

### 5. Set Environment Variables (Secrets)

Set all required secrets:

```bash
# Required: User address to monitor
fly secrets set USER_ADDRESSES=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d

# Required: R2 credentials for Cloudflare R2 storage
fly secrets set R2_ACCOUNT_ID=your_r2_account_id
fly secrets set R2_ACCESS_KEY_ID=your_r2_access_key
fly secrets set R2_SECRET_ACCESS_KEY=your_r2_secret_key
fly secrets set R2_BUCKET_NAME=gabaeth

# Optional: WebSocket base URL (defaults to wss://ws-subscriptions-clob.polymarket.com)
# fly secrets set CLOB_WS_BASE=wss://ws-subscriptions-clob.polymarket.com
```

**Note**: Replace the example values with your actual values.

### 6. Update fly.toml

The `fly.toml` file is already configured, but verify it matches your setup:

```toml
app = 'polymarket-ethereum-collector'
primary_region = 'iad'  # Your chosen region

[[mounts]]
  source = 'polymarket_ethereum_data'
  destination = '/data'

[[vm]]
  cpu_kind = 'shared'
  cpus = 2
  memory_mb = 4096
```

### 7. Deploy

```bash
fly deploy
```

This will:
- Build the Docker image
- Push it to Fly.io
- Deploy your app
- Start the collector service

### 8. Verify Deployment

```bash
# Check app status
fly status

# View logs (should see WebSocket connection and data collection)
fly logs

# Check if processes are running
fly ssh console
# Then inside the container:
ps aux | grep node
ls -la /data/ethereum_1h_data  # Should show .jsonl files
```

## Monitoring

### View Logs

```bash
# Real-time logs
fly logs

# Follow logs
fly logs -a polymarket-ethereum-collector

# Filter logs
fly logs | grep "WebSocket"
fly logs | grep "ERROR"
```

### Check Status

```bash
# App status
fly status

# Machine status
fly machines list

# Volume status
fly volumes list
```

### SSH into Container

```bash
fly ssh console

# Inside the container, you can:
ls -la /data/ethereum_1h_data          # Check data files
ls -la /data/ethereum_market_ws_logs.jsonl  # Check WebSocket logs
df -h                                  # Check disk usage
```

## Data Management

### Download Data

```bash
# Option 1: SSH and copy
fly ssh console
tar -czf /tmp/data.tar.gz /data/ethereum_1h_data /data/ethereum_market_ws_logs.jsonl
exit

# Option 2: Use fly sftp (if available)
fly ssh sftp
```

### Backup Strategy

1. **R2 Storage**: Data is automatically uploaded to R2 when slugs become inactive
2. **Volume Snapshots**: Fly.io volumes can be snapshotted (if available in your plan)
3. **Periodic Downloads**: Set up a cron job to periodically download data

### Increase Volume Size

```bash
# List volumes
fly volumes list

# Extend volume (e.g., from 10GB to 20GB)
fly volumes extend <volume_id> --size 20
```

## Scaling & Performance

### Increase Resources

Edit `fly.toml`:

```toml
[[vm]]
  cpu_kind = 'shared'
  cpus = 4          # Increase CPU
  memory_mb = 8192   # Increase memory (from 4096)
```

Then redeploy:
```bash
fly deploy
```

### Monitor Resource Usage

```bash
fly status
fly metrics
```

## Troubleshooting

### App Won't Start

1. **Check logs**:
   ```bash
   fly logs
   ```

2. **Common issues**:
   - Missing environment variables → Set with `fly secrets set`
   - Volume not mounted → Check `fly volumes list` and `fly.toml` mount config
   - Out of memory → Increase `memory_mb` in `fly.toml`
   - WebSocket connection issues → Check network connectivity

### Out of Memory Errors

Increase memory in `fly.toml`:

```toml
[[vm]]
  memory_mb = 8192  # Increase from 4096
```

### Data Not Persisting

1. **Check volume is mounted**:
   ```bash
   fly ssh console
   ls -la /data
   ```

2. **Verify volume exists**:
   ```bash
   fly volumes list
   ```

3. **Check mount configuration in fly.toml**:
   ```toml
   [[mounts]]
     source = "polymarket_ethereum_data"
     destination = "/data"
   ```

### WebSocket Not Connecting

1. **Check logs for WebSocket errors**:
   ```bash
   fly logs | grep -i "websocket\|ws"
   ```

2. **Verify network connectivity**:
   ```bash
   fly ssh console
   curl -I https://gamma-api.polymarket.com
   ```

### Process Crashes

1. **Check logs for errors**:
   ```bash
   fly logs | grep -i error
   ```

2. **Restart the app**:
   ```bash
   fly apps restart polymarket-ethereum-collector
   ```

3. **Check if processes are running**:
   ```bash
   fly ssh console
   ps aux | grep node
   ```

### Disk Space Issues

```bash
# Check disk usage
fly ssh console
df -h

# If full, increase volume size
fly volumes extend <volume_id> --size 20
```

## Cost Optimization

- **Start small**: Begin with 2GB RAM, 2 CPU, 10GB volume
- **Monitor usage**: Use `fly metrics` to track resource usage
- **Scale as needed**: Increase resources only when necessary
- **Region selection**: Choose closest region for lower latency
- **R2 Storage**: Data is automatically uploaded to R2, reducing local storage needs

## Security

- ✅ Secrets are encrypted and stored securely
- ✅ Never commit `.env` files
- ✅ Use `fly secrets` for all sensitive data
- ✅ R2 credentials are stored as secrets

## Updating the App

```bash
# Make changes to your code
git add .
git commit -m "Update ethereum collector"

# Deploy updates
fly deploy

# Or deploy from a specific branch
fly deploy --remote-only
```

## Stopping the App

```bash
# Stop the app (but keep it deployed)
fly apps suspend polymarket-ethereum-collector

# Resume
fly apps resume polymarket-ethereum-collector

# Destroy the app (⚠️ deletes everything including data)
fly apps destroy polymarket-ethereum-collector
```

## Quick Reference

```bash
# Deploy
fly deploy

# View logs
fly logs

# Check status
fly status

# Set secrets
fly secrets set KEY=value

# SSH into container
fly ssh console

# Restart app
fly apps restart polymarket-ethereum-collector

# View volumes
fly volumes list

# Extend volume
fly volumes extend <volume_id> --size 20
```

## What the Script Does

1. **WebSocket Connection**: Connects to Polymarket WebSocket for real-time market data
2. **User Activity Polling**: Polls user activity API every 50ms
3. **Data Collection**: Collects events for Ethereum 1-hour markets
4. **File Writing**: Writes events to `<slug>.jsonl` files, sorted by `receivedAtMs`
5. **R2 Upload**: Automatically uploads files to R2 when slugs become inactive (5 minutes)
6. **Logging**: Logs all WebSocket events to `ethereum_market_ws_logs.jsonl`

## Expected Behavior

- Script runs continuously
- WebSocket connects and subscribes to Ethereum 1h markets
- User activity is polled and events are collected
- Both sources write to the same files, sorted chronologically
- Files are uploaded to R2 bucket `gabaeth` when markets become inactive
- Logs show WebSocket connection status and event counts
