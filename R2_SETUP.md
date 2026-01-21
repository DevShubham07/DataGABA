# Cloudflare R2 Setup Guide

Complete guide for setting up Cloudflare R2 storage for merged trade data.

## Overview

This project automatically uploads merged trade data to Cloudflare R2, providing:
- **Cloud backup** of all merged trades
- **Free egress** (no download fees)
- **S3-compatible API** for easy access
- **Automatic redundancy** and durability

## Prerequisites

- Cloudflare account with R2 enabled
- R2 API credentials (Account ID, Access Key ID, Secret Access Key)

## Step 1: Get R2 Credentials

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Navigate to **R2** → **Manage R2 API Tokens**
3. Click **Create API Token**
4. Configure token:
   - **Token name**: `polymarket-data-collector` (or any name)
   - **Permissions**: 
     - ✅ **Object Read & Write**
     - ✅ **Bucket Read & Write**
   - **TTL**: Leave blank for no expiration (or set expiration date)
5. Click **Create API Token**
6. **IMPORTANT**: Copy and save these values immediately (you won't see them again):
   - **Account ID**
   - **Access Key ID** 
   - **Secret Access Key**

## Step 2: Create R2 Bucket

### Method 1: Using Script (Recommended)

```bash
# Set environment variables
export R2_ACCOUNT_ID=your_account_id
export R2_ACCESS_KEY_ID=your_access_key
export R2_SECRET_ACCESS_KEY=your_secret_key
export R2_BUCKET_NAME=MergedLogs

# Verify R2 access (reads from .env file)
npm run verify-r2
```

Expected output:
```
🔍 Checking if bucket "MergedLogs" exists...
📦 Creating bucket "MergedLogs"...
✅ Successfully created bucket "MergedLogs"
```

### Method 2: Using Cloudflare Dashboard

1. Go to **R2** in Cloudflare Dashboard
2. Click **Create bucket**
3. Enter bucket name: `MergedLogs`
4. Select location (optional, defaults to auto)
5. Click **Create bucket**

## Step 3: Configure Environment Variables

### Local Development

Add to your `.env` file:

```bash
# R2 Credentials
R2_ACCOUNT_ID=your_account_id_here
R2_ACCESS_KEY_ID=your_access_key_here
R2_SECRET_ACCESS_KEY=your_secret_key_here
R2_BUCKET_NAME=MergedLogs
```

**Security Note**: Never commit `.env` to git (already in `.gitignore`)

### Fly.io Deployment

Set secrets using Fly CLI:

```bash
# Replace YOUR_APP_NAME with your actual app name
fly secrets set R2_ACCOUNT_ID=your_account_id --app YOUR_APP_NAME
fly secrets set R2_ACCESS_KEY_ID=your_access_key --app YOUR_APP_NAME
fly secrets set R2_SECRET_ACCESS_KEY=your_secret_key --app YOUR_APP_NAME
fly secrets set R2_BUCKET_NAME=MergedLogs --app YOUR_APP_NAME
```

Verify secrets are set:
```bash
fly secrets list --app YOUR_APP_NAME
```

## Step 4: Verify Setup

### Local Testing

1. Start the data collector:
   ```bash
   npm run store-user-trades -- --mode ws --ws-mode market --with-rest --unified --user 0x... --slug-prefix btc-updown-15m --out ./dataset
   ```

2. In another terminal, start the merger:
   ```bash
   npm run match-trades -- --user 0x... --no-logger
   ```

3. Watch for R2 upload messages:
   ```
   ☁️  Uploaded to R2: merged_trades/0x.../btc-updown-15m-1234567890.json
   ```

### Fly.io Deployment

After deploying, check logs:
```bash
fly logs --app YOUR_APP_NAME | grep "R2"
```

You should see:
```
☁️  R2 storage: Enabled (bucket: MergedLogs)
☁️  Uploaded to R2: merged_trades/...
```

## R2 Storage Structure

Files are organized in R2 as follows:

```
MergedLogs/
└── merged_trades/
    └── <user_address>/
        ├── <slug_id>.json              # Merged trades with market context
        └── <slug_id>_prices.json        # Market price data
```

**Example paths:**
- `merged_trades/0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d/btc-updown-15m-1768851000.json`
- `merged_trades/0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d/btc-updown-15m-1768851000_prices.json`

## Accessing Data from R2

### Cloudflare Dashboard

1. Go to **R2** → **MergedLogs** bucket
2. Navigate to `merged_trades/` folder
3. Browse by user address → slug ID
4. Click any file to preview or download

### Programmatic Access

The project includes utilities in `src/utils/r2Client.ts`:

```typescript
import { downloadFromR2, existsInR2 } from './utils/r2Client';

// Check if file exists
const exists = await existsInR2('merged_trades/0x.../slug.json');

// Download file
const content = await downloadFromR2('merged_trades/0x.../slug.json');
if (content) {
    const data = JSON.parse(content);
    // Use data...
}
```

### Using AWS CLI (S3-Compatible)

Configure AWS CLI for R2:

```bash
# Install AWS CLI if needed
brew install awscli  # macOS
# or
pip install awscli

# Configure for R2
aws configure set aws_access_key_id YOUR_R2_ACCESS_KEY_ID
aws configure set aws_secret_access_key YOUR_R2_SECRET_ACCESS_KEY
aws configure set region auto
```

List files:
```bash
aws s3 ls s3://MergedLogs/merged_trades/ \
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

Download file:
```bash
aws s3 cp s3://MergedLogs/merged_trades/0x.../slug.json ./local-file.json \
  --endpoint-url https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
```

## Cost Estimation

Cloudflare R2 pricing (as of 2024):

| Item | Cost |
|------|------|
| Storage | $0.015 per GB/month |
| Class A Operations (writes) | $4.50 per million |
| Class B Operations (reads) | $0.36 per million |
| Egress | **FREE** (no egress fees!) |

### Example Monthly Cost

For typical usage:
- **Storage**: 10 GB → $0.15/month
- **Writes**: ~10,000 writes → $0.045/month
- **Reads**: ~1,000 reads → $0.00036/month
- **Total**: ~$0.20/month

**Note**: R2 is extremely cost-effective for this use case, especially with free egress.

## Troubleshooting

### "R2 credentials not configured" Warning

**Symptoms**: Logs show `⚠️ R2 storage: Not configured`

**Solutions**:
1. Verify all three environment variables are set:
   ```bash
   echo $R2_ACCOUNT_ID
   echo $R2_ACCESS_KEY_ID
   echo $R2_SECRET_ACCESS_KEY
   ```
2. Check for typos or extra spaces
3. Restart the application after setting variables
4. For Fly.io: Verify secrets with `fly secrets list --app YOUR_APP_NAME`

### "Bucket not found" Error

**Symptoms**: Upload fails with bucket not found error

**Solutions**:
1. Verify bucket name matches exactly (case-sensitive): `MergedLogs`
2. Check bucket exists in Cloudflare Dashboard
3. Verify API token has bucket permissions
4. Try creating bucket again: `npm run create-r2-bucket`

### Upload Failures

**Symptoms**: No `☁️ Uploaded to R2` messages in logs

**Solutions**:
1. Check API token permissions (needs Object Read & Write)
2. Verify bucket name in environment: `R2_BUCKET_NAME=MergedLogs`
3. Check network connectivity
4. Review error logs for specific error messages
5. Test credentials manually:
   ```bash
   npm run create-r2-bucket  # Should succeed if credentials are valid
   ```

### Files Not Appearing in R2

**Symptoms**: Scripts run but files don't show in dashboard

**Solutions**:
1. Wait 10-30 seconds (uploads are async)
2. Refresh Cloudflare Dashboard
3. Check application logs for upload errors
4. Verify correct bucket name
5. Check file path structure matches expected format

### Permission Denied Errors

**Symptoms**: 403 Forbidden errors

**Solutions**:
1. Regenerate API token with correct permissions
2. Verify token hasn't expired
3. Check token has access to the specific bucket
4. Ensure token is for the correct Cloudflare account

## Security Best Practices

1. **Never commit credentials** to version control
   - Already in `.gitignore`
   - Use environment variables only

2. **Use separate tokens** for different environments
   - Development token
   - Production token
   - Different permissions if needed

3. **Rotate tokens periodically**
   - Every 90 days recommended
   - Update in all environments when rotating

4. **Limit token permissions**
   - Only grant necessary permissions
   - Use least privilege principle

5. **Monitor token usage**
   - Check Cloudflare Dashboard → R2 → API Tokens
   - Review access logs if available

6. **Use token expiration** (optional)
   - Set TTL when creating token
   - Forces regular rotation

## Monitoring & Maintenance

### Check Storage Usage

1. Cloudflare Dashboard → **R2** → **MergedLogs**
2. View storage metrics and file count

### Monitor Costs

1. Cloudflare Dashboard → **Billing** → **R2**
2. View current month usage and costs

### Set Up Alerts (Optional)

1. Cloudflare Dashboard → **Notifications**
2. Create alert for:
   - Storage threshold (e.g., > 100 GB)
   - High API usage
   - Unusual activity

### Lifecycle Policies (Optional)

Set up automatic cleanup for old data:

1. Cloudflare Dashboard → **R2** → **MergedLogs** → **Lifecycle**
2. Create policy:
   - Delete files older than X days
   - Or move to cheaper storage tier

## Backup Strategy

R2 provides excellent durability, but consider:

1. **R2 Redundancy**: Data automatically replicated across multiple locations
2. **Versioning**: Enable in bucket settings for file history
3. **External Backups**: Periodically export critical data
4. **Local Copies**: Keep recent data in Fly.io volumes as backup

## Next Steps

After setup:

1. ✅ Verify bucket creation: `npm run create-r2-bucket`
2. ✅ Set environment variables (local or Fly.io)
3. ✅ Test upload: Run data collector and merger
4. ✅ Verify files in Cloudflare Dashboard
5. ✅ Monitor costs and usage

## Support

- **Cloudflare R2 Docs**: https://developers.cloudflare.com/r2/
- **R2 API Reference**: https://developers.cloudflare.com/r2/api/s3/api/
- **Project Issues**: Check project repository for known issues
