# Deploying to Fly.io Organization

Quick guide for deploying to a Fly.io organization.

## Step 1: Check Your Organizations

```bash
# List all organizations you have access to
fly orgs list

# Check your current/default organization
fly orgs show
```

## Step 2: Create App in Organization

```bash
# Replace YOUR_ORG_NAME with your actual organization name
fly launch --org YOUR_ORG_NAME
```

When prompted:
- **App name**: Choose a unique name (e.g., `polymarket-data-collector`)
- **Region**: Choose closest to you (e.g., `iad` for US East)
- **Postgres/Redis**: Say "No"
- **Deploy now**: Say "No" (we'll set up secrets first)

## Step 3: Create Volume

```bash
# Replace YOUR_APP_NAME with the app name you chose
fly volumes create polymarket_data --size 10 --region iad --app YOUR_APP_NAME
```

## Step 4: Set Secrets

```bash
# Replace YOUR_APP_NAME with your app name
fly secrets set TARGET_USER=0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d --app YOUR_APP_NAME
fly secrets set SLUG_PREFIX=btc-updown-15m --app YOUR_APP_NAME

# Optional: Set polling configuration
fly secrets set POLL_INTERVAL=5 --app YOUR_APP_NAME
fly secrets set POLL_LIMIT=100 --app YOUR_APP_NAME
```

## Step 5: Deploy

```bash
fly deploy --app YOUR_APP_NAME
```

## Step 6: Monitor

```bash
# View logs
fly logs --app YOUR_APP_NAME

# Check status
fly status --app YOUR_APP_NAME

# SSH into container
fly ssh console --app YOUR_APP_NAME
```

## Common Commands (Organization)

All commands need the `--app YOUR_APP_NAME` flag:

```bash
# View logs
fly logs --app YOUR_APP_NAME

# Check status
fly status --app YOUR_APP_NAME

# Set secrets
fly secrets set KEY=value --app YOUR_APP_NAME

# View secrets (without values)
fly secrets list --app YOUR_APP_NAME

# Restart app
fly apps restart YOUR_APP_NAME

# View volumes
fly volumes list --app YOUR_APP_NAME

# Extend volume
fly volumes extend <volume_id> --size 20 --app YOUR_APP_NAME
```

## Troubleshooting

### "App not found" error
- Make sure you're using the correct app name
- Verify the app is in your organization: `fly apps list --org YOUR_ORG_NAME`

### "Permission denied" error
- Verify you have the correct permissions in the organization
- Check with: `fly orgs show`

### Volume not mounting
- Ensure volume was created with `--app YOUR_APP_NAME`
- Check volume exists: `fly volumes list --app YOUR_APP_NAME`
- Verify mount in `fly.toml` matches volume name
