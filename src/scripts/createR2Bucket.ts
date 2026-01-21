#!/usr/bin/env node
/**
 * Script to verify R2 bucket access and configuration
 * Reads credentials from .env file
 * Verifies access to existing bucket (does not create new bucket)
 * Run: npm run verify-r2
 */

import { S3Client, HeadBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Load .env file from project root
dotenv.config({ path: path.join(__dirname, '../../.env') });

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'MergedLogs';

// R2 endpoint format: https://<account_id>.r2.cloudflarestorage.com
// This is Cloudflare's standard R2 API endpoint format
// The account_id is your Cloudflare account ID from the R2 API token
const R2_ENDPOINT = R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : '';

async function verifyBucket() {
    // Check credentials from .env
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        console.error('❌ R2 credentials not found in .env file');
        console.error('\nPlease add to your .env file:');
        console.error('  R2_ACCOUNT_ID=your_account_id');
        console.error('  R2_ACCESS_KEY_ID=your_access_key');
        console.error('  R2_SECRET_ACCESS_KEY=your_secret_key');
        console.error('  R2_BUCKET_NAME=MergedLogs');
        process.exit(1);
    }

    console.log('📋 Configuration from .env:');
    console.log(`   Account ID: ${R2_ACCOUNT_ID}`);
    console.log(`   Bucket Name: ${R2_BUCKET_NAME}`);
    console.log(`   Endpoint: ${R2_ENDPOINT}`);
    console.log(`   Access Key: ${R2_ACCESS_KEY_ID.substring(0, 8)}...`);
    console.log('');

    console.log('📝 Endpoint Explanation:');
    console.log(`   The endpoint "${R2_ENDPOINT}" is Cloudflare's standard R2 API endpoint.`);
    console.log(`   Format: https://<account_id>.r2.cloudflarestorage.com`);
    console.log(`   Your account ID: ${R2_ACCOUNT_ID}`);
    console.log(`   This endpoint is used for all R2 API operations (S3-compatible).`);
    console.log('');

    const client = new S3Client({
        region: 'auto',
        endpoint: R2_ENDPOINT,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });

    try {
        // Verify bucket exists and is accessible (does not create)
        console.log(`🔍 Verifying access to existing bucket "${R2_BUCKET_NAME}"...`);
        const headCommand = new HeadBucketCommand({
            Bucket: R2_BUCKET_NAME,
        });
        await client.send(headCommand);
        console.log(`✅ Bucket "${R2_BUCKET_NAME}" exists and is accessible`);

        // List some objects to verify read/write access
        console.log(`\n📦 Checking bucket contents...`);
        const listCommand = new ListObjectsV2Command({
            Bucket: R2_BUCKET_NAME,
            MaxKeys: 5,
        });
        const response = await client.send(listCommand);
        
        if (response.Contents && response.Contents.length > 0) {
            console.log(`   Found ${response.KeyCount || 0} object(s) (showing first 5):`);
            response.Contents.slice(0, 5).forEach((obj) => {
                const sizeKB = ((obj.Size || 0) / 1024).toFixed(2);
                console.log(`   - ${obj.Key} (${sizeKB} KB)`);
            });
            if ((response.KeyCount || 0) > 5) {
                console.log(`   ... and ${(response.KeyCount || 0) - 5} more`);
            }
        } else {
            console.log(`   Bucket is empty (ready for new uploads)`);
        }

        console.log(`\n✅ R2 configuration verified successfully!`);
        console.log(`   The data collector will automatically upload merged trades to this bucket.`);

    } catch (error: any) {
        console.error(`\n❌ Failed to access bucket:`, error.message || error);
        
        if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
            console.error(`\n💡 Bucket "${R2_BUCKET_NAME}" not found.`);
            console.error(`   Please create the bucket in Cloudflare Dashboard first:`);
            console.error(`   1. Go to https://dash.cloudflare.com/`);
            console.error(`   2. Navigate to R2 → Create bucket`);
            console.error(`   3. Name it: ${R2_BUCKET_NAME}`);
            console.error(`   4. Then run this script again to verify access`);
        } else if (error.name === 'Forbidden' || error.$metadata?.httpStatusCode === 403) {
            console.error(`\n💡 Permission denied. Check:`);
            console.error(`   1. API token has "Bucket Read & Write" permissions`);
            console.error(`   2. API token is for the correct Cloudflare account`);
            console.error(`   3. Credentials in .env are correct`);
        } else {
            console.error(`\n💡 Troubleshooting:`);
            console.error(`   1. Verify R2_ACCOUNT_ID in .env: ${R2_ACCOUNT_ID ? 'Set ✓' : 'NOT SET ✗'}`);
            console.error(`   2. Verify R2_ACCESS_KEY_ID in .env: ${R2_ACCESS_KEY_ID ? 'Set ✓' : 'NOT SET ✗'}`);
            console.error(`   3. Verify R2_SECRET_ACCESS_KEY in .env: ${R2_SECRET_ACCESS_KEY ? 'Set ✓' : 'NOT SET ✗'}`);
            console.error(`   4. Verify R2_BUCKET_NAME in .env: ${R2_BUCKET_NAME}`);
            console.error(`   5. Check endpoint: ${R2_ENDPOINT}`);
            if (error.$metadata) {
                console.error(`   6. HTTP Status: ${error.$metadata.httpStatusCode}`);
            }
        }
        process.exit(1);
    }
}

verifyBucket().catch((error) => {
    console.error('❌ Unexpected error:', error);
    process.exit(1);
});
