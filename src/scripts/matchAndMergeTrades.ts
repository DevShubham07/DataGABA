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

interface MarketSnapshot {
    t: number;
    bestBid?: number;
    bestAsk?: number;
    mid?: number;
    spread?: number;
    price?: number;
}

const SNAPSHOTS_BEFORE_TRADE = 10; // Keep last N events before trade
const SNAPSHOTS_AFTER_TRADE = 10;  // Keep first N events after trade

interface MarketSummary {
    // Window info
    windowMs: number;
    eventCount: number;
    // Snapshots at key moments (arrays for more context)
    beforeTrade?: MarketSnapshot[];  // Last N events BEFORE trade (oldest first)
    afterTrade?: MarketSnapshot[];   // First N events AFTER trade (oldest first)
    atTrade?: MarketSnapshot;        // Event at exact trade time (if any)
    // Aggregate stats for the window
    stats?: {
        bidMin?: number;
        bidMax?: number;
        bidAvg?: number;
        askMin?: number;
        askMax?: number;
        askAvg?: number;
        spreadMin?: number;
        spreadMax?: number;
        spreadAvg?: number;
        midMin?: number;
        midMax?: number;
        midAvg?: number;
        priceChangeCount: number;
        lastTradePriceCount: number;
    };
    // Reference to raw data for full analysis
    rawDataRef?: {
        eventsFile: string;
        firstEventTime: number;
        lastEventTime: number;
    };
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
    // Compact market summary (replaces raw marketEvents)
    marketSummary?: MarketSummary;
    // Legacy: raw market events (only kept for small datasets or when explicitly requested)
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
const WATCH_INTERVAL_MS = 5000; // Check for new events every 5 seconds
const BATCH_WRITE_INTERVAL_MS = 30000; // Write merged files at most every 30 seconds
const MARKET_WINDOW_MS = 3000; // Include market events within ±3 seconds of trade (reduced from 5s)
const MAX_RAW_EVENTS_PER_TRADE = 100; // Only store raw events if below this threshold

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

// Market price record for separate price file
interface MarketPriceRecord {
    t: number;           // timestamp
    type: string;        // event type (price_change, last_trade_price)
    bestBid?: number;
    bestAsk?: number;
    mid?: number;
    spread?: number;
    price?: number;      // last trade price
    side?: string;
}

interface MarketPricesFile {
    slug: string;
    lastUpdated: string;
    totalEvents: number;
    firstEventTime?: number;
    lastEventTime?: number;
    // Summary stats
    stats: {
        bidMin?: number;
        bidMax?: number;
        askMin?: number;
        askMax?: number;
        spreadMin?: number;
        spreadMax?: number;
        priceMin?: number;
        priceMax?: number;
    };
    // All price records (compact format)
    prices: MarketPriceRecord[];
}

const loadMarketPrices = (filePath: string): MarketPricesFile | null => {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        if (!raw) return null;
        return JSON.parse(raw) as MarketPricesFile;
    } catch {
        return null;
    }
};

const saveMarketPrices = (filePath: string, data: MarketPricesFile) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
};

