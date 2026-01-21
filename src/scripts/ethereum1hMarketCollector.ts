#!/usr/bin/env ts-node
/**
 * Ethereum 1-Hour Market Data Collector
 * 
 * Collects:
 * 1. Market WebSocket data for Ethereum 1-hour markets (ethereum-up-or-down-january-20-10pm-et)
 * 2. User activity API data every 50ms for specified user
 * 
 * Output:
 * - Merges both streams sorted by receiving time
 * - Splits into 5 files per slug based on time
 * - Uploads all 5 files to R2 when complete
 */

import axios, { AxiosError } from 'axios';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { uploadToR2, isR2Configured } from '../utils/r2Client';

dotenv.config();

interface EventRecord {
    receivedAtMs: number;  // When we received this event (ms)
    receivedAt: string;    // ISO string of receiving time
    source: 'market_ws' | 'user_activity';
    slug?: string;
    data: any;             // Raw event data
}

interface ActivityTrade {
    id?: string;
    timestamp: number;
    transactionHash: string;
    slug?: string;
    market?: string;
    conditionId?: string;
    title?: string;
    outcome?: string;
    side: 'BUY' | 'SELL';
    usdcSize: number;
    size: number;
    price: number;
    asset: string;
}

// Ethereum 1-hour slug pattern: ethereum-up-or-down-january-20-10pm-et
const ETHEREUM_1H_SLUG_PATTERN = /^ethereum-up-or-down-[a-z]+-\d{1,2}-[0-9]+(am|pm)-et$/i;
const USER_ACTIVITY_INTERVAL_MS = 50;
const MAX_RETRIES = 5;
const BATCH_WRITE_INTERVAL_MS = 1000; // Write to files every 1 second

// Track active slugs and their file streams
const slugFileStreams = new Map<string, fs.WriteStream>(); // File stream per slug
const slugLastActivity = new Map<string, number>(); // Last activity time per slug
const slugEventCounts = new Map<string, number>(); // Event count per slug
const slugEventBuffers = new Map<string, EventRecord[]>(); // Buffer events before writing (for sorting)
const subscribedMarkets = new Set<string>(); // Track which markets we've subscribed to
const conditionIdToSlug = new Map<string, string>(); // Cache conditionId -> slug mapping
const assetIdToSlug = new Map<string, string>(); // Cache assetId -> slug mapping
let currentWs: any = null; // Current WebSocket connection
const SLUG_INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes of inactivity before considering slug complete
const UPLOAD_CHECK_INTERVAL_MS = 60 * 1000; // Check for uploads every minute
const BUFFER_FLUSH_INTERVAL_MS = 5 * 1000; // Flush buffer every 5 seconds
const BUFFER_MAX_SIZE = 100; // Max events in buffer before flushing

// Market log file for Ethereum WebSocket events
// Use /data directory if available (for Fly.io), otherwise use local directory
const DATA_BASE_DIR = process.env.DATA_DIR || process.cwd();
const MARKET_LOG_FILE = path.join(DATA_BASE_DIR, 'ethereum_market_ws_logs.jsonl');
let marketLogStream: fs.WriteStream | null = null;

// Initialize market log file
const initMarketLog = () => {
    try {
        ensureDirForFile(MARKET_LOG_FILE);
        marketLogStream = fs.createWriteStream(MARKET_LOG_FILE, { flags: 'a' });
        console.log(`📝 Market WebSocket logs will be written to: ${MARKET_LOG_FILE}`);
    } catch (err: any) {
        console.error(`❌ Failed to create market log file: ${err.message}`);
    }
};

// Write market event to log file
const logMarketEvent = (slug: string, event: any, receivedAtMs: number) => {
    if (!marketLogStream) return;
    
    try {
        const logEntry = {
            timestamp: new Date(receivedAtMs).toISOString(),
            receivedAtMs,
            slug,
            eventType: event?.event_type || event?.type || 'unknown',
            assetId: event?.asset_id || event?.assetId,
            conditionId: event?.condition_id || event?.conditionId || event?.market,
            data: event,
        };
        marketLogStream.write(JSON.stringify(logEntry) + '\n');
    } catch (err: any) {
        // Ignore write errors to avoid crashing
    }
};

