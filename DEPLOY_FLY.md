# Deploy to Fly.io

This guide will help you deploy the Polymarket data collector to Fly.io.

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

### 2.5. List Organizations (if deploying to an organization)

```bash
# List all organizations you have access to
fly orgs list

# Or check your current organization
fly orgs show
```

**Note**: If you're part of an organization, you'll need to use the `--org` flag in subsequent commands.

### 3. Initialize Fly.io App

```bash
# From the project root
# For personal account:
fly launch

# For organization deployment:
fly launch --org YOUR_ORG_NAME
```

When prompted:
- **App name**: Choose a unique name (or leave blank for auto-generated)
- **Region**: Choose closest to you (e.g., `iad` for US East, `lhr` for London)
- **Postgres/Redis**: Say "No" (we're using volumes for file storage)
- **Deploy now**: Say "No" (we'll set up secrets first)

### 4. Create Persistent Volume

```bash
# For personal account:
fly volumes create polymarket_data --size 10 --region iad

# For organization deployment:
fly volumes create polymarket_data --size 10 --region iad --app YOUR_APP_NAME --org YOUR_ORG_NAME
```

Replace `iad` with your chosen region. You can check available regions with:
```bash
fly regions list
```

**Note**: If you used `--org` during `fly launch`, the app is already associated with your organization.

### 5. Set Environment Variables (Secrets)

```bash
# For personal account:
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d

# For organization deployment:
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d --app YOUR_APP_NAME

# Optional: Slug prefix filter
fly secrets set SLUG_PREFIX=btc-updown-15m --app YOUR_APP_NAME

# Optional: Polling configuration (defaults: interval=5, limit=100)
fly secrets set POLL_INTERVAL=5 --app YOUR_APP_NAME
fly secrets set POLL_LIMIT=100 --app YOUR_APP_NAME

# Optional: WebSocket credentials (if using authenticated user WS)
# fly secrets set CLOB_API_KEY=your_key --app YOUR_APP_NAME
# fly secrets set CLOB_API_SECRET=your_secret --app YOUR_APP_NAME
# fly secrets set CLOB_API_PASSPHRASE=your_passphrase --app YOUR_APP_NAME

# Optional: Polygon RPC (for on-chain monitoring)
# fly secrets set POLYGON_RPC_URL=https://polygon-mainnet.infura.io/v3/YOUR_KEY --app YOUR_APP_NAME
# OR
# fly secrets set POLYGON_WS_URL=wss://polygon-mainnet.infura.io/v3/YOUR_KEY --app YOUR_APP_NAME
```

**Note**: 
- Replace the example values with your actual values
- If deploying to an organization, always include `--app YOUR_APP_NAME` in secret commands
- You can also set multiple secrets at once: `fly secrets set KEY1=value1 KEY2=value2 --app YOUR_APP_NAME`

### 6. Update fly.toml (if needed)

Edit `fly.toml` to match your app name and region:

```toml
app = "your-app-name"
primary_region = "iad"  # Your chosen region
```

### 7. Deploy

```bash
# For personal account:
fly deploy

# For organization deployment (if app is in org, it will automatically deploy to org):
fly deploy --app YOUR_APP_NAME
```

This will:
- Build the Docker image
- Push it to Fly.io
- Deploy your app
- Start the services

**Note**: If you used `--org` during `fly launch`, the app is already associated with your organization and `fly deploy` will work automatically.

### 8. Verify Deployment

```bash
# Check app status
fly status --app YOUR_APP_NAME

# View logs
fly logs --app YOUR_APP_NAME

# Check if processes are running
fly ssh console --app YOUR_APP_NAME
# Then inside the container:
ps aux | grep node
ls -la /data  # Should show dataset and merged_trades directories
```

## Monitoring

### View Logs

```bash
# Real-time logs
fly logs

# Follow logs
fly logs -a your-app-name

# Filter logs
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
ls -la /data/dataset          # Check data files
ls -la /data/merged_trades   # Check merged files
df -h                         # Check disk usage
```

## Data Management

### Download Data

```bash
# Option 1: SSH and copy
fly ssh console
tar -czf /tmp/data.tar.gz /data/dataset /data/merged_trades
exit

# Then download via SCP (if you have SSH access configured)
# Or use fly ssh sftp
```

### Backup Strategy

1. **Volume Snapshots**: Fly.io volumes can be snapshotted (if available in your plan)
2. **Periodic Downloads**: Set up a cron job to periodically download data
3. **External Storage**: Consider syncing to S3 or similar for long-term storage

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
[compute]
  cpu_kind = "shared"
  cpus = 2          # Increase CPU
  memory_mb = 4096   # Increase memory (from 2048)
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

### Out of Memory Errors

Increase memory in `fly.toml`:

```toml
[compute]
  memory_mb = 4096  # Increase from 2048
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
     source = "polymarket_data"
     destination = "/data"
   ```

### Process Crashes

1. **Check logs for errors**:
   ```bash
   fly logs | grep -i error
   ```

2. **Restart the app**:
   ```bash
   fly apps restart your-app-name
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

- **Start small**: Begin with 2GB RAM, 1 CPU, 10GB volume
- **Monitor usage**: Use `fly metrics` to track resource usage
- **Scale as needed**: Increase resources only when necessary
- **Region selection**: Choose closest region for lower latency

## Security

- ✅ Secrets are encrypted and stored securely
- ✅ Never commit `.env` files
- ✅ Use `fly secrets` for all sensitive data
- ✅ Consider using Fly.io's private networking for additional security

## Updating the App

```bash
# Make changes to your code
git add .
git commit -m "Update data collector"

# Deploy updates
fly deploy

# Or deploy from a specific branch
fly deploy --remote-only
```

## Stopping the App

```bash
# Stop the app (but keep it deployed)
fly apps suspend your-app-name

# Resume
fly apps resume your-app-name

# Destroy the app (⚠️ deletes everything)
fly apps destroy your-app-name
```

## Additional Resources

- [Fly.io Documentation](https://fly.io/docs/)
- [Fly.io CLI Reference](https://fly.io/docs/flyctl/)
- [Fly.io Pricing](https://fly.io/docs/about/pricing/)

## Quick Reference

### Personal Account
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
fly apps restart your-app-name

# View volumes
fly volumes list

# Extend volume
fly volumes extend <volume_id> --size 20
```

### Organization Account
```bash
# Deploy
fly deploy --app YOUR_APP_NAME

# View logs
fly logs --app YOUR_APP_NAME

# Check status
fly status --app YOUR_APP_NAME

# Set secrets
fly secrets set KEY=value --app YOUR_APP_NAME

# SSH into container
fly ssh console --app YOUR_APP_NAME

# Restart app
fly apps restart YOUR_APP_NAME --org YOUR_ORG_NAME

# View volumes
fly volumes list --app YOUR_APP_NAME

# Extend volume
fly volumes extend <volume_id> --size 20 --app YOUR_APP_NAME
```
