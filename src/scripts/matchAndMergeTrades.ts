#!/usr/bin/env ts-node
/**
 * Real-time trade matcher and merger
 * 
 * Watches events.jsonl files from both REST polling and on-chain monitoring,
 * matches transactions by tx hash, and creates merged JSON files per slug.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import * as dotenv from 'dotenv';

dotenv.config();

interface EventRecord {
    v: number;
    t: number;
    recv: number;
    src: 'market_ws' | 'rest_poll' | 'onchain' | 'user_ws';
    slug?: string;
    cid?: string;
    aid?: string;
    type: string;
    tx?: string;
    [key: string]: any;
}

interface MergedTrade {
    tx: string;
    slug: string;
    timestamp: number;
    timestampMs: number;
    receivedAtMs: number;
    // User activity from REST API polling
    rest?: {
        price?: number;
        size?: number;
        usdc?: number;
        side?: string;
        outcome?: string;
        asset?: string;
        assetId?: string;
        conditionId?: string;
        id?: string;
        timestamp?: number;
        endpoint?: string;
        [key: string]: any;
    };
    // Market WebSocket data around the time of trade
    marketEvents?: Array<{
        t: number;
        type: string;
        price?: number;
        bestBid?: number;
        bestAsk?: number;
        mid?: number;
        spread?: number;
        side?: string;
    }>;
}

const DATA_DIR = process.env.DATA_DIR || './dataset';
const MERGED_DIR = process.env.MERGED_DIR || './merged_trades';
const WATCH_INTERVAL_MS = 1000; // Check for new events every second
const MARKET_WINDOW_MS = 5000; // Include market events within ±5 seconds of trade

const sanitizeFileComponent = (input: string): string => {
    const cleaned = input
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');
    return cleaned.length > 0 ? cleaned : 'unknown';
};

const loadMergedTrades = (filePath: string): MergedTrade[] => {
    try {
        if (!fs.existsSync(filePath)) return [];
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
};

const saveMergedTrades = (filePath: string, trades: MergedTrade[]) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(trades, null, 2) + '\n', 'utf8');
};

const readEventsJsonl = (filePath: string): EventRecord[] => {
    try {
        if (!fs.existsSync(filePath)) return [];
        const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean);
        return lines.map((line) => {
            try {
                return JSON.parse(line) as EventRecord;
            } catch {
                return null;
            }
        }).filter((e): e is EventRecord => e !== null);
    } catch {
        return [];
    }
};

const getLastLineCount = (filePath: string): number => {
    try {
        if (!fs.existsSync(filePath)) return 0;
        const content = fs.readFileSync(filePath, 'utf8');
        return content.split('\n').filter(Boolean).length;
    } catch {
        return 0;
    }
};

const findEventsJsonlFiles = (baseDir: string, user: string): Map<string, string> => {
    const result = new Map<string, string>();
    const userDir = path.join(baseDir, sanitizeFileComponent(user), 'by_slug');
    if (!fs.existsSync(userDir)) return result;

    const entries = fs.readdirSync(userDir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const slugId = entry.name;
            const eventsPath = path.join(userDir, slugId, 'events.jsonl');
            if (fs.existsSync(eventsPath)) {
                result.set(slugId, eventsPath);
            }
        }
    }
    return result;
};

const mergeTrades = (
    restEvents: EventRecord[],
    marketEvents: EventRecord[],
    existingMerged: MergedTrade[]
): MergedTrade[] => {
    const merged = new Map<string, MergedTrade>();
    
    // Load existing merged trades (deduplicate by tx)
    for (const trade of existingMerged) {
        if (trade.tx) {
            const txLower = trade.tx.toLowerCase();
            const existing = merged.get(txLower);
            if (!existing || trade.timestampMs < existing.timestampMs) {
                merged.set(txLower, trade);
            }
        }
    }

    // Process REST polling events (user activity from REST API)
    for (const event of restEvents) {
        if (event.src !== 'rest_poll' || !event.tx) continue;
        const txLower = event.tx.toLowerCase();
        const existing = merged.get(txLower);
        
        const endpoint = (event as any).endpoint || (event as any).data?.endpoint || '/activity';
        
        if (existing) {
            // Update existing
            existing.rest = {
                price: event.price,
                size: event.size,
                usdc: event.usdc,
                side: event.side,
                outcome: event.outcome,
                asset: event.aid || event.asset,
                assetId: event.aid,
                conditionId: event.cid,
                id: (event as any).id,
                timestamp: event.t,
                endpoint: endpoint,
                ...(event as any).data,
            };
            existing.timestamp = Math.min(existing.timestamp, event.t);
            existing.timestampMs = Math.min(existing.timestampMs || event.t, event.t);
            existing.receivedAtMs = Math.max(existing.receivedAtMs, event.recv);
        } else {
            // Create new
            merged.set(txLower, {
                tx: event.tx,
                slug: event.slug || 'unknown',
                timestamp: event.t,
                timestampMs: event.t,
                receivedAtMs: event.recv,
                rest: {
                    price: event.price,
                    size: event.size,
                    usdc: event.usdc,
                    side: event.side,
                    outcome: event.outcome,
                    asset: event.aid || event.asset,
                    assetId: event.aid,
                    conditionId: event.cid,
                    id: (event as any).id,
                    timestamp: event.t,
                    endpoint: endpoint,
                    ...(event as any).data,
                },
            });
        }
    }

    // Add market events around trade times
    for (const trade of merged.values()) {
        if (!trade.marketEvents) trade.marketEvents = [];
        const tradeTime = trade.timestampMs;
        const windowStart = tradeTime - MARKET_WINDOW_MS;
        const windowEnd = tradeTime + MARKET_WINDOW_MS;
        
        for (const marketEvent of marketEvents) {
            if (marketEvent.src !== 'market_ws') continue;
            if (marketEvent.t >= windowStart && marketEvent.t <= windowEnd) {
                trade.marketEvents.push({
                    t: marketEvent.t,
                    type: marketEvent.type,
                    price: marketEvent.price,
                    bestBid: marketEvent.bestBid,
                    bestAsk: marketEvent.bestAsk,
                    mid: marketEvent.mid,
                    spread: marketEvent.spread,
                    side: marketEvent.side,
                });
            }
        }
        
        // Sort market events by time
        trade.marketEvents.sort((a, b) => a.t - b.t);
        
        // Remove empty marketEvents arrays to keep output clean
        if (trade.marketEvents.length === 0) {
            delete trade.marketEvents;
        }
    }

    // Convert to array and sort by timestamp
    return Array.from(merged.values()).sort((a, b) => a.timestampMs - b.timestampMs);
};

const watchAndMerge = async (user: string, dataDir: string, mergedDir: string) => {
    const userDir = path.join(dataDir, sanitizeFileComponent(user));
    const lastLineCounts = new Map<string, number>();
    let isFirstRun = true;
    
    console.log(`🔍 Watching events for user: ${user}`);
    console.log(`📂 Data dir: ${dataDir}`);
    console.log(`💾 Merged dir: ${mergedDir}`);
    console.log(`⏱  Check interval: ${WATCH_INTERVAL_MS}ms\n`);
    
    // Check if data directory exists
    if (!fs.existsSync(userDir)) {
        console.warn(`⚠️  User directory does not exist: ${userDir}`);
        console.warn(`   Waiting for logger to create events...\n`);
    }

    while (true) {
        try {
            const slugFiles = findEventsJsonlFiles(dataDir, user);
            
            if (isFirstRun && slugFiles.size === 0) {
                console.log(`⏳ No events.jsonl files found yet. Waiting for logger to create data...`);
            }
            
            for (const [slugId, eventsPath] of slugFiles.entries()) {
                const currentLineCount = getLastLineCount(eventsPath);
                const lastCount = lastLineCounts.get(eventsPath) || 0;
                
                // On first run, process all existing events; otherwise only new ones
                if (isFirstRun || currentLineCount > lastCount) {
                    // New events detected
                    const allEvents = readEventsJsonl(eventsPath);
                    const newEvents = allEvents.slice(lastCount);
                    
                    if (newEvents.length > 0) {
                        // User activity from REST API polling
                        const restEvents = allEvents.filter((e) => e.src === 'rest_poll' && e.tx);
                        
                        // Market activity from WebSocket
                        const marketEvents = allEvents.filter((e) => e.src === 'market_ws');
                        
                        // Only process if we have user trade events (rest)
                        if (restEvents.length > 0) {
                            const mergedPath = path.join(
                                mergedDir,
                                sanitizeFileComponent(user),
                                `${sanitizeFileComponent(slugId)}.json`
                            );
                            
                            const existing = loadMergedTrades(mergedPath);
                            const merged = mergeTrades(restEvents, marketEvents, existing);
                            
                            // Always save on first run or if there are new trades
                            const newMerged = merged.length - existing.length;
                            if (isFirstRun || newMerged > 0) {
                                saveMergedTrades(mergedPath, merged);
                                console.log(
                                    `[${new Date().toISOString()}] ✅ ${slugId}: ${isFirstRun ? 'Processed' : '+' + newMerged} merged trade(s) (total: ${merged.length}, rest: ${restEvents.length}, market_ws: ${marketEvents.length})`
                                );
                            }
                        } else if (isFirstRun) {
                            console.log(`   ${slugId}: No user trade events found (only ${allEvents.length} total events, ${marketEvents.length} market events)`);
                        }
                    }
                    
                    lastLineCounts.set(eventsPath, currentLineCount);
                }
            }
            
            if (isFirstRun) {
                isFirstRun = false;
                console.log(`✅ Initial processing complete. Now watching for new events...\n`);
            }
        } catch (error: any) {
            console.error(`❌ Error in watch loop:`, error.message);
        }
        
        await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
    }
};

const main = async () => {
    const args = process.argv.slice(2);
    
    // Parse arguments more carefully
    let userArg: string | undefined;
    let dataDirArg: string | undefined;
    let mergedDirArg: string | undefined;
    let runLogger = true;
    
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--user' && i + 1 < args.length) {
            userArg = args[i + 1];
            i++;
        } else if (arg.startsWith('--user=')) {
            userArg = arg.split('=')[1];
        } else if (arg === '--data-dir' && i + 1 < args.length) {
            dataDirArg = args[i + 1];
            i++;
        } else if (arg.startsWith('--data-dir=')) {
            dataDirArg = arg.split('=')[1];
        } else if (arg === '--merged-dir' && i + 1 < args.length) {
            mergedDirArg = args[i + 1];
            i++;
        } else if (arg.startsWith('--merged-dir=')) {
            mergedDirArg = arg.split('=')[1];
        } else if (arg === '--no-logger') {
            runLogger = false;
        }
    }
    
    const finalDataDir = dataDirArg || DATA_DIR;
    const finalMergedDir = mergedDirArg || MERGED_DIR;

    if (!userArg || !/^0x[a-fA-F0-9]{40}$/i.test(userArg)) {
        console.error(
            '\nUsage: npm run match-trades -- --user 0xYourAddress [--data-dir ./dataset] [--merged-dir ./merged_trades] [--no-logger]\n'
        );
        process.exit(1);
    }

    const user = userArg.toLowerCase();
    const dataDir = path.resolve(finalDataDir);
    const mergedDir = path.resolve(finalMergedDir);

    // Start the logger if requested
    let loggerProcess: any = null;
    if (runLogger) {
        console.log('🚀 Starting logger with REST polling + on-chain monitoring...\n');
        loggerProcess = spawn(
            'npm',
            ['run', 'store-user-trades', '--', '--mode', 'ws', '--ws-mode', 'market', '--with-rest', '--with-onchain', '--onchain-mode', 'block', '--unified', '--user', user, '--slug-prefix', 'btc-updown-15m', '--out', dataDir, '--interval', '2', '--limit', '100'],
            {
                stdio: 'inherit',
                shell: true,
                cwd: process.cwd(),
            }
        );
        
        loggerProcess.on('error', (err: Error) => {
            console.error('❌ Logger process error:', err);
        });
        
        // Wait a bit for logger to start
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    // Start watching and merging
    process.on('SIGINT', () => {
        console.log('\n🛑 Stopping...');
        if (loggerProcess) loggerProcess.kill();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 Stopping...');
        if (loggerProcess) loggerProcess.kill();
        process.exit(0);
    });

    await watchAndMerge(user, dataDir, mergedDir);
};

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