// Fetch slug from conditionId
const fetchSlugForConditionId = async (conditionId: string): Promise<string | undefined> => {
    const cached = conditionIdToSlug.get(conditionId);
    if (cached) return cached;
    
    try {
        const url = `https://gamma-api.polymarket.com/markets?limit=1&condition_ids=${encodeURIComponent(conditionId)}`;
        const response = await axios.get(url, { timeout: 5000 });
        const markets = Array.isArray(response.data) ? response.data : [];
        
        if (markets.length > 0 && markets[0].slug) {
            const slug = markets[0].slug;
            conditionIdToSlug.set(conditionId, slug);
            return slug;
        }
    } catch (err: any) {
        // Ignore errors, will retry later
    }
    
    return undefined;
};

// Extract conditionId from message
const extractConditionId = (msg: any): string | undefined => {
    return msg?.conditionId || 
           msg?.condition_id || 
           msg?.market || 
           msg?.marketId || 
           msg?.market_id ||
           msg?.data?.conditionId ||
           msg?.data?.condition_id ||
           msg?.data?.market;
};

// Get user address from env (works with .env file or Fly.io secrets)
const getUserAddress = (): string => {
    const userAddresses = process.env.USER_ADDRESSES;
    if (!userAddresses) {
        throw new Error('USER_ADDRESSES environment variable not set. Set it in .env file or as Fly.io secret: fly secrets set USER_ADDRESSES=0x...');
    }
    
    // Parse comma-separated or JSON array
    let addresses: string[] = [];
    try {
        if (userAddresses.startsWith('[')) {
            addresses = JSON.parse(userAddresses);
        } else {
            addresses = userAddresses.split(',').map(a => a.trim()).filter(Boolean);
        }
    } catch {
        addresses = userAddresses.split(',').map(a => a.trim()).filter(Boolean);
    }
    
    if (addresses.length === 0) {
        throw new Error('No user addresses found in USER_ADDRESSES');
    }
    
    // Use first address (assuming gabagool22 is first)
    return addresses[0].toLowerCase();
};

const sanitizeFileComponent = (input: string): string => {
    return input
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');
};

const ensureDirForFile = (filePath: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
};

const isEthereum1hSlug = (slug: string | undefined): boolean => {
    if (!slug) return false;
    return ETHEREUM_1H_SLUG_PATTERN.test(slug);
};

const fetchUserActivity = async (user: string, limit: number = 100): Promise<ActivityTrade[]> => {
    const url = `https://data-api.polymarket.com/activity?user=${user}&type=TRADE&limit=${limit}`;
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                family: 4,
            });
            
            return Array.isArray(response.data) ? (response.data as ActivityTrade[]) : [];
        } catch (err: any) {
            const isRateLimit = axios.isAxiosError(err) && err.response?.status === 429;
            const isNetworkError = axios.isAxiosError(err) && !err.response;
            
            if (isRateLimit && attempt < MAX_RETRIES) {
                const delay = Math.min(5000, 1000 * Math.pow(2, attempt - 1));
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            if (isNetworkError && attempt < MAX_RETRIES) {
                await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
                continue;
            }
            
            if (attempt === MAX_RETRIES) {
                console.error(`❌ Failed to fetch user activity after ${MAX_RETRIES} attempts:`, err.message);
            }
            return [];
        }
    }
    
    return [];
};

// Get or create file stream for a slug
const getSlugFileStream = (slug: string): fs.WriteStream => {
    if (!slugFileStreams.has(slug)) {
        const baseDir = path.join(DATA_BASE_DIR, 'ethereum_1h_data');
        ensureDirForFile(path.join(baseDir, 'temp.jsonl'));
        
        const fileName = `${sanitizeFileComponent(slug)}.jsonl`;
        const filePath = path.join(baseDir, fileName);
        
        const stream = fs.createWriteStream(filePath, { flags: 'a' });
        slugFileStreams.set(slug, stream);
        slugEventCounts.set(slug, 0);
        slugLastActivity.set(slug, Date.now());
        
        console.log(`📊 New slug detected: ${slug} → ${fileName}`);
        
        // Immediately subscribe to WebSocket for this market when discovered
        if (!subscribedMarkets.has(slug)) {
            subscribeToMarket(slug).catch(() => {
                // Will retry later
            });
        }
    }
    
    return slugFileStreams.get(slug)!;
};