const buildMarketPricesFromEvents = (
    marketEvents: EventRecord[],
    slugId: string,
    existingPrices: MarketPricesFile | null
): MarketPricesFile => {
    // Build a set of existing timestamps to avoid duplicates
    const existingTimes = new Set<string>(
        existingPrices?.prices.map(p => `${p.t}:${p.type}:${p.price ?? ''}`) || []
    );
    
    // Extract new price records
    const newPrices: MarketPriceRecord[] = [];
    for (const event of marketEvents) {
        if (event.src !== 'market_ws') continue;
        
        const dedupKey = `${event.t}:${event.type}:${event.price ?? ''}`;
        if (existingTimes.has(dedupKey)) continue;
        existingTimes.add(dedupKey);
        
        newPrices.push({
            t: event.t,
            type: event.type,
            bestBid: event.bestBid,
            bestAsk: event.bestAsk,
            mid: event.mid,
            spread: event.spread,
            price: event.price,
            side: event.side,
        });
    }
    
    // Merge with existing prices
    const allPrices = [...(existingPrices?.prices || []), ...newPrices];
    allPrices.sort((a, b) => a.t - b.t);
    
    // Calculate stats (use reduce to avoid stack overflow with large arrays)
    let bidMin = Infinity, bidMax = -Infinity;
    let askMin = Infinity, askMax = -Infinity;
    let spreadMin = Infinity, spreadMax = -Infinity;
    let priceMin = Infinity, priceMax = -Infinity;
    let hasBid = false, hasAsk = false, hasSpread = false, hasPrice = false;
    
    for (const p of allPrices) {
        if (p.bestBid !== undefined) {
            hasBid = true;
            if (p.bestBid < bidMin) bidMin = p.bestBid;
            if (p.bestBid > bidMax) bidMax = p.bestBid;
        }
        if (p.bestAsk !== undefined) {
            hasAsk = true;
            if (p.bestAsk < askMin) askMin = p.bestAsk;
            if (p.bestAsk > askMax) askMax = p.bestAsk;
        }
        if (p.spread !== undefined) {
            hasSpread = true;
            if (p.spread < spreadMin) spreadMin = p.spread;
            if (p.spread > spreadMax) spreadMax = p.spread;
        }
        if (p.price !== undefined) {
            hasPrice = true;
            if (p.price < priceMin) priceMin = p.price;
            if (p.price > priceMax) priceMax = p.price;
        }
    }
    
    return {
        slug: slugId,
        lastUpdated: new Date().toISOString(),
        totalEvents: allPrices.length,
        firstEventTime: allPrices.length > 0 ? allPrices[0].t : undefined,
        lastEventTime: allPrices.length > 0 ? allPrices[allPrices.length - 1].t : undefined,
        stats: {
            bidMin: hasBid ? bidMin : undefined,
            bidMax: hasBid ? bidMax : undefined,
            askMin: hasAsk ? askMin : undefined,
            askMax: hasAsk ? askMax : undefined,
            spreadMin: hasSpread ? spreadMin : undefined,
            spreadMax: hasSpread ? spreadMax : undefined,
            priceMin: hasPrice ? priceMin : undefined,
            priceMax: hasPrice ? priceMax : undefined,
        },
        prices: allPrices,
    };
};

