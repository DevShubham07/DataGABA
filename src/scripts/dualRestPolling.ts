#!/usr/bin/env ts-node
/**
 * Dual REST Polling - Fetches from both /activity and /trades endpoints
 * Tags events with endpoint source for matching script
 */

import axios from 'axios';
import * as dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
// Copy JsonlWriter class inline since it's not exported
class JsonlWriter {
    write(filePath: string, obj: any) {
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const line = JSON.stringify(obj) + '\n';
        fs.appendFileSync(filePath, line, 'utf8');
    }
}

dotenv.config();

const TARGET_USER = process.env.TARGET_USER || '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './dataset';
const SLUG_PREFIX = process.env.SLUG_PREFIX || 'btc-updown-15m';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '200', 10);
const LIMIT = parseInt(process.env.LIMIT || '100', 10);

interface ActivityTrade {
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
}

const fetchTradesFromActivity = async (user: string, limit: number): Promise<ActivityTrade[]> => {
    const url = `https://data-api.polymarket.com/activity?user=${user}&type=TRADE&limit=${limit}`;
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        return Array.isArray(response.data) ? (response.data as ActivityTrade[]) : [];
    } catch (err) {
        console.warn(`⚠️  /activity endpoint error:`, (err as any).message);
        return [];
    }
};

const fetchTradesFromTrades = async (user: string, limit: number): Promise<ActivityTrade[]> => {
    const url = `https://data-api.polymarket.com/trades?user=${user}&limit=${limit}`;
    try {
        const response = await axios.get(url, {
            timeout: 5000,
            headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        // Map /trades response to ActivityTrade format
        if (Array.isArray(response.data)) {
            return response.data.map((t: any) => ({
                id: t.id || t.trade_id,
                timestamp: t.timestamp || t.created_at || Math.floor(Date.now() / 1000),
                transactionHash: t.transactionHash || t.tx_hash || t.tx || '',
                slug: t.slug || t.market_slug,
                conditionId: t.conditionId || t.condition_id || t.market,
                side: (t.side || 'BUY').toUpperCase() as 'BUY' | 'SELL',
                price: parseFloat(t.price || 0),
                size: parseFloat(t.size || t.amount || 0),
                usdcSize: parseFloat(t.usdcSize || t.usdc_size || t.usd_value || 0),
                asset: t.asset || t.asset_id || '',
                outcome: t.outcome,
            }));
        }
        return [];
    } catch (err) {
        console.warn(`⚠️  /trades endpoint error:`, (err as any).message);
        return [];
    }
};

const main = async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║  Dual REST Polling - /activity + /trades endpoints      ║
╚═══════════════════════════════════════════════════════════╝

User:        ${TARGET_USER}
Slug Prefix: ${SLUG_PREFIX}
Interval:    ${POLL_INTERVAL_MS}ms
Output:      ${OUTPUT_DIR}

`);

    const writer = new JsonlWriter();
    const userDir = path.join(OUTPUT_DIR, TARGET_USER.toLowerCase());
    if (!fs.existsSync(userDir)) {
        fs.mkdirSync(userDir, { recursive: true });
    }

    const seenTrades = new Set<string>();
    let lastActivityTimestamp = 0;
    let lastTradesTimestamp = 0;

    const poll = async () => {
        try {
            // Fetch from both endpoints in parallel
            const [activityTrades, tradesTrades] = await Promise.all([
                fetchTradesFromActivity(TARGET_USER, LIMIT),
                fetchTradesFromTrades(TARGET_USER, LIMIT),
            ]);

            // Process /activity endpoint trades
            for (const trade of activityTrades) {
                if (trade.timestamp <= lastActivityTimestamp) continue;
                const key = `${trade.transactionHash}:${trade.timestamp}`;
                if (seenTrades.has(key)) continue;
                seenTrades.add(key);

                const slugId = trade.slug || trade.conditionId || 'unknown';
                const slugDir = path.join(userDir, 'by_slug', slugId);
                if (!fs.existsSync(slugDir)) {
                    fs.mkdirSync(slugDir, { recursive: true });
                }

                const eventPath = path.join(slugDir, 'events.jsonl');
                const event = {
                    v: 1,
                    t: trade.timestamp * 1000,
                    recv: Date.now(),
                    src: 'rest_poll',
                    slug: trade.slug,
                    cid: trade.conditionId,
                    aid: trade.asset,
                    type: 'trade',
                    price: trade.price,
                    size: trade.size,
                    usdc: trade.usdcSize,
                    side: trade.side,
                    outcome: trade.outcome,
                    tx: trade.transactionHash,
                    endpoint: '/activity',
                    id: trade.id,
                };

                writer.write(eventPath, event);
                lastActivityTimestamp = Math.max(lastActivityTimestamp, trade.timestamp);
                console.log(`[${new Date().toISOString()}] 📊 /activity: ${trade.side} ${trade.size} @ ${trade.price} | ${trade.slug}`);
            }

            // Process /trades endpoint trades
            for (const trade of tradesTrades) {
                if (trade.timestamp <= lastTradesTimestamp) continue;
                const key = `${trade.transactionHash}:${trade.timestamp}`;
                if (seenTrades.has(key)) continue;
                seenTrades.add(key);

                const slugId = trade.slug || trade.conditionId || 'unknown';
                const slugDir = path.join(userDir, 'by_slug', slugId);
                if (!fs.existsSync(slugDir)) {
                    fs.mkdirSync(slugDir, { recursive: true });
                }

                const eventPath = path.join(slugDir, 'events.jsonl');
                const event = {
                    v: 1,
                    t: trade.timestamp * 1000,
                    recv: Date.now(),
                    src: 'rest_poll',
                    slug: trade.slug,
                    cid: trade.conditionId,
                    aid: trade.asset,
                    type: 'trade',
                    price: trade.price,
                    size: trade.size,
                    usdc: trade.usdcSize,
                    side: trade.side,
                    outcome: trade.outcome,
                    tx: trade.transactionHash,
                    endpoint: '/trades',
                    id: trade.id,
                };

                writer.write(eventPath, event);
                lastTradesTimestamp = Math.max(lastTradesTimestamp, trade.timestamp);
                console.log(`[${new Date().toISOString()}] 📊 /trades: ${trade.side} ${trade.size} @ ${trade.price} | ${trade.slug}`);
            }

            // Cleanup old seen trades
            if (seenTrades.size > 10000) {
                const keys = Array.from(seenTrades);
                seenTrades.clear();
                keys.slice(-5000).forEach(k => seenTrades.add(k));
            }
        } catch (err: any) {
            console.error('❌ Polling error:', err.message);
        }
    };

    // Initial poll
    await poll();

    // Then poll at interval
    const intervalId = setInterval(poll, POLL_INTERVAL_MS);

    // Graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n🛑 Stopping dual REST polling...');
        clearInterval(intervalId);
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log('\n🛑 Stopping dual REST polling...');
        clearInterval(intervalId);
        process.exit(0);
    });
};

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