// Add event to buffer (will be flushed periodically)
const addEventToBuffer = (slug: string, event: EventRecord) => {
    if (!slugEventBuffers.has(slug)) {
        slugEventBuffers.set(slug, []);
    }
    
    slugEventBuffers.get(slug)!.push(event);
    slugLastActivity.set(slug, Date.now());
    
    // Flush if buffer is full
    const buffer = slugEventBuffers.get(slug)!;
    if (buffer.length >= BUFFER_MAX_SIZE) {
        flushSlugBuffer(slug);
    }
};

// Flush buffer to file (maintains sorted order)
const flushSlugBuffer = async (slug: string) => {
    const buffer = slugEventBuffers.get(slug);
    if (!buffer || buffer.length === 0) return;
    
    const baseDir = path.join(DATA_BASE_DIR, 'ethereum_1h_data');
    const fileName = `${sanitizeFileComponent(slug)}.jsonl`;
    const filePath = path.join(baseDir, fileName);
    
    // Read existing events
    let existingEvents: EventRecord[] = [];
    try {
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const lines = content.trim().split('\n').filter(Boolean);
            for (const line of lines) {
                try {
                    const existingEvent = JSON.parse(line) as EventRecord;
                    existingEvents.push(existingEvent);
                } catch {
                    // Skip invalid JSON lines
                }
            }
        }
    } catch (err: any) {
        // File might be locked, that's okay
    }
    
    // Add buffered events
    existingEvents.push(...buffer);
    
    // Sort by receivedAtMs
    existingEvents.sort((a, b) => a.receivedAtMs - b.receivedAtMs);
    
    // Write back to file (atomic write)
    const tempPath = `${filePath}.tmp`;
    const content = existingEvents.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
    
    // Update event count
    const count = (slugEventCounts.get(slug) || 0) + buffer.length;
    slugEventCounts.set(slug, count);
    
    // Clear buffer
    slugEventBuffers.set(slug, []);
    
    // Log progress every 100 events
    if (count % 100 === 0) {
        console.log(`   📈 ${slug}: ${count} events written`);
    }
};

// Flush all buffers periodically
const startBufferFlusher = () => {
    setInterval(() => {
        for (const slug of slugEventBuffers.keys()) {
            const buffer = slugEventBuffers.get(slug);
            if (buffer && buffer.length > 0) {
                flushSlugBuffer(slug).catch(err => {
                    console.error(`   ❌ Error flushing buffer for ${slug}:`, err.message);
                });
            }
        }
    }, BUFFER_FLUSH_INTERVAL_MS);
};

// Upload slug file to R2 and clean up
const uploadSlugFileToR2 = async (slug: string): Promise<boolean> => {
    // Flush buffer first to ensure all events are written
    await flushSlugBuffer(slug);
    
    const baseDir = path.join(DATA_BASE_DIR, 'ethereum_1h_data');
    const fileName = `${sanitizeFileComponent(slug)}.jsonl`;
    const filePath = path.join(baseDir, fileName);
    
    if (!fs.existsSync(filePath)) {
        console.log(`   ⚠️  File not found for ${slug}: ${filePath}`);
        return false;
    }
    
    try {
        // Read file content
        const content = fs.readFileSync(filePath, 'utf8');
        const eventCount = content.trim().split('\n').filter(Boolean).length;
        
        if (eventCount === 0) {
            console.log(`   ⚠️  Empty file for ${slug}, skipping upload`);
            return false;
        }
        
        // Upload to R2
        if (isR2Configured()) {
            const r2Key = `ethereum_1h/${sanitizeFileComponent(slug)}/${fileName}`;
            
                const success = await uploadToR2({
                    key: r2Key,
                content,
                    contentType: 'application/x-ndjson',
                });
                
                if (success) {
                console.log(`   ✅ Uploaded ${slug}: ${eventCount} events → ${r2Key}`);
                
                // Close file stream
                const stream = slugFileStreams.get(slug);
                if (stream) {
                    stream.end();
                    slugFileStreams.delete(slug);
                }
                
                // Delete local file after successful upload
                try {
                                fs.unlinkSync(filePath);
                    console.log(`   🗑️  Deleted local file: ${fileName}`);
                        } catch (err: any) {
                    console.error(`   ⚠️  Error deleting ${fileName}:`, err.message);
                }
                
                // Clean up tracking
                slugLastActivity.delete(slug);
                slugEventCounts.delete(slug);
                
                return true;
                } else {
                console.error(`   ❌ Failed to upload ${slug} to R2`);
                return false;
            }
        } else {
            console.warn(`   ⚠️  R2 not configured, file saved locally: ${filePath}`);
            return false;
        }
    } catch (err: any) {
        console.error(`   ❌ Error uploading ${slug}:`, err.message);
        return false;
    }
};

