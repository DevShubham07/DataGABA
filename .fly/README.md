# Fly.io Deployment Guide

This directory contains Fly.io-specific configuration and deployment instructions.

## Quick Start

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

### 3. Create a Fly.io App

```bash
fly launch
```

This will:
- Create a new app (or use existing)
- Set up `fly.toml` configuration
- Deploy your app

### 4. Create Persistent Volume

```bash
# Create a volume for data storage (10GB recommended)
fly volumes create polymarket_data --size 10 --region iad
```

### 5. Set Environment Variables

```bash
# Required: Target user address
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d

# Optional: Slug prefix filter
fly secrets set SLUG_PREFIX=btc-updown-15m

# Optional: WebSocket credentials (if using authenticated user WS)
fly secrets set CLOB_API_KEY=your_key
fly secrets set CLOB_API_SECRET=your_secret
fly secrets set CLOB_API_PASSPHRASE=your_passphrase

# Optional: Polygon RPC (for on-chain monitoring)
fly secrets set POLYGON_RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_KEY
# OR
fly secrets set POLYGON_WS_URL=wss://polygon-mainnet.infura.io/v3/YOUR_KEY
```

### 6. Deploy

```bash
fly deploy
```

### 7. Monitor

```bash
# View logs
fly logs

# Check status
fly status

# SSH into the machine
fly ssh console
```

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TARGET_USER` | Yes | - | Ethereum address of user to track |
| `SLUG_PREFIX` | No | `btc-updown-15m` | Market slug prefix to filter |
| `DATA_DIR` | No | `/data/dataset` | Directory for raw events |
| `MERGED_DIR` | No | `/data/merged_trades` | Directory for merged trades |
| `CLOB_API_KEY` | No | - | Polymarket API key (for user WS) |
| `CLOB_API_SECRET` | No | - | Polymarket API secret |
| `CLOB_API_PASSPHRASE` | No | - | Polymarket API passphrase |
| `POLYGON_RPC_URL` | No | - | Polygon RPC endpoint (HTTP) |
| `POLYGON_WS_URL` | No | - | Polygon RPC endpoint (WebSocket) |

### Scaling

Edit `fly.toml` to adjust resources:

```toml
[compute]
  cpu_kind = "shared"
  cpus = 2          # Increase for more CPU
  memory_mb = 4096   # Increase for more memory
```

### Volume Management

```bash
# List volumes
fly volumes list

# Extend volume size
fly volumes extend <volume_id> --size 20

# Show volume details
fly volumes show <volume_id>
```

## Troubleshooting

### Out of Memory

If you see memory errors, increase memory in `fly.toml`:

```toml
[compute]
  memory_mb = 4096  # Increase from 2048
```

### Data Not Persisting

Ensure the volume is mounted:

```bash
fly volumes list
fly ssh console
ls -la /data  # Should show dataset and merged_trades
```

### Process Crashes

Check logs:

```bash
fly logs --app your-app-name
```

Common issues:
- Missing environment variables
- Volume not mounted
- Out of disk space

### Restart App

```bash
fly apps restart your-app-name
```

## Data Access

### Download Data

```bash
# SSH and copy data
fly ssh console
tar -czf data.tar.gz /data/dataset /data/merged_trades
exit

# Download via SCP (if enabled)
fly ssh sftp shell
get /data/dataset
get /data/merged_trades
```

### Backup Strategy

Consider setting up automated backups:

1. Use Fly.io's volume snapshots (if available)
2. Periodically download data via SSH
3. Use external storage (S3, etc.) for long-term backups

## Cost Optimization

- **Volume size**: Start with 10GB, increase as needed
- **Memory**: 2GB is usually sufficient, increase if needed
- **CPU**: Shared CPU is fine for this workload
- **Region**: Choose closest to your location for lower latency

## Security

- Never commit `.env` files
- Use `fly secrets` for sensitive data
- Restrict SSH access if needed
- Consider using Fly.io's private networking
