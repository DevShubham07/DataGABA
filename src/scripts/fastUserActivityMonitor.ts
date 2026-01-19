#!/usr/bin/env ts-node
/**
 * Fast User Activity Monitor
 * 
 * Multiple strategies for low-latency user activity monitoring:
 * 1. Optimized REST polling with /trades endpoint
 * 2. Market WebSocket + client-side filtering
 * 3. Parallel polling with connection pooling
 */

import axios, { AxiosInstance } from 'axios';
import WebSocket from 'ws';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

interface Trade {
    id?: string;
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
    user?: string;
}

interface MonitorOptions {
    user: string;
    strategy: 'rest' | 'ws-market' | 'hybrid';
    pollingIntervalMs?: number;
    outputDir?: string;
    slugPrefix?: string;
}

// Strategy 1: Optimized REST Polling with /trades endpoint
class OptimizedRestPolling {
    private httpClient: AxiosInstance;
    private lastSeenIds = new Set<string>();
    private lastTimestamp = 0;
    private user: string;
    private intervalMs: number;
    private intervalId?: NodeJS.Timeout;

    constructor(user: string, intervalMs: number = 200) {
        this.user = user.toLowerCase();
        this.intervalMs = intervalMs;
        
        // Create HTTP/2-capable client with connection pooling
        this.httpClient = axios.create({
            timeout: 5000,
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Accept': 'application/json',
                'Connection': 'keep-alive',
            },
            // Enable HTTP/2 if available
            http2: true,
            // Connection pooling
            maxRedirects: 0,
        });
    }

    async fetchTrades(): Promise<Trade[]> {
        // Try /trades endpoint first (may be faster than /activity)
        const endpoints = [
            `https://data-api.polymarket.com/trades?user=${this.user}&limit=100`,
            `https://data-api.polymarket.com/activity?user=${this.user}&type=TRADE&limit=100`,
        ];

        for (const url of endpoints) {
            try {
                const response = await this.httpClient.get(url, {
                    timeout: 3000,
                });
                
                if (Array.isArray(response.data)) {
                    return response.data.map((t: any) => ({
                        id: t.id || t.trade_id,
                        timestamp: t.timestamp || t.created_at || Date.now() / 1000,
                        transactionHash: t.transactionHash || t.tx_hash || t.tx,
                        slug: t.slug || t.market_slug,
                        conditionId: t.conditionId || t.condition_id || t.market,
                        side: t.side?.toUpperCase() || 'BUY',
                        price: parseFloat(t.price || 0),
                        size: parseFloat(t.size || t.amount || 0),
                        usdcSize: parseFloat(t.usdcSize || t.usdc_size || t.usd_value || 0),
                        asset: t.asset || t.asset_id,
                        outcome: t.outcome,
                        user: this.user,
                    }));
                }
            } catch (err: any) {
                if (err.code !== 'ECONNREFUSED' && err.code !== 'ETIMEDOUT') {
                    console.warn(`⚠️  Endpoint ${url} failed:`, err.message);
                }
                continue;
            }
        }
        return [];
    }

    start(onNewTrades: (trades: Trade[]) => void) {
        console.log(`🚀 Starting optimized REST polling (${this.intervalMs}ms interval)`);
        
        const poll = async () => {
            try {
                const trades = await this.fetchTrades();
                const newTrades = trades.filter((t) => {
                    const key = t.id || `${t.transactionHash}:${t.timestamp}`;
                    if (this.lastSeenIds.has(key)) return false;
                    if (t.timestamp <= this.lastTimestamp) return false;
                    this.lastSeenIds.add(key);
                    this.lastTimestamp = Math.max(this.lastTimestamp, t.timestamp);
                    return true;
                });

                if (newTrades.length > 0) {
                    onNewTrades(newTrades);
                }

                // Cleanup old IDs (keep last 1000)
                if (this.lastSeenIds.size > 1000) {
                    const ids = Array.from(this.lastSeenIds);
                    this.lastSeenIds = new Set(ids.slice(-500));
                }
            } catch (err: any) {
                console.error('❌ Polling error:', err.message);
            }
        };

        // Initial poll
        poll();
        
        // Then poll at interval
        this.intervalId = setInterval(poll, this.intervalMs);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = undefined;
        }
    }
}

// Strategy 2: Market WebSocket + Client-side Filtering
class MarketWebSocketFilter {
    private ws?: WebSocket;
    private user: string;
    private targetMarkets: Set<string> = new Set();
    private reconnectDelay = 1000;
    private maxReconnectDelay = 30000;