const readEventsJsonl = (filePath: string): EventRecord[] => {
    try {
        if (!fs.existsSync(filePath)) return [];
        
        // For very large files, process line-by-line to avoid memory issues
        const events: EventRecord[] = [];
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const lines = fileContent.split('\n');
        
        // Process line by line instead of loading all at once
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) {
                try {
                    const event = JSON.parse(trimmed) as EventRecord;
                    events.push(event);
                } catch {
                    // Skip invalid JSON lines
                }
            }
        }
        
        return events;
    } catch (error: any) {
        console.error(`❌ Error reading ${filePath}: ${error.message}`);
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

    // Add market context around trade times - create compact summaries
    for (const trade of merged.values()) {
        const tradeTime = trade.timestampMs;
        const windowStart = tradeTime - MARKET_WINDOW_MS;
        const windowEnd = tradeTime + MARKET_WINDOW_MS;
        
        // Collect all market events in the window
        const windowEvents: EventRecord[] = [];
        for (const marketEvent of marketEvents) {
            if (marketEvent.src !== 'market_ws') continue;
            if (marketEvent.t >= windowStart && marketEvent.t <= windowEnd) {
                windowEvents.push(marketEvent);
            }
        }
        
        // If no events in window, try to find closest market events (for trades before WS started)
        if (windowEvents.length === 0 && marketEvents.length > 0) {
            // Find closest market event (before or after)
            let closestEvent: EventRecord | null = null;
            let minDiff = Infinity;
            
            for (const marketEvent of marketEvents) {
                if (marketEvent.src !== 'market_ws') continue;
                const diff = Math.abs(marketEvent.t - tradeTime);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestEvent = marketEvent;
                }
            }
            
            // If closest event is within 30 seconds, use it (extended window for early trades)
            if (closestEvent && minDiff <= 30000) {
                // Use a wider window around the closest event
                const extendedWindowStart = Math.max(closestEvent.t - MARKET_WINDOW_MS, tradeTime - 10000);
                const extendedWindowEnd = Math.min(closestEvent.t + MARKET_WINDOW_MS, tradeTime + 10000);
                
                for (const marketEvent of marketEvents) {
                    if (marketEvent.src !== 'market_ws') continue;
                    if (marketEvent.t >= extendedWindowStart && marketEvent.t <= extendedWindowEnd) {
                        windowEvents.push(marketEvent);
                    }
                }
                
                // Sort by time
                windowEvents.sort((a, b) => a.t - b.t);
            }
        }
        
        if (windowEvents.length === 0) {
            // No market data available - skip
            continue;
        }
        
        // Sort by time
        windowEvents.sort((a, b) => a.t - b.t);
        
        // Find key snapshots - collect arrays for before/after
        const eventsBefore: MarketSnapshot[] = [];
        const eventsAfter: MarketSnapshot[] = [];
        let atTrade: MarketSnapshot | undefined;
        
        for (const event of windowEvents) {
            const snapshot: MarketSnapshot = {
                t: event.t,
                bestBid: event.bestBid,
                bestAsk: event.bestAsk,
                mid: event.mid,
                spread: event.spread,
                price: event.price,
            };
            
            if (event.t < tradeTime) {
                eventsBefore.push(snapshot);
            } else if (event.t === tradeTime) {
                atTrade = snapshot;
            } else if (event.t > tradeTime) {
                eventsAfter.push(snapshot);
            }
        }
        
        // Keep only the last N before and first N after
        const beforeTrade = eventsBefore.length > 0 
            ? eventsBefore.slice(-SNAPSHOTS_BEFORE_TRADE) // Last N (oldest to newest)
            : undefined;
        const afterTrade = eventsAfter.length > 0 
            ? eventsAfter.slice(0, SNAPSHOTS_AFTER_TRADE) // First N (oldest to newest)
            : undefined;
        
        // Calculate aggregate stats
        const bids: number[] = [];
        const asks: number[] = [];
        const spreads: number[] = [];
        const mids: number[] = [];
        let priceChangeCount = 0;
        let lastTradePriceCount = 0;
        
        for (const event of windowEvents) {
            if (typeof event.bestBid === 'number') bids.push(event.bestBid);
            if (typeof event.bestAsk === 'number') asks.push(event.bestAsk);
            if (typeof event.spread === 'number') spreads.push(event.spread);
            if (typeof event.mid === 'number') mids.push(event.mid);
            if (event.type === 'price_change') priceChangeCount++;
            if (event.type === 'last_trade_price') lastTradePriceCount++;
        }
        
        const calcStats = (arr: number[]) => {
            if (arr.length === 0) return undefined;
            const min = Math.min(...arr);
            const max = Math.max(...arr);
            const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
            return { min, max, avg: Math.round(avg * 10000) / 10000 };
        };
        
        const bidStats = calcStats(bids);
        const askStats = calcStats(asks);
        const spreadStats = calcStats(spreads);
        const midStats = calcStats(mids);
        
        // Create the compact market summary
        const marketSummary: MarketSummary = {
            windowMs: MARKET_WINDOW_MS,
            eventCount: windowEvents.length,
            beforeTrade,
            afterTrade,
            atTrade,
            stats: {
                bidMin: bidStats?.min,
                bidMax: bidStats?.max,
                bidAvg: bidStats?.avg,
                askMin: askStats?.min,
                askMax: askStats?.max,
                askAvg: askStats?.avg,
                spreadMin: spreadStats?.min,
                spreadMax: spreadStats?.max,
                spreadAvg: spreadStats?.avg,
                midMin: midStats?.min,
                midMax: midStats?.max,
                midAvg: midStats?.avg,
                priceChangeCount,
                lastTradePriceCount,
            },
            rawDataRef: {
                eventsFile: `events.jsonl`,
                firstEventTime: windowEvents[0].t,
                lastEventTime: windowEvents[windowEvents.length - 1].t,
            },
        };
        
        trade.marketSummary = marketSummary;
        
        // Only store raw events if there are few (for small datasets/debugging)
        if (windowEvents.length <= MAX_RAW_EVENTS_PER_TRADE) {
            trade.marketEvents = windowEvents.map(e => ({
                t: e.t,
                type: e.type,
                price: e.price,
                bestBid: e.bestBid,
                bestAsk: e.bestAsk,
                mid: e.mid,
                spread: e.spread,
                side: e.side,
            }));
        } else {
            // For large datasets, remove raw events (summary is enough)
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
    
    // Batched write state: track pending changes per slug
    const pendingMerges = new Map<string, { 
        merged: MergedTrade[]; 
        restCount: number; 
        marketCount: number;
        marketEvents: EventRecord[];  // Track market events for separate prices file
    }>();
    let lastWriteTime = 0;
    
    console.log(`🔍 Watching events for user: ${user}`);
    console.log(`📂 Data dir: ${dataDir}`);
    console.log(`💾 Merged dir: ${mergedDir}`);
    console.log(`⏱  Check interval: ${WATCH_INTERVAL_MS}ms, batch write interval: ${BATCH_WRITE_INTERVAL_MS}ms\n`);
    
    // Check if data directory exists
    if (!fs.existsSync(userDir)) {
        console.warn(`⚠️  User directory does not exist: ${userDir}`);
        console.warn(`   Waiting for logger to create events...\n`);
    }

    // Helper function to flush pending writes
    // Note: With the new summary-based approach, files are now compact (no raw market events)
    // so we shouldn't hit JSON string length limits anymore
    const flushPendingWrites = (force: boolean = false) => {
        const now = Date.now();
        const timeSinceLastWrite = now - lastWriteTime;
        
        // Only flush if enough time has passed or forced (e.g., on first run or shutdown)
        if (!force && timeSinceLastWrite < BATCH_WRITE_INTERVAL_MS) {
            return;
        }
        
        if (pendingMerges.size === 0) return;
        
        const toRemove: string[] = [];
        
        for (const [slugId, { merged, restCount, marketCount, marketEvents }] of pendingMerges.entries()) {
            const mergedPath = path.join(
                mergedDir,
                sanitizeFileComponent(user),
                `${sanitizeFileComponent(slugId)}.json`
            );
            
            // Path for separate market prices file
            const pricesPath = path.join(
                mergedDir,
                sanitizeFileComponent(user),
                `${sanitizeFileComponent(slugId)}_prices.json`
            );
            
            try {
                // Save merged trades
                saveMergedTrades(mergedPath, merged);
                
                // Save separate market prices file if we have market events
                let pricesSaved = 0;
                if (marketEvents.length > 0) {
                    try {
                        const existingPrices = loadMarketPrices(pricesPath);
                        const pricesData = buildMarketPricesFromEvents(marketEvents, slugId, existingPrices);
                        saveMarketPrices(pricesPath, pricesData);
                        pricesSaved = pricesData.totalEvents;
                    } catch (priceErr: any) {
                        // If prices file fails (too large), fall back to JSONL append
                        const pricesJsonlPath = pricesPath.replace('.json', '.jsonl');
                        try {
                            const newPrices = marketEvents
                                .filter(e => e.src === 'market_ws')
                                .map(e => JSON.stringify({
                                    t: e.t,
                                    type: e.type,
                                    bestBid: e.bestBid,
                                    bestAsk: e.bestAsk,
                                    mid: e.mid,
                                    spread: e.spread,
                                    price: e.price,
                                    side: e.side,
                                }))
                                .join('\n');
                            if (newPrices) {
                                fs.appendFileSync(pricesJsonlPath, newPrices + '\n', 'utf8');
                                pricesSaved = marketEvents.filter(e => e.src === 'market_ws').length;
                                console.log(`   ⚠️ ${slugId}: Prices too large for JSON, appended to ${path.basename(pricesJsonlPath)}`);
                            }
                        } catch {
                            console.error(`   ❌ ${slugId}: Failed to save prices: ${priceErr.message}`);
                        }
                    }
                }
                
                // Show if using summary vs raw events
                const hasSummary = merged.some(t => t.marketSummary);
                const hasRawEvents = merged.some(t => t.marketEvents && t.marketEvents.length > 0);
                const format = hasSummary ? (hasRawEvents ? 'summary+raw' : 'summary') : (hasRawEvents ? 'raw' : 'no-market');
                console.log(
                    `[${new Date().toISOString()}] 💾 ${slugId}: Wrote ${merged.length} trade(s) + ${pricesSaved > 0 ? pricesSaved + ' prices' : 'no prices'} (rest: ${restCount}, market: ${marketCount}, format: ${format})`
                );
                toRemove.push(slugId);
            } catch (err: any) {
                console.error(`❌ ${slugId}: Write error - ${err.message}`);
                // Still remove from pending to prevent infinite retry loop
                toRemove.push(slugId);
            }
        }
        
        // Remove processed files from pending
        for (const slug of toRemove) {
            pendingMerges.delete(slug);
        }
        
        lastWriteTime = now;
    };

    while (true) {
        try {
            const slugFiles = findEventsJsonlFiles(dataDir, user);
            
            if (isFirstRun && slugFiles.size === 0) {
                console.log(`⏳ No events.jsonl files found yet. Waiting for logger to create data...`);
            }
            
            // Process files one at a time to avoid memory issues
            for (const [slugId, eventsPath] of slugFiles.entries()) {
                const currentLineCount = getLastLineCount(eventsPath);
                const lastCount = lastLineCounts.get(eventsPath) || 0;
                
                // On first run, process all existing events; otherwise only new ones
                if (isFirstRun || currentLineCount > lastCount) {
                    // New events detected - process this file
                    const allEvents = readEventsJsonl(eventsPath);
                    const newEvents = allEvents.slice(lastCount);
                    
                    if (newEvents.length > 0 || isFirstRun) {
                        // User activity from REST API polling
                        const restEvents = allEvents.filter((e) => e.src === 'rest_poll' && e.tx);
                        
                        // Market activity from WebSocket - only for this slug
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
                            
                            // Check if there are actual changes
                            const existingPending = pendingMerges.get(slugId);
                            const previousLength = existingPending?.merged.length ?? existing.length;
                            const newMerged = merged.length - previousLength;
                            
                            if (isFirstRun || newMerged > 0 || marketEvents.length > 0) {
                                // Queue for batched write (include market events for separate prices file)
                                pendingMerges.set(slugId, {
                                    merged,
                                    restCount: restEvents.length,
                                    marketCount: marketEvents.length,
                                    marketEvents: marketEvents, // For separate prices file
                                });
                                
                                if (newMerged > 0) {
                                    console.log(
                                        `[${new Date().toISOString()}] ✅ ${slugId}: +${newMerged} new trade(s) queued (total: ${merged.length})`
                                    );
                                }
                            }
                            
                            // Force garbage collection hint by clearing large arrays after processing
                            // This helps free memory before processing next file
                            if (global.gc && allEvents.length > 100000) {
                                global.gc();
                            }
                        } else if (isFirstRun) {
                            console.log(`   ${slugId}: No user trade events found (only ${allEvents.length} total events, ${marketEvents.length} market events)`);
                        }
                    }
                    
                    lastLineCounts.set(eventsPath, currentLineCount);
                }
            }
            
            // Flush pending writes if enough time has passed
            flushPendingWrites(isFirstRun);
            
            if (isFirstRun) {
                isFirstRun = false;
                console.log(`✅ Initial processing complete. Now watching for new events...\n`);
                // Force garbage collection after initial processing to free memory
                if (global.gc) {
                    global.gc();
                }
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