// Check for inactive slugs and upload them
const checkAndUploadInactiveSlugs = async () => {
    const now = Date.now();
    const activeSlugs = Array.from(slugLastActivity.keys());
    
    // Find slugs that are inactive (no activity for threshold time)
    const inactiveSlugs = activeSlugs.filter(slug => {
        const lastActivity = slugLastActivity.get(slug) || 0;
        return (now - lastActivity) >= SLUG_INACTIVITY_THRESHOLD_MS;
    });
    
    // Only upload if we have other active slugs (meaning we've moved on)
    if (inactiveSlugs.length > 0 && activeSlugs.length > inactiveSlugs.length) {
        for (const slug of inactiveSlugs) {
            console.log(`   📤 Uploading inactive slug: ${slug} (inactive for ${Math.round((now - (slugLastActivity.get(slug) || 0)) / 1000)}s)`);
            await uploadSlugFileToR2(slug);
        }
    }
};

const startUploadChecker = () => {
    setInterval(async () => {
        await checkAndUploadInactiveSlugs();
        
        // Log summary of active slugs
        if (slugFileStreams.size > 0) {
            const summaryCount = (global as any).summaryLogCount || 0;
            (global as any).summaryLogCount = summaryCount + 1;
            if (summaryCount % 10 === 0) { // Every 10 minutes
                const slugsInfo = Array.from(slugFileStreams.keys()).map(slug => {
                    const count = slugEventCounts.get(slug) || 0;
                    const lastActivity = slugLastActivity.get(slug) || 0;
                    const inactiveFor = Math.round((Date.now() - lastActivity) / 1000);
                    return `${slug}:${count}evts,${inactiveFor}s`;
                }).join(', ');
                console.log(`📊 Summary: ${slugFileStreams.size} active slug(s) [${slugsInfo}]`);
            }
        }
    }, UPLOAD_CHECK_INTERVAL_MS);
};