    constructor(user: string, slugPrefix?: string) {
        this.user = user.toLowerCase();
        if (slugPrefix) {
            // Pre-fetch condition IDs for slug prefix
            this.loadMarketsForSlug(slugPrefix).catch(console.error);
        }
    }

    private async loadMarketsForSlug(slugPrefix: string) {
        try {
            const url = `https://gamma-api.polymarket.com/markets?limit=50&slug=${encodeURIComponent(slugPrefix)}`;
            const response = await axios.get(url, { timeout: 5000 });
            if (Array.isArray(response.data)) {
                for (const market of response.data) {
                    if (market.conditionId) {
                        this.targetMarkets.add(market.conditionId);
                    }
                }
            }
        } catch (err) {
            console.warn('⚠️  Could not pre-load markets:', err);
        }
    }

    connect(onTrade: (trade: Trade) => void) {
        const wsUrl = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
        
        const connect = () => {
            try {
                this.ws = new WebSocket(wsUrl, {
                    headers: {
                        Origin: 'https://polymarket.com',
                    },
                });

                this.ws.on('open', () => {
                    console.log('🔌 Market WebSocket connected');
                    this.reconnectDelay = 1000;

                    // Subscribe to all markets (we'll filter client-side)
                    const subscribeMsg = {
                        type: 'subscribe',
                        channel: 'l2',
                        markets: Array.from(this.targetMarkets).slice(0, 50), // Limit to 50 markets
                    };
                    this.ws?.send(JSON.stringify(subscribeMsg));
                });

                this.ws.on('message', (data: Buffer) => {
                    try {
                        const msg = JSON.parse(data.toString());
                        
                        // Look for trade/fill messages that might contain user info
                        if (msg.type === 'last_trade_price' || msg.type === 'fill' || msg.type === 'trade') {
                            // Check if message contains user address or we can infer from context
                            const userAddr = msg.user || msg.maker || msg.taker || msg.account;
                            
                            if (userAddr && userAddr.toLowerCase() === this.user) {
                                const trade: Trade = {
                                    timestamp: msg.timestamp || Date.now() / 1000,
                                    transactionHash: msg.transaction_hash || msg.tx || '',
                                    slug: msg.slug || msg.market_slug,
                                    conditionId: msg.market || msg.condition_id,
                                    side: (msg.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
                                    price: parseFloat(msg.price || 0),
                                    size: parseFloat(msg.size || 0),
                                    usdcSize: parseFloat(msg.usdc_size || msg.usd_value || 0),
                                    asset: msg.asset_id,
                                    outcome: msg.outcome,
                                    user: this.user,
                                };
                                onTrade(trade);
                            }
                        }
                    } catch (err) {
                        // Ignore parse errors
                    }
                });

                this.ws.on('error', (err) => {
                    console.error('❌ WebSocket error:', err.message);
                });

                this.ws.on('close', () => {
                    console.log('🔌 WebSocket closed, reconnecting...');
                    this.ws = undefined;
                    setTimeout(connect, this.reconnectDelay);
                    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
                });
            } catch (err: any) {
                console.error('❌ Connection error:', err.message);
                setTimeout(connect, this.reconnectDelay);
            }
        };

        connect();
    }

    disconnect() {
        if (this.ws) {
            this.ws.close();
            this.ws = undefined;
        }
    }
}

// Strategy 3: Hybrid Approach
class HybridMonitor {
    private restPolling: OptimizedRestPolling;
    private wsFilter: MarketWebSocketFilter;
    private seenTrades = new Set<string>();

    constructor(user: string, slugPrefix?: string, pollingIntervalMs: number = 500) {
        this.restPolling = new OptimizedRestPolling(user, pollingIntervalMs);
        this.wsFilter = new MarketWebSocketFilter(user, slugPrefix);
    }

    start(onTrade: (trade: Trade) => void) {
        // REST polling as primary
        this.restPolling.start((trades) => {
            for (const trade of trades) {
                const key = trade.id || `${trade.transactionHash}:${trade.timestamp}`;
                if (!this.seenTrades.has(key)) {
                    this.seenTrades.add(key);
                    onTrade(trade);
                }
            }
        });

        // WebSocket as backup/faster path
        this.wsFilter.connect((trade) => {
            const key = trade.id || `${trade.transactionHash}:${trade.timestamp}`;
            if (!this.seenTrades.has(key)) {
                this.seenTrades.add(key);
                onTrade(trade);
            }
        });
    }

