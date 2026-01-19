#!/usr/bin/env ts-node
/**
 * Market WebSocket User Activity Monitor (Strategy 2)
 * 
 * Subscribes to market WebSocket feeds and filters for specific user activity.
 * Lowest latency approach for monitoring user trades.
 */

import WebSocket from 'ws';
import axios from 'axios';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

interface TradeEvent {
    timestamp: number;
    transactionHash: string;
    slug?: string;
    conditionId?: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    usdcSize: number;
    asset: string;
    outcome?: string;
    user: string;
    block?: number;
    orderHash?: string;
    maker?: string;
    taker?: string;
}

const TARGET_USER = '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const OUTPUT_DIR = path.join(process.cwd(), 'ws_user_activity', TARGET_USER);
const SLUG_PREFIX = 'btc-updown-15m';
const REST_POLL_INTERVAL_MS = 200; // Fallback REST polling interval

// Track current slug for file switching
let currentSlug: string | null = null;
let currentFileHandle: fs.WriteStream | null = null;
const seenTrades = new Set<string>();

const sanitizeFileComponent = (input: string): string => {
    return input
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '') || 'unknown';
};

const getLogFilePath = (slug: string): string => {
    const slugSanitized = sanitizeFileComponent(slug);
    const slugDir = path.join(OUTPUT_DIR, slugSanitized);
    if (!fs.existsSync(slugDir)) {
        fs.mkdirSync(slugDir, { recursive: true });
    }
    return path.join(slugDir, 'trades.jsonl');
};

const switchLogFile = (slug: string) => {
    // Close current file if open
    if (currentFileHandle) {
        currentFileHandle.end();
        currentFileHandle = null;
    }

    // Open new file
    const filePath = getLogFilePath(slug);
    currentFileHandle = fs.createWriteStream(filePath, { flags: 'a' });
    currentSlug = slug;
    console.log(`📝 Switched to log file: ${filePath}`);
};

const writeTrade = (trade: TradeEvent) => {
    const slug = trade.slug || 'unknown';
    
    // Switch file if slug changed
    if (currentSlug !== slug) {
        switchLogFile(slug);
    }

    // Ensure file is open
    if (!currentFileHandle) {
        switchLogFile(slug);
    }

    // Write trade as JSONL
    const line = JSON.stringify(trade) + '\n';
    currentFileHandle?.write(line);
    
    console.log(
        `[${new Date(trade.timestamp * 1000).toISOString()}] ⚡ ${trade.side} ${trade.size} @ ${trade.price} | ${trade.slug} | tx: ${trade.transactionHash.slice(0, 10)}...`
    );
};