const subscribeToMarket = async (slug: string) => {
    if (subscribedMarkets.has(slug)) {
        return; // Already subscribed
    }
    
    if (!currentWs) {
        console.log(`   ⏳ Waiting for WebSocket connection to subscribe to ${slug}`);
        return;
    }
    
    try {
        const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(slug)}`;
        const response = await axios.get(url, { timeout: 5000 });
        const markets = Array.isArray(response.data) ? response.data : [];
        
        if (markets.length === 0) {
            console.log(`   ⚠️  Market not found in API: ${slug}`);
            return;
        }
        
        const market = markets[0];
        
        // Parse clobTokenIds - it can be a JSON string or an array
        let tokenIds: string[] = [];
        if (market.clobTokenIds) {
            if (typeof market.clobTokenIds === 'string') {
                try {
                    tokenIds = JSON.parse(market.clobTokenIds);
                } catch {
                    // If parsing fails, try splitting by comma
                    tokenIds = market.clobTokenIds.split(',').map((s: string) => s.trim().replace(/[\[\]"]/g, ''));
                }
            } else if (Array.isArray(market.clobTokenIds)) {
                tokenIds = market.clobTokenIds;
            }
        }
        
        // Also try alternative field names
        if (tokenIds.length === 0) {
            const altFields = [market.clob_token_ids, market.tokenIds, market.token_ids];
            for (const field of altFields) {
                if (field) {
                    if (typeof field === 'string') {
                        try {
                            tokenIds = JSON.parse(field);
                        } catch {
                            tokenIds = field.split(',').map((s: string) => s.trim());
                        }
                    } else if (Array.isArray(field)) {
                        tokenIds = field;
                    }
                    if (tokenIds.length > 0) break;
                }
            }
        }
        
        if (Array.isArray(tokenIds) && tokenIds.length > 0) {
            const subscribeMsg = { assets_ids: tokenIds, operation: 'subscribe' };
            currentWs.send(JSON.stringify(subscribeMsg));
            subscribedMarkets.add(slug);
            
            // Map each asset ID to this slug
            for (const assetId of tokenIds) {
                assetIdToSlug.set(String(assetId), slug);
            }
            
            console.log(`   ✅ Subscribed to ${slug} (${tokenIds.length} tokens: ${tokenIds.slice(0, 2).join(', ')}...)`);
        } else {
            console.log(`   ⚠️  No valid token IDs found for ${slug}. clobTokenIds type: ${typeof market.clobTokenIds}, value: ${String(market.clobTokenIds).substring(0, 100)}`);
        }
    } catch (err: any) {
        console.error(`   ❌ Error subscribing to ${slug}:`, err.message);
    }
};

const connectMarketWebSocket = async () => {
    const wsBase = (process.env.CLOB_WS_BASE || 'wss://ws-subscriptions-clob.polymarket.com').replace(/\/+$/, '');
    const wsUrl = `${wsBase}/ws/market`;
    
    let WsLib: any;
    try {
        WsLib = require('ws');
    } catch {
        WsLib = (globalThis as any).WebSocket;
    }
    
    if (!WsLib) {
        throw new Error('WebSocket is not available');
    }
    
    const connect = () => {
        console.log(`   🔄 Attempting to connect to WebSocket: ${wsUrl}`);
        const ws = new WsLib(wsUrl);
        currentWs = ws;
        let pingTimer: NodeJS.Timeout | null = null;
        let reconnectAttempts = 0;
        const MAX_RECONNECT_DELAY_MS = 30000;
        const BASE_RECONNECT_DELAY_MS = 1000;
        
        ws.addEventListener('connecting', () => {
            console.log(`   ⏳ WebSocket connecting...`);
        });
        
        ws.addEventListener('open', async () => {
            reconnectAttempts = 0;
            console.log(`🔌 Market WebSocket connected: ${wsUrl}`);
            
            // Send initial subscription message
            try {
                ws.send(JSON.stringify({ assets_ids: [], type: 'market' }));
                console.log(`   ✅ Sent initial subscription message`);
            } catch (err: any) {
                console.error(`   ❌ Error sending initial subscription:`, err.message);
            }
            
            pingTimer = setInterval(() => {
                try {
                    ws.send('PING');
                } catch (err: any) {
                    console.error(`   ❌ Error sending PING:`, err.message);
                }
            }, 10000);
            
            // Re-subscribe to previously discovered markets
            if (subscribedMarkets.size > 0) {
                console.log(`   🔄 Re-subscribing to ${subscribedMarkets.size} known markets...`);
                for (const slug of subscribedMarkets) {
                    subscribeToMarket(slug).catch(() => {
                        // Ignore errors, will retry
                    });
                }
            }
            
            // Try to discover and subscribe to Ethereum 1-hour markets
            // This runs asynchronously and doesn't block
            (async () => {
                try {
                    console.log(`   🔍 Searching for active Ethereum 1-hour markets...`);
                    
                    // First, try searching via API for active markets
                    const searchUrl = `https://gamma-api.polymarket.com/markets?limit=100&active=true`;
                    const searchResponse = await axios.get(searchUrl, { timeout: 10000 });
                    const allMarkets = Array.isArray(searchResponse.data) ? searchResponse.data : [];
                    
                    // Filter for Ethereum 1-hour markets
                    const eth1hMarkets = allMarkets.filter((m: any) => {
                        const slug = m.slug || '';
                        return isEthereum1hSlug(slug);
                    });
                    
                    console.log(`   📊 Found ${eth1hMarkets.length} Ethereum 1h market(s) via API search`);
                    
                    // Subscribe to all found markets
                    for (const market of eth1hMarkets.slice(0, 20)) { // Limit to 20 to avoid too many subscriptions
                        const slug = market.slug;
                        if (slug && !subscribedMarkets.has(slug)) {
                            await subscribeToMarket(slug);
                            await new Promise(resolve => setTimeout(resolve, 100)); // Small delay between subscriptions
                        }
                    }
                    
                    // Also try pattern-based discovery for current/upcoming hours
                    const now = new Date();
                    const currentHour = now.getHours();
                    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                                      'july', 'august', 'september', 'october', 'november', 'december'];
                    const month = monthNames[now.getMonth()].toLowerCase();
                    const day = now.getDate();
                    
                    // Try current hour and next few hours
                    for (let h = 0; h < 6; h++) { // Check more hours ahead
                        const testHour = (currentHour + h) % 24;
                        const testAmpm = testHour >= 12 ? 'pm' : 'am';
                        const testHour12 = testHour > 12 ? testHour - 12 : (testHour === 0 ? 12 : testHour);
                        const slugPattern = `ethereum-up-or-down-${month}-${day}-${testHour12}${testAmpm}-et`;
                        
                        if (!subscribedMarkets.has(slugPattern)) {
                            await subscribeToMarket(slugPattern);
                            await new Promise(resolve => setTimeout(resolve, 100));
                        }
                    }
                    
                    console.log(`   ✅ Market discovery complete. Subscribed to ${subscribedMarkets.size} market(s)`);
                } catch (err: any) {
                    console.warn(`   ⚠️  Market discovery error (non-blocking):`, err.message);
                }
            })();
        });
        
        ws.addEventListener('message', async (evt: any) => {
            const receivedAtMs = Date.now();
            const receivedAt = new Date(receivedAtMs).toISOString();
            
            // Track all messages received
            const totalMsgCount = ((global as any).wsTotalMsgCount || 0) + 1;
            (global as any).wsTotalMsgCount = totalMsgCount;
            
            let msg: any;
            try {
                msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
            } catch {
                return;
            }
            
            // Skip ping/pong messages
            if (msg === 'PONG' || msg === 'PING' || typeof msg === 'string') {
                return;
            }
            
            // Log message count periodically (more frequently for debugging)
            if (totalMsgCount % 100 === 0 || totalMsgCount <= 10) {
                const noSlugCount = (global as any).wsMsgNoSlugCount || 0;
                const skipCount = (global as any).wsSkipCount || 0;
                const ethEventCount = (global as any).wsEventCount || 0;
                console.log(`   📨 WS: ${totalMsgCount} msgs received | No slug: ${noSlugCount} | Skipped: ${skipCount} | ETH events: ${ethEventCount}`);
            }
            
            // Handle array of messages (WebSocket can send multiple events at once)
            const messages = Array.isArray(msg) ? msg : [msg];
            
            for (const singleMsg of messages) {
                // Extract slug from message (try multiple methods)
                let slug = singleMsg?.slug || singleMsg?.market_slug || singleMsg?.data?.slug;
                
                // If no slug, try asset_id lookup (most common in WebSocket messages)
                if (!slug) {
                    const assetId = singleMsg?.asset_id || singleMsg?.assetId || singleMsg?.data?.asset_id || singleMsg?.data?.assetId;
                    if (assetId) {
                        slug = assetIdToSlug.get(String(assetId));
                    }
                }
                
                // If still no slug, try conditionId lookup
                if (!slug) {
                    const conditionId = extractConditionId(singleMsg);
                    if (conditionId) {
                        slug = await fetchSlugForConditionId(conditionId);
                    }
                }
                
                if (!slug) {
                    // Log occasionally for debugging
                    const msgCount = (global as any).wsMsgNoSlugCount || 0;
                    (global as any).wsMsgNoSlugCount = msgCount + 1;
                    if (msgCount < 10 || msgCount % 1000 === 0) {
                        const conditionId = extractConditionId(singleMsg);
                        const assetId = singleMsg?.asset_id || singleMsg?.assetId;
                        console.log(`   ⚠️  WebSocket message has no slug (msg #${msgCount + 1})${conditionId ? `, conditionId: ${conditionId}` : ''}${assetId ? `, assetId: ${assetId}` : ''}:`, JSON.stringify(singleMsg).substring(0, 200));
                    }
                    continue; // Skip this message
                }
                
                if (!isEthereum1hSlug(slug)) {
                    // Log first few non-matching slugs for debugging, then periodically
                    const skipCount = (global as any).wsSkipCount || 0;
                    (global as any).wsSkipCount = skipCount + 1;
                    if (skipCount < 10 || skipCount % 1000 === 0) {
                        console.log(`   ⏭️  Skipping non-Ethereum 1h slug (${skipCount} skipped): ${slug}`);
                    }
                    continue; // Skip non-Ethereum 1-hour markets
                }
                
                // Auto-subscribe to newly discovered markets
                if (!subscribedMarkets.has(slug)) {
                    subscribeToMarket(slug).catch(() => {
                        // Ignore subscription errors, will retry
                    });
                }
                
                const event: EventRecord = {
                    receivedAtMs,
                    receivedAt,
                    source: 'market_ws',
                    slug,
                    data: singleMsg,
                };
                
                // Log WebSocket events occasionally
                const wsEventCount = (global as any).wsEventCount || 0;
                (global as any).wsEventCount = wsEventCount + 1;
                if (wsEventCount < 20 || wsEventCount % 100 === 0) {
                    console.log(`   📡 WebSocket event #${wsEventCount} for ${slug}: ${singleMsg?.event_type || singleMsg?.type || 'unknown'}`);
                }
                
                // Write to market log file
                logMarketEvent(slug, singleMsg, receivedAtMs);
                
                // Add event to buffer (will be flushed periodically and sorted)
                addEventToBuffer(slug, event);
                
                // Log every 1000 events to show we're collecting
                if (wsEventCount % 1000 === 0) {
                    const totalEvents = Array.from(slugEventCounts.values()).reduce((sum, count) => sum + count, 0);
                    console.log(`   📊 Total events written: ${totalEvents} across ${slugFileStreams.size} slug(s)`);
                }
            }
        });
        
        ws.addEventListener('error', (e: any) => {
            console.error('❌ Market WS error:', e?.message || e);
            console.error('   Error details:', JSON.stringify(e, null, 2));
        });
        
        ws.addEventListener('close', (code: number, reason: Buffer) => {
            currentWs = null;
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            
            const reasonStr = reason ? reason.toString() : 'unknown';
            console.log(`🔌 Market WS closed (code: ${code}, reason: ${reasonStr})`);
            
            // Reconnect with exponential backoff
            reconnectAttempts++;
            const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1));
            console.log(`🔄 Market WS reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
            setTimeout(() => connect(), delay);
        });
    };
    
    connect();
};

const startUserActivityPolling = async (user: string) => {
    const seenTrades = new Set<string>();
    
    console.log(`🔄 Starting user activity polling for ${user} (every ${USER_ACTIVITY_INTERVAL_MS}ms)`);
    
    while (true) {
        try {
            const trades = await fetchUserActivity(user, 100);
            
            if (trades.length > 0) {
                console.log(`   🔄 Fetched ${trades.length} trades from user activity API`);
            }
            
            for (const trade of trades) {
                if (!trade.slug) {
                    continue;
                }
                
                if (!isEthereum1hSlug(trade.slug)) {
                    // Log occasionally for debugging
                    if (Math.random() < 0.05 && trade.slug) { // 5% chance
                        console.log(`   ⏭️  Skipping non-Ethereum 1h trade slug: ${trade.slug}`);
                    }
                    continue; // Skip non-Ethereum 1-hour markets
                }
                
                const tradeKey = `${trade.transactionHash}:${trade.timestamp}`;
                if (seenTrades.has(tradeKey)) {
                    continue; // Skip duplicates
                }
                seenTrades.add(tradeKey);
                
                const receivedAtMs = Date.now();
                const receivedAt = new Date(receivedAtMs).toISOString();
                
                const event: EventRecord = {
                    receivedAtMs,
                    receivedAt,
                    source: 'user_activity',
                    slug: trade.slug,
                    data: trade,
                };
                
                // When we discover a slug from user activity, ensure we're subscribed to WebSocket
                if (!subscribedMarkets.has(trade.slug)) {
                    console.log(`   🔄 Auto-subscribing to WebSocket for ${trade.slug} (discovered via user activity)`);
                    
                    // Also store assetId -> slug mapping if available from trade data
                    if (trade.asset) {
                        assetIdToSlug.set(String(trade.asset), trade.slug);
                    }
                    
                    // Store conditionId -> slug mapping
                    if (trade.conditionId) {
                        conditionIdToSlug.set(trade.conditionId, trade.slug);
                    }
                    
                    subscribeToMarket(trade.slug).catch((err: any) => {
                        console.error(`   ⚠️  Failed to subscribe to ${trade.slug}:`, err.message);
                    });
                }
                
                // Add event to buffer (will be flushed periodically and sorted)
                addEventToBuffer(trade.slug, event);
            }
            
            // Cleanup old seen trades (keep last 10000)
            if (seenTrades.size > 10000) {
                const keys = Array.from(seenTrades);
                seenTrades.clear();
                keys.slice(-5000).forEach(k => seenTrades.add(k));
            }
        } catch (err: any) {
            console.error('❌ User activity polling error:', err.message);
        }
        
        await new Promise(resolve => setTimeout(resolve, USER_ACTIVITY_INTERVAL_MS));
    }
};


const main = async () => {
    console.log('🚀 Ethereum 1-Hour Market Data Collector');
    console.log('==========================================\n');
    
    // Initialize market log file
    initMarketLog();
    
    const user = getUserAddress();
    console.log(`👤 Monitoring user: ${user}`);
    console.log(`📊 Market pattern: ethereum-up-or-down-*-*-et`);
    console.log(`⏱️  User activity interval: ${USER_ACTIVITY_INTERVAL_MS}ms`);
    console.log(`💾 Batch write interval: ${BATCH_WRITE_INTERVAL_MS}ms`);
    if (isR2Configured()) {
        const { getR2BucketName } = await import('../utils/r2Client');
        console.log(`☁️  R2 configured: Yes (bucket: ${getR2BucketName()})`);
    } else {
        console.log(`☁️  R2 configured: No`);
    }
    console.log('');
    
    // Start market WebSocket
    connectMarketWebSocket().catch(err => {
        console.error('❌ Failed to start market WebSocket:', err);
        process.exit(1);
    });
    
    // Start user activity polling
    startUserActivityPolling(user).catch(err => {
        console.error('❌ Failed to start user activity polling:', err);
        process.exit(1);
    });
    
    // Start buffer flusher (flushes buffers periodically)
    startBufferFlusher();
    
    // Start upload checker (checks for inactive slugs and uploads them)
    startUploadChecker();
    
    // Handle shutdown
    const shutdown = async () => {
        console.log('\n🛑 Shutting down...');
        
        // Close market log file
        if (marketLogStream) {
            marketLogStream.end();
            console.log(`📝 Closed market log file: ${MARKET_LOG_FILE}`);
        }
        
        // Flush all buffers before shutdown
        for (const slug of slugEventBuffers.keys()) {
            await flushSlugBuffer(slug);
        }
        
        // Upload all remaining slug files
        const remainingSlugs = Array.from(slugFileStreams.keys());
        for (const slug of remainingSlugs) {
            console.log(`💾 Uploading remaining data for ${slug}...`);
            await uploadSlugFileToR2(slug);
        }
        
        // Close any remaining file streams
        for (const stream of slugFileStreams.values()) {
            stream.end();
        }
        
        process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    
    // Keep process alive
    await new Promise(() => {});
};

main().catch((err) => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
