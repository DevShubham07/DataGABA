#!/usr/bin/env node
/**
 * Startup script for Fly.io deployment
 * Runs both data collector and merger processes
 */

import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { isR2Configured, getR2BucketName } from '../utils/r2Client';

const TARGET_USER = process.env.TARGET_USER || '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const SLUG_PREFIX = process.env.SLUG_PREFIX || 'btc-updown-15m';
const DATA_DIR = process.env.DATA_DIR || '/data/dataset';
const MERGED_DIR = process.env.MERGED_DIR || '/data/merged_trades';
const POLL_INTERVAL = process.env.POLL_INTERVAL || '5';
const POLL_LIMIT = process.env.POLL_LIMIT || '100';

console.log('🚀 Starting Polymarket Data Collector on Fly.io');
console.log(`📊 Target user: ${TARGET_USER}`);
console.log(`🎯 Slug prefix: ${SLUG_PREFIX}`);
console.log(`📂 Data dir: ${DATA_DIR}`);
console.log(`💾 Merged dir: ${MERGED_DIR}`);

// Check R2 configuration
if (isR2Configured()) {
    console.log(`☁️  R2 storage: Enabled (bucket: ${getR2BucketName()})`);
} else {
    console.log(`⚠️  R2 storage: Not configured (data will only be stored locally)`);
}
console.log('');

// Ensure data directories exist
[DATA_DIR, MERGED_DIR].forEach((dir) => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
    }
});

// Start data collector
console.log('📡 Starting data collector...');
const collector = spawn(
    'node',
    [
        '--max-old-space-size=2048',
        '-r',
        'ts-node/register',
        path.join(__dirname, 'storeUserTradesRealtime.ts'),
        '--mode',
        'ws',
        '--ws-mode',
        'market',
        '--with-rest',
        '--unified',
        '--user',
        TARGET_USER,
        '--slug-prefix',
        SLUG_PREFIX,
        '--out',
        DATA_DIR,
        '--interval',
        POLL_INTERVAL,
        '--limit',
        POLL_LIMIT,
    ],
    {
        stdio: 'inherit',
        env: { ...process.env },
    }
);

// Start merger
console.log('🔄 Starting trade merger...');
const merger = spawn(
    'node',
    [
        '--max-old-space-size=8192',
        '--expose-gc',
        '-r',
        'ts-node/register',
        path.join(__dirname, 'matchAndMergeTrades.ts'),
        '--user',
        TARGET_USER,
        '--data-dir',
        DATA_DIR,
        '--merged-dir',
        MERGED_DIR,
        '--no-logger',
    ],
    {
        stdio: 'inherit',
        env: { ...process.env },
    }
);

// Handle process exits
const handleExit = (name: string, code: number | null, signal: string | null) => {
    console.error(`\n❌ ${name} exited with code ${code} signal ${signal}`);
    // Kill other process
    if (name === 'collector') {
        merger.kill('SIGTERM');
    } else {
        collector.kill('SIGTERM');
    }
    process.exit(code || 1);
};

collector.on('exit', (code, signal) => handleExit('Collector', code, signal));
merger.on('exit', (code, signal) => handleExit('Merger', code, signal));

// Handle errors
collector.on('error', (err) => {
    console.error('❌ Collector error:', err);
    process.exit(1);
});

merger.on('error', (err) => {
    console.error('❌ Merger error:', err);
    process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('\n🛑 Received SIGTERM, shutting down gracefully...');
    collector.kill('SIGTERM');
    merger.kill('SIGTERM');
    setTimeout(() => {
        console.log('⚠️  Force exit after timeout');
        process.exit(0);
    }, 10000);
});

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    collector.kill('SIGTERM');
    merger.kill('SIGTERM');
    setTimeout(() => {
        console.log('⚠️  Force exit after timeout');
        process.exit(0);
    }, 10000);
});

console.log('✅ Both processes started. Waiting...\n');