// Fetch condition IDs for slug prefix
const fetchConditionIdsForSlugPrefix = async (slugPrefix: string): Promise<string[]> => {
    const conditionIds = new Set<string>();
    
    try {
        // Compute candidate slugs for 15m series
        const is15mSeries = /-15m$/.test(slugPrefix);
        if (is15mSeries) {
            const nowSec = Math.floor(Date.now() / 1000);
            const bucket = Math.floor(nowSec / 900) * 900;
            const candidateSlugs: string[] = [];
            
            // Check current and next few buckets
            for (let offset = -2; offset <= 2; offset++) {
                candidateSlugs.push(`${slugPrefix}-${bucket + offset * 900}`);
            }
            
            // Fetch condition IDs for each candidate
            for (const slug of candidateSlugs) {
                try {
                    const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(slug)}`;
                    const response = await axios.get(url, { timeout: 5000 });
                    if (Array.isArray(response.data) && response.data[0]?.conditionId) {
                        conditionIds.add(response.data[0].conditionId);
                        console.log(`  ✓ Found market: ${slug} -> ${response.data[0].conditionId}`);
                    }
                } catch (err) {
                    // Skip if market doesn't exist
                }
            }
        } else {
            // For non-15m markets, do a direct search
            const url = `https://gamma-api.polymarket.com/markets?limit=50&slug=${encodeURIComponent(slugPrefix)}`;
            const response = await axios.get(url, { timeout: 5000 });
            if (Array.isArray(response.data)) {
                for (const market of response.data) {
                    if (market.conditionId) {
                        conditionIds.add(market.conditionId);
                    }
                }
            }
        }
    } catch (err: any) {
        console.warn(`⚠️  Error fetching markets: ${err.message}`);
    }
    
    return Array.from(conditionIds);
};

// Parse WebSocket message and extract user trades
const parseTradeFromMessage = (msg: any, userLower: string): TradeEvent | null => {
    try {
        // Check various message types that might contain user activity
        const userAddr = (
            msg.user ||
            msg.maker ||
            msg.taker ||
            msg.account ||
            msg.trader ||
            msg.wallet
        )?.toLowerCase();

        // Must match our target user
        if (!userAddr || userAddr !== userLower) {
            return null;
        }

        // Extract trade information from different message formats
        const timestamp = msg.timestamp || msg.time || msg.created_at || Math.floor(Date.now() / 1000);
        const transactionHash = msg.transaction_hash || msg.tx_hash || msg.tx || msg.transactionHash || '';
        const slug = msg.slug || msg.market_slug || msg.event_slug;
        const conditionId = msg.market || msg.condition_id || msg.conditionId;
        const side = (msg.side || 'BUY').toUpperCase() as 'BUY' | 'SELL';
        const price = parseFloat(msg.price || msg.last_price || 0);
        const size = parseFloat(msg.size || msg.amount || msg.quantity || 0);
        const usdcSize = parseFloat(msg.usdc_size || msg.usd_value || msg.value || 0);
        const asset = msg.asset_id || msg.asset || '';
        const outcome = msg.outcome || msg.outcome_index;

        // Only process if we have essential fields
        if (!transactionHash && !slug) {
            return null;
        }

        // Deduplicate by transaction hash + timestamp
        const dedupKey = `${transactionHash}:${timestamp}`;
        if (seenTrades.has(dedupKey)) {
            return null;
        }
        seenTrades.add(dedupKey);

        // Cleanup old dedup keys (keep last 10000)
        if (seenTrades.size > 10000) {
            const keys = Array.from(seenTrades);
            seenTrades.clear();
            keys.slice(-5000).forEach(k => seenTrades.add(k));
        }

        return {
            timestamp,
            transactionHash,
            slug,
            conditionId,
            side,
            price,
            size,
            usdcSize,
            asset,
            outcome,
            user: TARGET_USER,
            block: msg.block_number || msg.block,
            orderHash: msg.order_hash || msg.orderHash,
            maker: msg.maker,
            taker: msg.taker,
        };
    } catch (err) {
        return null;
    }
};

const main = async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Market WebSocket User Activity Monitor (Strategy 2)     ║
╚═══════════════════════════════════════════════════════════╝

Target User: ${TARGET_USER}
Slug Prefix: ${SLUG_PREFIX}
Output Dir:  ${OUTPUT_DIR}
WebSocket:   ${WS_URL}

`);

    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Fetch condition IDs for markets we want to monitor
    console.log('🔍 Fetching markets for slug prefix...');
    const conditionIds = await fetchConditionIdsForSlugPrefix(SLUG_PREFIX);
    
    if (conditionIds.length === 0) {
        console.warn('⚠️  No markets found for slug prefix. Will subscribe to all markets and filter client-side.');
    } else {
        console.log(`✅ Found ${conditionIds.length} market(s) to monitor`);
    }

    const userLower = TARGET_USER.toLowerCase();
    let ws: WebSocket | null = null;
    let reconnectDelay = 1000;
    const maxReconnectDelay = 30000;
    let isConnected = false;

    const connect = () => {
        try {
            console.log(`\n🔌 Connecting to WebSocket...`);
            ws = new WebSocket(WS_URL, {
                headers: {
                    Origin: 'https://polymarket.com',
                    'User-Agent': 'Mozilla/5.0',
                },
            });

            ws.on('open', () => {
                console.log('✅ WebSocket connected');
                isConnected = true;
                reconnectDelay = 1000;

                // Subscribe to markets
                if (conditionIds.length > 0) {
                    // Subscribe to specific markets in batches (limit 50 per subscription)
                    const batches: string[][] = [];
                    for (let i = 0; i < conditionIds.length; i += 50) {
                        batches.push(conditionIds.slice(i, i + 50));
                    }

                    for (const batch of batches) {
                        const subscribeMsg = {
                            type: 'subscribe',
                            channel: 'l2',
                            markets: batch,
                        };
                        ws?.send(JSON.stringify(subscribeMsg));
                        console.log(`  📡 Subscribed to ${batch.length} market(s)`);
                    }
                } else {
                    // Subscribe to all markets (we'll filter client-side)
                    const subscribeMsg = {
                        type: 'subscribe',
                        channel: 'l2',
                        markets: [], // Empty = all markets
                    };
                    ws?.send(JSON.stringify(subscribeMsg));
                    console.log('  📡 Subscribed to all markets (client-side filtering)');
                }

                // Also subscribe to trade/fill channels
                const tradeSubscribeMsg = {
                    type: 'subscribe',
                    channel: 'trades',
                    markets: conditionIds.length > 0 ? conditionIds.slice(0, 50) : [],
                };
                ws?.send(JSON.stringify(tradeSubscribeMsg));
                console.log('  📡 Subscribed to trades channel');
            });

            ws.on('message', (data: Buffer) => {
                try {
                    const msgStr = data.toString();
                    if (msgStr === 'PING' || msgStr === 'ping') {
                        ws?.send('PONG');
                        return;
                    }

                    const msg = JSON.parse(msgStr);
                    
                    // Handle ping/pong
                    if (msg.type === 'ping' || msg.type === 'PING') {
                        ws?.send(JSON.stringify({ type: 'pong' }));
                        return;
                    }

                    // Log all messages for debugging (first few only)
                    if (Math.random() < 0.01) { // Log 1% of messages for debugging
                        console.log('📨 Sample WS message:', JSON.stringify(msg).slice(0, 200));
                    }

                    // Check for user activity in various message formats
                    const trade = parseTradeFromMessage(msg, userLower);
                    if (trade) {
                        writeTrade(trade);
                    }

                    // Also check nested data structures
                    if (msg.data && Array.isArray(msg.data)) {
                        for (const item of msg.data) {
                            const nestedTrade = parseTradeFromMessage(item, userLower);
                            if (nestedTrade) {
                                writeTrade(nestedTrade);
                            }
                        }
                    }

                    // Check price_changes array
                    if (msg.price_changes && Array.isArray(msg.price_changes)) {
                        for (const pc of msg.price_changes) {
                            const pcTrade = parseTradeFromMessage({ ...msg, ...pc }, userLower);
                            if (pcTrade) {
                                writeTrade(pcTrade);
                            }
                        }
                    }
                } catch (err: any) {
                    // Ignore parse errors for non-JSON messages
                }
            });

            ws.on('error', (err: Error) => {
                console.error(`❌ WebSocket error: ${err.message}`);
                isConnected = false;
            });

            ws.on('close', (code: number, reason: Buffer) => {
                console.log(`🔌 WebSocket closed (code: ${code}, reason: ${reason.toString()})`);
                isConnected = false;
                ws = null;

                // Reconnect with exponential backoff
                console.log(`⏳ Reconnecting in ${reconnectDelay / 1000}s...`);
                setTimeout(() => {
                    connect();
                }, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
            });

            // Keepalive ping every 30 seconds
            const pingInterval = setInterval(() => {
                if (isConnected && ws?.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({ type: 'ping' }));
                    } catch (err) {
                        // Ignore errors
                    }
                } else {
                    clearInterval(pingInterval);
                }
            }, 30000);
        } catch (err: any) {
            console.error(`❌ Connection error: ${err.message}`);
            setTimeout(() => {
                connect();
            }, reconnectDelay);
        }
    };

    // Start REST polling fallback (since market WS may not include user addresses)
    console.log(`\n🔄 Starting REST polling fallback (${REST_POLL_INTERVAL_MS}ms interval)...`);
    let lastRestTimestamp = 0;
    const restPollInterval = setInterval(async () => {
        try {
            // Try /trades endpoint first (may be faster)
            const endpoints = [
                `https://data-api.polymarket.com/trades?user=${TARGET_USER}&limit=100`,
                `https://data-api.polymarket.com/activity?user=${TARGET_USER}&type=TRADE&limit=100`,
            ];

            for (const url of endpoints) {
                try {
                    const response = await axios.get(url, { timeout: 3000 });
                    if (Array.isArray(response.data)) {
                        for (const t of response.data) {
                            const tradeTimestamp = t.timestamp || t.created_at || 0;
                            if (tradeTimestamp > lastRestTimestamp) {
                                const trade: TradeEvent = {
                                    timestamp: tradeTimestamp,
                                    transactionHash: t.transactionHash || t.tx_hash || t.tx || '',
                                    slug: t.slug || t.market_slug,
                                    conditionId: t.conditionId || t.condition_id || t.market,
                                    side: (t.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
                                    price: parseFloat(t.price || 0),
                                    size: parseFloat(t.size || t.amount || 0),
                                    usdcSize: parseFloat(t.usdcSize || t.usdc_size || t.usd_value || 0),
                                    asset: t.asset || t.asset_id || '',
                                    outcome: t.outcome,
                                    user: TARGET_USER,
                                };

                                const dedupKey = `${trade.transactionHash}:${trade.timestamp}`;
                                if (!seenTrades.has(dedupKey)) {
                                    seenTrades.add(dedupKey);
                                    writeTrade(trade);
                                    lastRestTimestamp = Math.max(lastRestTimestamp, tradeTimestamp);
                                }
                            }
                        }
                        break; // Success, don't try other endpoints
                    }
                } catch (err) {
                    // Try next endpoint
                    continue;
                }
            }
        } catch (err: any) {
            // Ignore polling errors
        }
    }, REST_POLL_INTERVAL_MS);

    // Start WebSocket connection
    connect();

    // Graceful shutdown
    const shutdown = () => {
        console.log('\n🛑 Stopping monitor...');
        clearInterval(restPollInterval);
        if (currentFileHandle) {
            currentFileHandle.end();
        }
        if (ws) {
            ws.close();
        }
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
};

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