    stop() {
        this.restPolling.stop();
        this.wsFilter.disconnect();
    }
}

// Main execution
const main = async () => {
    const args = process.argv.slice(2);
    const userArg = args.find((a) => a.startsWith('--user='))?.split('=')[1] ||
                   args[args.indexOf('--user') + 1];
    const strategyArg = args.find((a) => a.startsWith('--strategy='))?.split('=')[1] ||
                       args[args.indexOf('--strategy') + 1] || 'hybrid';
    const intervalArg = args.find((a) => a.startsWith('--interval='))?.split('=')[1] ||
                       args[args.indexOf('--interval') + 1] || '200';
    const slugPrefixArg = args.find((a) => a.startsWith('--slug-prefix='))?.split('=')[1] ||
                         args[args.indexOf('--slug-prefix') + 1];

    if (!userArg || !/^0x[a-fA-F0-9]{40}$/i.test(userArg)) {
        console.error(`
Usage: npm run fast-monitor -- --user 0xAddress [options]

Options:
  --strategy <rest|ws-market|hybrid>  Monitoring strategy (default: hybrid)
  --interval <ms>                     Polling interval in ms (default: 200)
  --slug-prefix <prefix>              Filter by slug prefix (e.g., btc-updown-15m)

Examples:
  npm run fast-monitor -- --user 0x1234... --strategy rest --interval 100
  npm run fast-monitor -- --user 0x1234... --strategy hybrid --slug-prefix btc-updown-15m
        `);
        process.exit(1);
    }

    const user = userArg.toLowerCase();
    const strategy = strategyArg as 'rest' | 'ws-market' | 'hybrid';
    const intervalMs = Math.max(50, parseInt(intervalArg, 10));
    const outputDir = path.join(process.cwd(), 'fast_monitor_logs', user);

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    console.log(`
╔═══════════════════════════════════════════════════════════╗
║     Fast User Activity Monitor                           ║
╚═══════════════════════════════════════════════════════════╝

User:        ${user}
Strategy:    ${strategy}
Interval:    ${intervalMs}ms
Slug Prefix: ${slugPrefixArg || 'all'}
Output:      ${outputDir}

`);

    let monitor: OptimizedRestPolling | MarketWebSocketFilter | HybridMonitor;

    switch (strategy) {
        case 'rest':
            monitor = new OptimizedRestPolling(user, intervalMs);
            (monitor as OptimizedRestPolling).start((trades) => {
                console.log(`[${new Date().toISOString()}] 📊 ${trades.length} new trade(s)`);
                for (const trade of trades) {
                    const logFile = path.join(outputDir, `${trade.slug || 'unknown'}.jsonl`);
                    fs.appendFileSync(logFile, JSON.stringify(trade) + '\n');
                    console.log(`  ✓ ${trade.side} ${trade.size} @ ${trade.price} (${trade.slug})`);
                }
            });
            break;

        case 'ws-market':
            monitor = new MarketWebSocketFilter(user, slugPrefixArg);
            (monitor as MarketWebSocketFilter).connect((trade) => {
                console.log(`[${new Date().toISOString()}] ⚡ Trade via WS: ${trade.side} ${trade.size} @ ${trade.price}`);
                const logFile = path.join(outputDir, `${trade.slug || 'unknown'}.jsonl`);
                fs.appendFileSync(logFile, JSON.stringify(trade) + '\n');
            });
            break;

        case 'hybrid':
        default:
            monitor = new HybridMonitor(user, slugPrefixArg, intervalMs);
            (monitor as HybridMonitor).start((trade) => {
                const source = trade.user ? 'REST' : 'WS';
                console.log(`[${new Date().toISOString()}] ${source === 'WS' ? '⚡' : '📊'} ${trade.side} ${trade.size} @ ${trade.price} (${trade.slug})`);
                const logFile = path.join(outputDir, `${trade.slug || 'unknown'}.jsonl`);
                fs.appendFileSync(logFile, JSON.stringify(trade) + '\n');
            });
            break;
    }

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Stopping monitor...');
        if ('stop' in monitor) monitor.stop();
        if ('disconnect' in monitor) monitor.disconnect();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 Stopping monitor...');
        if ('stop' in monitor) monitor.stop();
        if ('disconnect' in monitor) monitor.disconnect();
        process.exit(0);
    });
};

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
