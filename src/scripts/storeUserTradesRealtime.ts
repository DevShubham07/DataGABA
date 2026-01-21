import axios, { AxiosError } from 'axios';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';
import { uploadToR2, isR2Configured, downloadFromR2 } from '../utils/r2Client';

dotenv.config();

type TradeSide = 'BUY' | 'SELL';

interface ActivityTrade {
    id?: string;
    timestamp: number; // seconds
    transactionHash: string;
    slug?: string;
    market?: string;
    conditionId?: string;
    title?: string;
    outcome?: string;
    side: TradeSide;
    usdcSize: number;
    size: number;
    price: number;
    asset: string;
}

interface PersistedState {
    user: string;
    updatedAt: string;
    lastTimestampByGroup: Record<string, number>;
    seenTxOrder: string[];
    seenTxSet: Record<string, true>;
}

type Mode = 'rest' | 'ws';
type WsMode = 'user' | 'market' | 'dual';
type OnchainMode = 'pending' | 'block';

interface WsAuth {
    apiKey: string;
    secret: string;
    passphrase: string;
}

interface WsEventRecord {
    // local receipt time
    seenAtMs: number;
    seenAt: string;
    // server-provided event time (if present)
    eventTimeMs?: number;
    eventTime?: string;
    // market identity
    conditionId?: string;
    slugId?: string;
    // event identity
    eventType?: string;
    dedupKey: string;
    // payload
    data: any;
}

const DEFAULT_INTERVAL_SECONDS = 2;
const DEFAULT_LIMIT = 100;
// Use a new default output dir so we don't overwrite prior runs.
const DEFAULT_OUT_DIR = path.join(process.cwd(), 'user_trade_logs_realtime');
const MAX_SEEN_TX = 10000;
const MIN_INTERVAL_SECONDS = 0.05; // 50ms (note: REST polling this fast may get rate-limited)

const isValidEthereumAddress = (address: string): boolean => /^0x[a-fA-F0-9]{40}$/.test(address);

const parseArgs = (argv: string[]) => {
    const args = new Map<string, string | boolean>();
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            args.set(key, true);
        } else {
            args.set(key, next);
            i++;
        }
    }

    const user = String(args.get('user') || '').toLowerCase();
    const outDir = String(args.get('out') || DEFAULT_OUT_DIR);
    const intervalSecondsRaw = args.get('interval');
    const limitRaw = args.get('limit');
    const once = Boolean(args.get('once'));
    const modeRaw = (args.get('mode') || 'rest') as string | boolean;
    const mode = (typeof modeRaw === 'string' ? modeRaw : 'rest').toLowerCase() as Mode | 'ws';
    const wsModeRaw = (args.get('ws-mode') || args.get('wsMode') || 'dual') as string | boolean;
    const wsMode = (typeof wsModeRaw === 'string' ? wsModeRaw : 'dual').toLowerCase() as WsMode;
    const slugPrefix =
        (typeof args.get('slug-prefix') === 'string' ? String(args.get('slug-prefix')) : undefined) ||
        (typeof args.get('slugPrefix') === 'string' ? String(args.get('slugPrefix')) : undefined);
    const pretty = Boolean(args.get('pretty'));
    const raw = Boolean(args.get('raw'));
    const deriveCreds = Boolean(args.get('derive-creds') || args.get('deriveCreds'));
    const unified = Boolean(args.get('unified') || args.get('events'));
    const withRest = Boolean(
        args.get('with-rest') || args.get('withRest') || args.get('with-rest-poll') || args.get('withRestPoll')
    );
    const withOnchain = Boolean(
        args.get('with-onchain') || args.get('withOnchain') || args.get('with-chain') || args.get('withChain')
    );
    const onchainModeRaw = (args.get('onchain-mode') || args.get('onchainMode') || 'pending') as string | boolean;
    const onchainMode = (typeof onchainModeRaw === 'string' ? onchainModeRaw : 'pending').toLowerCase() as OnchainMode;
    const full =
        Boolean(args.get('full')) ||
        Boolean(args.get('keep-all')) ||
        Boolean(args.get('keepAll')) ||
        Boolean(args.get('verbose')) ||
        Boolean(args.get('no-compact')) ||
        Boolean(args.get('noCompact'));
    const compact = !full; // default compact output (ML-friendly)

    const intervalSeconds =
        typeof intervalSecondsRaw === 'string'
            ? Math.max(MIN_INTERVAL_SECONDS, Number(intervalSecondsRaw))
            : DEFAULT_INTERVAL_SECONDS;
    const limit =
        typeof limitRaw === 'string' ? Math.min(1000, Math.max(1, Math.floor(Number(limitRaw)))) : DEFAULT_LIMIT;

    return {
        user,
        outDir,
        intervalSeconds,
        limit,
        once,
        slugPrefix,
        pretty,
        mode,
        raw,
        wsMode,
        deriveCreds,
        unified,
        withRest,
        withOnchain,
        onchainMode,
        compact,
    };
};

const sanitizeFileComponent = (input: string): string => {
    const cleaned = input
        .trim()
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+/, '')
        .replace(/_+$/, '');
    const safe = cleaned.length > 0 ? cleaned : 'unknown';
    return safe.slice(0, 140);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isNetworkError = (error: unknown): boolean => {
    if (!axios.isAxiosError(error)) return false;
    const e = error as AxiosError;
    const code = e.code;
    return (
        code === 'ETIMEDOUT' ||
        code === 'ENETUNREACH' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        !e.response
    );
};

const isRateLimitError = (error: unknown): boolean => {
    if (!axios.isAxiosError(error)) return false;
    const e = error as AxiosError;
    return e.response?.status === 429;
};

const fetchTrades = async (user: string, limit: number): Promise<ActivityTrade[]> => {
    const url = `https://data-api.polymarket.com/activity?user=${user}&type=TRADE&limit=${limit}`;
    const maxRetries = 5; // Increased for rate limit handling
    const MAX_BACKOFF_MS = 60000; // Max 60 second backoff for rate limits

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(url, {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                },
                family: 4,
            });

            return Array.isArray(response.data) ? (response.data as ActivityTrade[]) : [];
        } catch (err) {
            const last = attempt === maxRetries;
            
            // Handle rate limiting (429) with longer exponential backoff
            if (isRateLimitError(err)) {
                const baseDelay = 5000; // Start with 5 second delay for rate limits
                const delay = Math.min(MAX_BACKOFF_MS, baseDelay * Math.pow(2, attempt - 1));
                console.warn(`⚠️  Rate limited (429), backing off for ${Math.round(delay / 1000)}s (attempt ${attempt}/${maxRetries})...`);
                await sleep(delay);
                continue;
            }
            
            // Handle network errors
            if (!last && isNetworkError(err)) {
                const delay = 1000 * Math.pow(2, attempt - 1);
                console.warn(`⚠️  Network error, retrying in ${Math.round(delay / 1000)}s...`);
                await sleep(delay);
                continue;
            }
            throw err;
        }
    }

    return [];
};

const fetchJson = async <T = any>(url: string, timeoutMs: number = 15000): Promise<T> => {
    const resp = await axios.get(url, {
        timeout: timeoutMs,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        family: 4,
    });
    return resp.data as T;
};

const normalizeStringArray = (value: unknown): string[] => {
    if (Array.isArray(value)) {
        return value.filter((v) => typeof v === 'string') as string[];
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        // Some endpoints may return JSON-encoded arrays as strings.
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) {
                    return parsed.filter((v) => typeof v === 'string') as string[];
                }
            } catch {
                // ignore
            }
        }
        // Fallback: comma-separated
        if (trimmed.includes(',')) {
            return trimmed
                .split(',')
                .map((s) => s.trim().replace(/^"+|"+$/g, ''))
                .filter(Boolean);
        }
    }
    return [];
};

const stateR2KeyFor = (user: string) =>
    `raw_events/${sanitizeFileComponent(user)}/_state.json`;

const metaR2KeyFor = (user: string, slugId: string) =>
    `raw_events/${sanitizeFileComponent(user)}/by_slug/${sanitizeFileComponent(slugId)}/meta.json`;

const saveMetaToR2 = async (user: string, slugId: string, meta: any) => {
    if (!isR2Configured()) {
        console.warn('⚠️  R2 not configured, skipping meta.json save');
        return;
    }
    
    const r2Key = metaR2KeyFor(user, slugId);
    await uploadToR2({
        key: r2Key,
        content: JSON.stringify(meta, null, 2) + '\n',
        contentType: 'application/json',
    });
};

const loadState = async (outDir: string, user: string): Promise<PersistedState> => {
    const r2Key = stateR2KeyFor(user);
    try {
        if (!isR2Configured()) {
            return {
                user,
                updatedAt: new Date().toISOString(),
                lastTimestampByGroup: {},
                seenTxOrder: [],
                seenTxSet: {},
            };
        }
        
        const raw = await downloadFromR2(r2Key);
        if (!raw) {
            return {
                user,
                updatedAt: new Date().toISOString(),
                lastTimestampByGroup: {},
                seenTxOrder: [],
                seenTxSet: {},
            };
        }
        
        const parsed = JSON.parse(raw) as Partial<PersistedState>;
        return {
            user,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            lastTimestampByGroup: parsed.lastTimestampByGroup || {},
            seenTxOrder: Array.isArray(parsed.seenTxOrder) ? parsed.seenTxOrder : [],
            seenTxSet: parsed.seenTxSet || {},
        };
    } catch {
        return {
            user,
            updatedAt: new Date().toISOString(),
            lastTimestampByGroup: {},
            seenTxOrder: [],
            seenTxSet: {},
        };
    }
};

const saveState = async (outDir: string, user: string, state: PersistedState) => {
    const r2Key = stateR2KeyFor(user);
    const payload: PersistedState = {
        ...state,
        user,
        updatedAt: new Date().toISOString(),
    };
    
    if (isR2Configured()) {
        await uploadToR2({
            key: r2Key,
            content: JSON.stringify(payload, null, 2),
            contentType: 'application/json',
        });
    }
};

const makeDedupKey = (t: ActivityTrade) => {
    // Prefer API-provided id if present; fall back to a composite key
    if (t.id) return `id:${t.id}`;
    return [
        'tx',
        t.transactionHash,
        'ts',
        t.timestamp,
        'asset',
        t.asset,
        'side',
        t.side,
        'price',
        t.price,
        'usdc',
        t.usdcSize,
        'size',
        t.size,
        'outcome',
        t.outcome || '',
    ].join('|');
};

const toLogObject = (t: ActivityTrade, seenAtMs: number) => {
    const iso = new Date(t.timestamp * 1000).toISOString();
    const slugId = t.slug || t.market || t.conditionId || 'unknown';
    const title = t.title || '';
    const outcome = t.outcome || '';
    return {
        // IMPORTANT:
        // - `timestamp`/`time` come from the Polymarket Data API and are second-resolution.
        // - `seenAtMs`/`seenAt` are local wall-clock times (ms) when *this script observed* the trade.
        seenAtMs,
        seenAt: new Date(seenAtMs).toISOString(),
        timestamp: t.timestamp,
        time: iso,
        slugId,
        side: t.side,
        usdcSize: t.usdcSize,
        price: t.price,
        size: t.size,
        asset: t.asset,
        outcome,
        title,
        transactionHash: t.transactionHash,
        id: t.id,
    };
};

const slugKey = (t: ActivityTrade) => t.slug || t.market || t.conditionId || 'unknown';

const readJsonArraySafe = (filePath: string): any[] => {
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

const writePrettyJsonArray = (filePath: string, items: any[]) => {
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2) + '\n', 'utf8');
};

const shouldIncludeSlug = (slugId: string, slugPrefix?: string) => {
    if (!slugPrefix) return true;
    return slugId.startsWith(slugPrefix);
};

const groupKeyFor = (slugId: string, slugPrefix?: string) => {
    // Always store data per-slug (one file per slugId).
    // If slugPrefix is provided, it only acts as a filter, not a grouping key.
    return slugId;
};

const readJsonArrayAsMap = (filePath: string, keyField: string): Map<string, any> => {
    const existing = readJsonArraySafe(filePath);
    const map = new Map<string, any>();
    for (const item of existing) {
        if (!item || typeof item !== 'object') continue;
        const key = (item as any)[keyField];
        if (typeof key === 'string') map.set(key, item);
    }
    return map;
};

const parseEventTimeMs = (msg: any): number | undefined => {
    const candidates: any[] = [
        msg?.matchtime,
        msg?.matchTime,
        msg?.timestamp,
        msg?.time,
        msg?.createdAt,
        msg?.created_at,
        msg?.last_update,
        msg?.lastUpdate,
        msg?.data?.matchtime,
        msg?.data?.matchTime,
        msg?.data?.timestamp,
        msg?.data?.createdAt,
        msg?.data?.created_at,
        msg?.data?.last_update,
        msg?.data?.lastUpdate,
    ];

    for (const c of candidates) {
        if (typeof c === 'number') {
            // if looks like ms already
            if (c > 1e12) return Math.floor(c);
            // seconds resolution
            if (c > 1e9) return Math.floor(c * 1000);
        }
        if (typeof c === 'string') {
            const t = Date.parse(c);
            if (!Number.isNaN(t)) return t;
            // maybe numeric string
            const n = Number(c);
            if (Number.isFinite(n)) {
                if (n > 1e12) return Math.floor(n);
                if (n > 1e9) return Math.floor(n * 1000);
            }
        }
    }
    return undefined;
};

const extractConditionId = (msg: any): string | undefined => {
    const c =
        msg?.conditionId ||
        msg?.condition_id ||
        msg?.market ||
        msg?.marketId ||
        msg?.market_id ||
        msg?.data?.conditionId ||
        msg?.data?.condition_id ||
        msg?.data?.market ||
        msg?.data?.marketId ||
        msg?.data?.market_id;
    return typeof c === 'string' ? c : undefined;
};

const extractEventType = (msg: any): string | undefined => {
    const t = msg?.event_type || msg?.eventType || msg?.type || msg?.channel || msg?.topic;
    return typeof t === 'string' ? t : undefined;
};

const fetchSlugForConditionId = async (
    conditionId: string,
    cache: Map<string, string>
): Promise<string | undefined> => {
    const existing = cache.get(conditionId);
    if (existing) return existing;

    try {
        // NOTE: `condition_ids` is the param that reliably maps to the expected market.
        const url = `https://gamma-api.polymarket.com/markets?limit=1&condition_ids=${encodeURIComponent(conditionId)}`;
        const j = await fetchJson<any>(url, 15000);
        if (Array.isArray(j) && j[0] && typeof j[0].slug === 'string') {
            cache.set(conditionId, j[0].slug);
            return j[0].slug;
        }
    } catch {
        // ignore
    }
    return undefined;
};

// ---- Health monitoring stats ----
const healthStats = {
    startTime: Date.now(),
    marketWsEvents: 0,
    userWsEvents: 0,
    restPollEvents: 0,
    onchainEvents: 0,
    wsReconnects: 0,
    lastEventTime: 0,
};

const HEALTH_LOG_INTERVAL_MS = 60000; // Log health every 60 seconds

const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    }
    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
};

const formatMemory = (bytes: number): string => {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)}MB`;
};

const logHealthStatus = () => {
    const uptime = Date.now() - healthStats.startTime;
    const memUsage = process.memoryUsage();
    const totalEvents = healthStats.marketWsEvents + healthStats.userWsEvents + healthStats.restPollEvents + healthStats.onchainEvents;
    const timeSinceLastEvent = healthStats.lastEventTime > 0 ? Date.now() - healthStats.lastEventTime : 0;
    
    console.log(
        `[HEALTH] uptime=${formatUptime(uptime)} | events: market_ws=${healthStats.marketWsEvents}, rest=${healthStats.restPollEvents}, user_ws=${healthStats.userWsEvents}, onchain=${healthStats.onchainEvents}, total=${totalEvents} | ws_reconnects=${healthStats.wsReconnects} | memory: heap=${formatMemory(memUsage.heapUsed)}/${formatMemory(memUsage.heapTotal)}, rss=${formatMemory(memUsage.rss)} | last_event=${timeSinceLastEvent > 0 ? formatUptime(timeSinceLastEvent) + ' ago' : 'none'}`
    );
};

// ---- Local-first JSONL writer (writes locally, uploads to R2 when slug ends) ----
class JsonlWriter {
    private activeSlugs = new Set<string>(); // Track active slugs
    private completedSlugs = new Map<string, NodeJS.Timeout>(); // Slug -> timeout for upload
    private currentSlug: string | null = null; // Track current slug being written
    private readonly SLUG_END_DELAY_MS = 20000; // Wait 20 seconds after slug ends before uploading
    private readonly MAX_CONCURRENT_UPLOADS = 2; // Max concurrent uploads to R2

    constructor() {
        if (!isR2Configured()) {
            console.warn('⚠️  R2 not configured - files will only be saved locally!');
        }
    }

    write(filePath: string, obj: any) {
        // Ensure directory exists
        ensureDirForFile(filePath);

        // Write directly to local file (append mode)
        const jsonLine = JSON.stringify(obj) + '\n';
        try {
            fs.appendFileSync(filePath, jsonLine, 'utf8');
        } catch (err: any) {
            console.error(`❌ Failed to write to ${filePath}: ${err.message}`);
            return;
        }

        // Extract slug from file path to track active slugs
        // Path format: dataset/0x.../by_slug/btc-updown-15m-123/events.jsonl
        const slugMatch = filePath.match(/by_slug\/([^\/]+)\//);
        if (slugMatch) {
            const slugId = slugMatch[1];
            this.trackSlug(slugId, filePath);
        }
    }

    private trackSlug(slugId: string, filePath: string) {
        // If this is a different slug than current, the previous slug ended
        if (this.currentSlug !== null && this.currentSlug !== slugId) {
            // Previous slug ended - schedule upload
            this.scheduleSlugUpload(this.currentSlug, filePath);
        }

        // Update current slug
        if (!this.activeSlugs.has(slugId)) {
            this.activeSlugs.add(slugId);
        }
        this.currentSlug = slugId;
    }

    private async uploadSlugToR2(slugId: string) {
        if (!isR2Configured()) {
            console.warn(`⚠️  R2 not configured, skipping upload for slug ${slugId}`);
            return;
        }

        // Extract user from slug path - need to search for the slug directory
        // We need to find the actual file path that contains this slug
        const datasetDir = path.join(process.cwd(), 'dataset');
        if (!fs.existsSync(datasetDir)) {
            return;
        }

        // Search for slug directory in dataset
        let slugDir: string | null = null;
        try {
            const userDirs = fs.readdirSync(datasetDir);
            for (const userDir of userDirs) {
                const userPath = path.join(datasetDir, userDir);
                if (!fs.statSync(userPath).isDirectory()) continue;
                
                const bySlugPath = path.join(userPath, 'by_slug', sanitizeFileComponent(slugId));
                if (fs.existsSync(bySlugPath)) {
                    slugDir = bySlugPath;
                    break;
                }
            }
        } catch {
            return;
        }

        if (!slugDir || !fs.existsSync(slugDir)) {
            return;
        }

        const filesToUpload: string[] = [];
        
        // Find events.jsonl
        const eventsFile = path.join(slugDir, 'events.jsonl');
        if (fs.existsSync(eventsFile)) {
            filesToUpload.push(eventsFile);
        }

        // Find meta.json
        const metaFile = path.join(slugDir, 'meta.json');
        if (fs.existsSync(metaFile)) {
            filesToUpload.push(metaFile);
        }

        if (filesToUpload.length === 0) {
            return;
        }

        // Upload files to R2
        for (const localFile of filesToUpload) {
            try {
                const relativePath = path.relative(process.cwd(), localFile);
                const r2Key = relativePath.replace(/^dataset\//, 'raw_events/');
                
                const content = fs.readFileSync(localFile, 'utf8');
                const contentType = localFile.endsWith('.json') ? 'application/json' : 'application/x-ndjson';
                
                const success = await uploadToR2({
                    key: r2Key,
                    content,
                    contentType,
                });

                if (success) {
                    // Delete local file after successful upload
                    fs.unlinkSync(localFile);
                    console.log(`   ✅ Uploaded and deleted: ${path.basename(localFile)} → ${r2Key}`);
                } else {
                    console.error(`   ❌ Failed to upload ${path.basename(localFile)} to R2, keeping local file`);
                }
            } catch (err: any) {
                console.error(`   ❌ Error uploading ${path.basename(localFile)}: ${err.message}, keeping local file`);
            }
        }

        // Try to remove empty directory
        try {
            const files = fs.readdirSync(slugDir);
            if (files.length === 0) {
                fs.rmdirSync(slugDir);
                // Try to remove parent by_slug if empty
                const bySlugParent = path.dirname(slugDir);
                const bySlugFiles = fs.readdirSync(bySlugParent);
                if (bySlugFiles.length === 0) {
                    fs.rmdirSync(bySlugParent);
                }
            }
        } catch {
            // Ignore errors removing directory
        }
    }

    async scheduleSlugUpload(slugId: string, filePath: string) {
        // Cancel existing timeout if any
        const existingTimeout = this.completedSlugs.get(slugId);
        if (existingTimeout) {
            clearTimeout(existingTimeout);
        }

        // Remove from active slugs
        this.activeSlugs.delete(slugId);

        // Schedule upload after delay
        const timeout = setTimeout(() => {
            this.completedSlugs.delete(slugId);
            this.uploadSlugToR2(slugId).catch(err => {
                console.error(`❌ Failed to upload slug ${slugId}:`, err.message);
            });
        }, this.SLUG_END_DELAY_MS);

        this.completedSlugs.set(slugId, timeout);
        console.log(`   ⏳ Scheduled upload for completed slug ${slugId} in ${this.SLUG_END_DELAY_MS / 1000}s`);
    }

    async flush() {
        // Upload all completed slugs immediately
        const slugsToUpload = Array.from(this.completedSlugs.keys());
        for (const slugId of slugsToUpload) {
            const timeout = this.completedSlugs.get(slugId);
            if (timeout) {
                clearTimeout(timeout);
                this.completedSlugs.delete(slugId);
            }
            await this.uploadSlugToR2(slugId);
        }

        // Upload all active slugs
        const activeSlugs = Array.from(this.activeSlugs);
        for (const slugId of activeSlugs) {
            await this.uploadSlugToR2(slugId);
        }
        this.activeSlugs.clear();
    }

    closeAll() {
        // Clear all timeouts
        for (const timeout of this.completedSlugs.values()) {
            clearTimeout(timeout);
        }
        this.completedSlugs.clear();

        // Upload remaining slugs
        this.flush().catch(() => {
            // Ignore errors during shutdown
        });
    }
}

type UnifiedRecord = {
    v: 1;
    source: 'user_ws' | 'market_ws' | 'rest_poll';
    receivedAtMs: number;
    receivedAt: string;
    eventAtMs?: number;
    eventAt?: string;
    slugId?: string;
    conditionId?: string;
    assetId?: string;
    eventType?: string;
    dedupKey: string;
    data: any;
};

type MlEvent = {
    v: 1;
    // timestamps
    t: number; // event time (ms), falling back to received time
    recv: number; // received time (ms)
    // identity
    src: 'market_ws' | 'rest_poll' | 'user_ws' | 'onchain';
    slug?: string;
    cid?: string;
    aid?: string;
    // event kind
    type: string;
    // normalized numeric features
    price?: number;
    size?: number;
    usdc?: number;
    bestBid?: number;
    bestAsk?: number;
    mid?: number;
    spread?: number;
    side?: string;
    outcome?: string;
    tx?: string;
    hash?: string;
    to?: string;
    method?: string;
    block?: number;
    // stable dedup
    k: string;
    // optional raw payload for forensic debugging (only when --raw)
    raw?: any;
};

const ensureDirForFile = (filePath: string) => {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const toUnified = (source: UnifiedRecord['source'], r: WsEventRecord): UnifiedRecord => ({
    v: 1,
    source,
    receivedAtMs: r.seenAtMs,
    receivedAt: r.seenAt,
    eventAtMs: r.eventTimeMs,
    eventAt: r.eventTime,
    slugId: r.slugId,
    conditionId: r.conditionId,
    assetId: (r.data && (r.data.asset_id || r.data.assetId || r.data.data?.asset_id || r.data.data?.assetId)) as
        | string
        | undefined,
    eventType: r.eventType,
    dedupKey: r.dedupKey,
    data: r.data,
});

const toNumber = (v: any): number | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
    }
    return undefined;
};

const toMlEvents = (u: UnifiedRecord, opts: { compact: boolean; raw: boolean; tokenToOutcome?: Record<string, string> }): MlEvent[] => {
    const recv = u.receivedAtMs;
    const t = typeof u.eventAtMs === 'number' ? u.eventAtMs : recv;
    const base = {
        v: 1 as const,
        t,
        recv,
        src: u.source,
        slug: u.slugId,
        cid: u.conditionId,
        aid: u.assetId,
        type: u.eventType || 'event',
        k: u.dedupKey,
    };

    if (!opts.compact) {
        // legacy / verbose mode: keep original unified record under `raw`
        return [
            {
                ...base,
                raw: opts.raw ? u.data : undefined,
            },
        ];
    }

    // Compact / ML-friendly flattening
    if (u.source === 'market_ws') {
        const msg = u.data || {};
        const eventType = String(u.eventType || msg.event_type || msg.eventType || 'market');

        if (eventType === 'price_change' && Array.isArray(msg.price_changes)) {
            const out: MlEvent[] = [];
            for (const pc of msg.price_changes) {
                const aid = (pc && (pc.asset_id || pc.assetId)) as string | undefined;
                const bestBid = toNumber(pc?.best_bid);
                const bestAsk = toNumber(pc?.best_ask);
                const mid = typeof bestBid === 'number' && typeof bestAsk === 'number' ? (bestBid + bestAsk) / 2 : undefined;
                const spread = typeof bestBid === 'number' && typeof bestAsk === 'number' ? bestAsk - bestBid : undefined;
                const rec: MlEvent = {
                    ...base,
                    type: 'price_change',
                    aid: aid || base.aid,
                    price: toNumber(pc?.price),
                    size: toNumber(pc?.size),
                    bestBid,
                    bestAsk,
                    mid,
                    spread,
                    side: typeof pc?.side === 'string' ? pc.side : undefined,
                    hash: typeof pc?.hash === 'string' ? pc.hash : undefined,
                    outcome: aid && opts.tokenToOutcome ? opts.tokenToOutcome[aid] : undefined,
                    raw: opts.raw ? pc : undefined,
                };
                out.push(rec);
            }
            return out;
        }

        if (eventType === 'last_trade_price') {
            const aid =
                (typeof msg.asset_id === 'string' ? msg.asset_id : undefined) ||
                (typeof msg.assetId === 'string' ? msg.assetId : undefined);
            return [
                {
                    ...base,
                    type: 'last_trade_price',
                    aid: aid || base.aid,
                    price: toNumber(msg.price),
                    size: toNumber(msg.size),
                    side: typeof msg.side === 'string' ? msg.side : undefined,
                    tx: typeof msg.transaction_hash === 'string' ? msg.transaction_hash : undefined,
                    outcome: aid && opts.tokenToOutcome ? opts.tokenToOutcome[aid] : undefined,
                    raw: opts.raw ? msg : undefined,
                },
            ];
        }

        // fallback for other market events
        return [
            {
                ...base,
                type: eventType,
                raw: opts.raw ? msg : undefined,
            },
        ];
    }

    if (u.source === 'rest_poll') {
        const t = u.data || {};
        const aid = (typeof t.asset === 'string' ? t.asset : undefined) || (typeof t.assetId === 'string' ? t.assetId : undefined);
        return [
            {
                ...base,
                type: 'trade',
                aid: aid || base.aid,
                price: toNumber(t.price),
                size: toNumber(t.size),
                usdc: toNumber(t.usdcSize),
                side: typeof t.side === 'string' ? t.side : undefined,
                outcome: typeof t.outcome === 'string' ? t.outcome : undefined,
                tx: typeof t.transactionHash === 'string' ? t.transactionHash : undefined,
                raw: opts.raw ? t : undefined,
            },
        ];
    }

    // user_ws or unknown source
    return [
        {
            ...base,
            raw: opts.raw ? u.data : undefined,
        },
    ];
};

const toHex32 = (n: bigint): string => {
    const hex = n.toString(16);
    return hex.padStart(64, '0');
};

const safeBigInt = (s: string): bigint | null => {
    try {
        if (!s) return null;
        // token ids are decimal strings
        return BigInt(s);
    } catch {
        return null;
    }
};

const computeCandidateSlugsForPrefix = (slugPrefix: string): string[] => {
    const is15mSeries = /-15m$/.test(slugPrefix);
    const candidateSlugs: string[] = [];
    if (is15mSeries) {
        const nowSec = Math.floor(Date.now() / 1000);
        const bucket = Math.floor(nowSec / 900) * 900;
        for (const t of [bucket - 900, bucket, bucket + 900]) {
            candidateSlugs.push(`${slugPrefix}-${t}`);
        }
    } else {
        candidateSlugs.push(slugPrefix);
    }
    return candidateSlugs;
};

const loadOrFetchMetaForSlug = async (opts: { outDir: string; user: string; slugId: string }) => {
    const r2Key = metaR2KeyFor(opts.user, opts.slugId);
    
    // Try to load from R2 first
    try {
        if (isR2Configured()) {
            const raw = await downloadFromR2(r2Key);
            if (raw) {
                return JSON.parse(raw);
            }
        }
    } catch {
        // ignore
    }

    // Fetch from API if not in R2
    try {
        const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(opts.slugId)}`;
        const j = await fetchJson<any>(url, 15000);
        const m = Array.isArray(j) ? j[0] : null;
        const clobTokenIds = normalizeStringArray(m?.clobTokenIds);
        if (!m?.conditionId || clobTokenIds.length === 0) return null;
        const meta = {
            conditionId: m.conditionId,
            slugId: m.slug,
            clobTokenIds,
            outcomes: normalizeStringArray(m.outcomes),
        };
        // Save to R2 instead of local file
        await saveMetaToR2(opts.user, opts.slugId, meta);
        return meta;
    } catch {
        return null;
    }
};

const startOnchainMonitor = async (opts: {
    outDir: string;
    user: string;
    slugPrefix?: string;
    mode: OnchainMode;
    writer: JsonlWriter;
    compact: boolean;
    raw: boolean;
    unified: boolean;
}) => {
    const wsUrl =
        process.env.POLYGON_WS_URL ||
        process.env.POLYGON_RPC_WS_URL ||
        process.env.POLYGON_WSS_URL ||
        process.env.RPC_WSS_URL;
    const httpUrl =
        process.env.POLYGON_HTTP_URL ||
        process.env.POLYGON_RPC_URL ||
        process.env.RPC_URL ||
        process.env.POLYGON_RPC_HTTP_URL;
    if (opts.mode === 'pending' && !wsUrl) {
        throw new Error(
            'Missing Polygon websocket RPC url. Set POLYGON_WS_URL (wss://...) in .env to enable pending-tx monitoring, or use --onchain-mode block with an HTTP RPC URL.'
        );
    }

    let Providers: any;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        Providers = require('@ethersproject/providers');
    } catch {
        throw new Error(
            'Missing @ethersproject/providers (needed for on-chain monitoring). Install dependencies and try again.'
        );
    }

    const provider = wsUrl ? new Providers.WebSocketProvider(wsUrl) : httpUrl ? new Providers.JsonRpcProvider(httpUrl) : null;
    if (!provider) {
        throw new Error(
            'Missing Polygon RPC url. Set POLYGON_WS_URL (wss://...) or POLYGON_RPC_URL / RPC_URL (https://...) in .env to enable on-chain monitoring.'
        );
    }
    const userLower = opts.user.toLowerCase();

    // Build token-id hex index for the relevant slugs (so we can tag tx to slug/outcome when possible).
    const tokenHexToInfo = new Map<string, { slugId: string; aid: string; cid?: string; outcome?: string }>();
    if (opts.slugPrefix) {
        const candidateSlugs = computeCandidateSlugsForPrefix(opts.slugPrefix);
        for (const slug of candidateSlugs) {
            const meta = await loadOrFetchMetaForSlug({ outDir: opts.outDir, user: opts.user, slugId: slug });
            const tokenIds = normalizeStringArray(meta?.clobTokenIds);
            const outcomes = normalizeStringArray(meta?.outcomes);
            for (let i = 0; i < tokenIds.length; i++) {
                const bi = safeBigInt(tokenIds[i]);
                if (bi === null) continue;
                const hex32 = toHex32(bi);
                tokenHexToInfo.set(hex32, {
                    slugId: typeof meta?.slugId === 'string' ? meta.slugId : slug,
                    aid: tokenIds[i],
                    cid: typeof meta?.conditionId === 'string' ? meta.conditionId : undefined,
                    outcome: outcomes.length === tokenIds.length ? outcomes[i] : undefined,
                });
            }
        }
    }

    const tagFromCalldata = (dataHex: string | undefined) => {
        if (!dataHex) return null;
        const data = dataHex.startsWith('0x') ? dataHex.slice(2).toLowerCase() : dataHex.toLowerCase();
        for (const [needle, info] of tokenHexToInfo.entries()) {
            if (data.includes(needle.toLowerCase())) return info;
        }
        return null;
    };

    const emitTx = (tx: any, eventAtMs: number, blockNumber?: number) => {
        const recv = Date.now();
        const method = typeof tx?.data === 'string' && tx.data.startsWith('0x') ? tx.data.slice(0, 10) : undefined;
        const tag = tagFromCalldata(tx?.data);
        const slugId = tag?.slugId;
        const outSlug = slugId || 'unknown';
        const outPath = opts.unified ? eventsJsonlPathFor(opts.outDir, opts.user, outSlug) : eventsJsonlPathFor(opts.outDir, opts.user, outSlug);

        const e: MlEvent = {
            v: 1,
            t: eventAtMs,
            recv,
            src: 'onchain',
            slug: slugId,
            cid: tag?.cid,
            aid: tag?.aid,
            type: 'onchain_tx',
            side: undefined,
            outcome: tag?.outcome,
            tx: typeof tx?.hash === 'string' ? tx.hash : undefined,
            to: typeof tx?.to === 'string' ? tx.to : undefined,
            method,
            block: typeof blockNumber === 'number' ? blockNumber : undefined,
            k: `onchain:${opts.mode}:${typeof tx?.hash === 'string' ? tx.hash : JSON.stringify(tx).slice(0, 32)}`,
            raw: opts.raw ? tx : undefined,
        };

        opts.writer.write(outPath, e);
        healthStats.onchainEvents++;
        healthStats.lastEventTime = Date.now();
        if (opts.raw === false && opts.compact === false) {
            // nothing
        }
    };

    // Polymarket CTF Exchange contract addresses (main + legacy)
    const CTF_EXCHANGE_ADDRESSES = [
        '0xC5d563A36AE78145C45a50134d48A1215220f80a', // Current
        '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Legacy
    ];
    
    // OrderFilled event signature: OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)
    const ORDER_FILLED_TOPIC = '0x268820db288a211986b26a8fda86b1e0046281b21206936bb0e61c67b5c2ef5d';
    
    console.log(`⛓️  On-chain monitor enabled (${opts.mode}) via ${wsUrl || httpUrl}`);
    console.log(`📋 Monitoring CTF Exchange contracts for OrderFilled events (maker/taker=${opts.user})`);

    // Listen for OrderFilled events from CTF Exchange contracts
    for (const contractAddr of CTF_EXCHANGE_ADDRESSES) {
        const contract = new (require('ethers').Contract)(contractAddr, [
            'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
        ], provider);
        
        contract.on('OrderFilled', async (orderHash: string, maker: string, taker: string, makerAssetId: any, takerAssetId: any, makerAmountFilled: any, takerAmountFilled: any, fee: any, event: any) => {
            try {
                const makerLower = maker.toLowerCase();
                const takerLower = taker.toLowerCase();
                if (makerLower !== userLower && takerLower !== userLower) return;
                
                const block = await provider.getBlock(event.blockNumber).catch(() => null);
                const eventAtMs = block?.timestamp ? block.timestamp * 1000 : Date.now();
                
                console.log(`✅ OrderFilled event: orderHash=${orderHash}, maker=${maker}, taker=${taker}, block=${event.blockNumber}`);
                
                // Try to map assetId to slug
                const assetIdStr = makerAssetId.toString();
                let tag = null;
                for (const [hex32, info] of tokenHexToInfo.entries()) {
                    if (assetIdStr === info.aid || assetIdStr.includes(hex32.slice(2)) || hex32.includes(assetIdStr.slice(0, 16))) {
                        tag = info;
                        break;
                    }
                }
                
                const recv = Date.now();
                const outSlug = tag?.slugId || 'unknown';
                const outPath = eventsJsonlPathFor(opts.outDir, opts.user, outSlug);
                
                const e: MlEvent = {
                    v: 1,
                    t: eventAtMs,
                    recv,
                    src: 'onchain',
                    slug: tag?.slugId,
                    cid: tag?.cid,
                    aid: assetIdStr,
                    type: 'onchain_tx',
                    side: makerLower === userLower ? 'SELL' : 'BUY', // maker sells, taker buys
                    outcome: tag?.outcome,
                    tx: event.transactionHash,
                    to: contractAddr,
                    method: 'OrderFilled',
                    block: event.blockNumber,
                    price: undefined, // would need to compute from amounts
                    size: makerAmountFilled.toString(),
                    usdc: makerAssetId.toString() === '0' ? makerAmountFilled.toString() : takerAmountFilled.toString(),
                    k: `onchain:OrderFilled:${orderHash}:${event.transactionHash}`,
                    raw: opts.raw ? { orderHash, maker, taker, makerAssetId: makerAssetId.toString(), takerAssetId: takerAssetId.toString(), makerAmountFilled: makerAmountFilled.toString(), takerAmountFilled: takerAmountFilled.toString(), fee: fee.toString() } : undefined,
                };
                
                opts.writer.write(outPath, e);
                healthStats.onchainEvents++;
                healthStats.lastEventTime = Date.now();
            } catch (e: any) {
                console.warn(`⚠️  OrderFilled event processing error:`, e.message);
            }
        });
    }

    if (opts.mode === 'pending') {
        let pendingCount = 0;
        provider.on('pending', async (txHash: string) => {
            try {
                pendingCount++;
                if (pendingCount % 1000 === 0) {
                    console.log(`⛓️  On-chain: scanned ${pendingCount} pending txs (looking for ${opts.user})`);
                }
                const tx = await provider.getTransaction(txHash);
                if (!tx) return;
                if (typeof tx.from !== 'string') return;
                const fromLower = tx.from.toLowerCase();
                const toLower = typeof tx.to === 'string' ? tx.to.toLowerCase() : null;
                // Check both FROM (direct trades) and TO (proxy wallet pattern)
                if (fromLower !== userLower && toLower !== userLower) return;
                console.log(`✅ On-chain tx detected: ${txHash} (from=${fromLower}, to=${toLower || 'null'})`);
                emitTx(tx, Date.now(), undefined);
            } catch (e: any) {
                if (e?.message && !e.message.includes('timeout')) {
                    console.warn(`⚠️  On-chain pending tx error:`, e.message);
                }
            }
        });
    } else {
        if (wsUrl) {
            let blockCount = 0;
            provider.on('block', async (blockNumber: number) => {
                try {
                    blockCount++;
                    if (blockCount % 100 === 0) {
                        console.log(`⛓️  On-chain: scanned ${blockCount} blocks (looking for ${opts.user})`);
                    }
                    const block = await provider.getBlockWithTransactions(blockNumber);
                    const eventAtMs = typeof block?.timestamp === 'number' ? block.timestamp * 1000 : Date.now();
                    for (const tx of block.transactions || []) {
                        if (!tx || typeof (tx as any).from !== 'string') continue;
                        const fromLower = (tx as any).from.toLowerCase();
                        const toLower = typeof (tx as any).to === 'string' ? (tx as any).to.toLowerCase() : null;
                        // Check both FROM (direct trades) and TO (proxy wallet pattern)
                        if (fromLower !== userLower && toLower !== userLower) continue;
                        console.log(`✅ On-chain tx detected in block ${blockNumber}: ${(tx as any).hash} (from=${fromLower}, to=${toLower || 'null'})`);
                        emitTx(tx, eventAtMs, blockNumber);
                    }
                } catch (e: any) {
                    if (e?.message && !e.message.includes('timeout')) {
                        console.warn(`⚠️  On-chain block error:`, e.message);
                    }
                }
            });
        } else {
            // HTTP provider: poll blocks (still on-chain, but not mempool-level).
            let last = await provider.getBlockNumber().catch(() => 0);
            const pollMs = Math.max(500, Number(process.env.ONCHAIN_POLL_MS || '1000'));
            let blockCount = 0;
            const timer = setInterval(async () => {
                if (!shouldRun) {
                    clearInterval(timer);
                    return;
                }
                try {
                    const bn = await provider.getBlockNumber();
                    if (bn <= last) return;
                    blockCount += bn - last;
                    if (blockCount % 100 === 0) {
                        console.log(`⛓️  On-chain: scanned ${blockCount} blocks (looking for ${opts.user})`);
                    }
                    for (let b = last + 1; b <= bn; b++) {
                        const block = await provider.getBlockWithTransactions(b);
                        const eventAtMs = typeof block?.timestamp === 'number' ? block.timestamp * 1000 : Date.now();
                        for (const tx of block.transactions || []) {
                            if (!tx || typeof (tx as any).from !== 'string') continue;
                            const fromLower = (tx as any).from.toLowerCase();
                            const toLower = typeof (tx as any).to === 'string' ? (tx as any).to.toLowerCase() : null;
                            // Check both FROM (direct trades) and TO (proxy wallet pattern)
                            if (fromLower !== userLower && toLower !== userLower) continue;
                            console.log(`✅ On-chain tx detected in block ${b}: ${(tx as any).hash} (from=${fromLower}, to=${toLower || 'null'})`);
                            emitTx(tx, eventAtMs, b);
                        }
                    }
                    last = bn;
                } catch (e: any) {
                    if (e?.message && !e.message.includes('timeout')) {
                        console.warn(`⚠️  On-chain poll error:`, e.message);
                    }
                }
            }, pollMs);
        }
    }
};

const jsonlPathFor = (outDir: string, user: string, slugId: string, stream: 'user' | 'market') => {
    const userDir = path.join(outDir, sanitizeFileComponent(user));
    const slugDir = path.join(userDir, 'by_slug', sanitizeFileComponent(slugId));
    return path.join(slugDir, `${stream}.jsonl`);
};

const eventsJsonlPathFor = (outDir: string, user: string, slugId: string) => {
    const userDir = path.join(outDir, sanitizeFileComponent(user));
    const slugDir = path.join(userDir, 'by_slug', sanitizeFileComponent(slugId));
    return path.join(slugDir, `events.jsonl`);
};

const getWsAuthFromEnv = (): WsAuth | null => {
    // Support multiple common env var names to avoid friction.
    const apiKey =
        process.env.CLOB_API_KEY ||
        process.env.CLOB_KEY ||
        process.env.API_KEY ||
        process.env.POLY_CLOB_API_KEY ||
        process.env.POLYMARKET_API_KEY;
    const secret =
        process.env.CLOB_API_SECRET ||
        process.env.CLOB_SECRET ||
        process.env.API_SECRET ||
        process.env.POLY_CLOB_API_SECRET ||
        process.env.POLYMARKET_API_SECRET;
    const passphrase =
        process.env.CLOB_API_PASSPHRASE ||
        process.env.CLOB_PASSPHRASE ||
        process.env.API_PASSPHRASE ||
        process.env.POLY_CLOB_API_PASSPHRASE ||
        process.env.POLYMARKET_API_PASSPHRASE;
    if (!apiKey || !secret || !passphrase) return null;
    return { apiKey: apiKey.trim(), secret: secret.trim(), passphrase: passphrase.trim() };
};

const deriveWsAuthFromPrivateKey = async (): Promise<WsAuth | null> => {
    const pk = process.env.PRIVATE_KEY;
    const host = process.env.CLOB_HTTP_URL || 'https://clob.polymarket.com/';
    if (!pk) return null;
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { ClobClient } = require('@polymarket/clob-client');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { Wallet } = require('@ethersproject/wallet');
        const chainId = 137;
        const signer = new Wallet(pk.startsWith('0x') ? pk : `0x${pk}`);
        const tmp = new ClobClient(host, chainId, signer);
        const creds = await tmp.createOrDeriveApiKey();
        if (!creds?.key || !creds?.secret || !creds?.passphrase) return null;
        return { apiKey: String(creds.key).trim(), secret: String(creds.secret).trim(), passphrase: String(creds.passphrase).trim() };
    } catch {
        return null;
    }
};

const connectUserWs = async (opts: {
    user: string;
    outDir: string;
    slugPrefix?: string;
    pretty: boolean;
    raw: boolean;
    writer: JsonlWriter;
    unified?: boolean;
    onMarketDiscovered?: (market: { conditionId: string; slugId: string }) => void;
    deriveCreds?: boolean;
}) => {
    const wsBase = (process.env.CLOB_WS_BASE || 'wss://ws-subscriptions-clob.polymarket.com').replace(
        /\/+$/,
        ''
    );
    const wsUrl = `${wsBase}/ws/user`;
    const auth = opts.deriveCreds ? await deriveWsAuthFromPrivateKey() : getWsAuthFromEnv();
    if (!auth) {
        throw new Error(
            'Missing websocket credentials. Set CLOB_API_KEY/CLOB_API_SECRET/CLOB_API_PASSPHRASE in .env, or pass --derive-creds with PRIVATE_KEY set.'
        );
    }

    const state = await loadState(opts.outDir, opts.user);
    const conditionIdToSlug = new Map<string, string>();

    // Reconnection state
    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY_MS = 30000;
    const BASE_RECONNECT_DELAY_MS = 1000;

    const fetchConditionIdsForSlugPrefix = async (slugPrefix: string): Promise<string[]> => {
        try {
            // Special case: recurring time-bucket markets like `btc-updown-15m-<bucketStartUnix>`.
            // Gamma doesn't provide prefix search reliably, so we compute likely active slugs.
            const is15mSeries = /-15m$/.test(slugPrefix);
            const candidateSlugs: string[] = [];
            if (is15mSeries) {
                const nowSec = Math.floor(Date.now() / 1000);
                const bucket = Math.floor(nowSec / 900) * 900;
                for (const t of [bucket - 900, bucket, bucket + 900]) {
                    candidateSlugs.push(`${slugPrefix}-${t}`);
                }
            }

            const ids: string[] = [];
            for (const slug of candidateSlugs) {
                const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(
                    slug
                )}`;
                const j = await fetchJson<any>(url, 15000);
                if (Array.isArray(j) && j[0] && typeof j[0].conditionId === 'string') {
                    ids.push(j[0].conditionId);
                }
            }
            return Array.from(new Set(ids)).slice(0, 50);
        } catch {
            return [];
        }
    };

    const connect = () => {
        if (!shouldRun) return;

        // Prefer the `ws` package so we can set headers (some endpoints may require Origin).
        let ws: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const WsLib = require('ws');
            ws = new WsLib(wsUrl, {
                headers: {
                    Origin: 'https://polymarket.com',
                    'User-Agent': 'Mozilla/5.0',
                },
            });
        } catch {
            const WSImpl: any = (globalThis as any).WebSocket;
            if (!WSImpl) {
                throw new Error(
                    'WebSocket is not available in this Node runtime and `ws` package could not be loaded.'
                );
            }
            ws = new WSImpl(wsUrl);
        }

        let pingTimer: NodeJS.Timeout | null = null;

        const on = (event: string, handler: (...args: any[]) => void) => {
            if (typeof ws.addEventListener === 'function') ws.addEventListener(event, handler);
            else ws.on(event, handler);
        };

        on('open', async () => {
            // Reset reconnect attempts on successful connection
            reconnectAttempts = 0;

            const envMarketsRaw = process.env.WS_USER_MARKETS || process.env.CLOB_WSS_USER_MARKETS;
            const envMarkets =
                typeof envMarketsRaw === 'string'
                    ? envMarketsRaw
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean)
                    : [];
            const markets =
                envMarkets.length > 0
                    ? envMarkets
                    : opts.slugPrefix
                      ? await fetchConditionIdsForSlugPrefix(opts.slugPrefix)
                      : [];

            // Docs: upon opening, send auth + intent info.
            // type: "user", markets: string[] condition IDs (optional), auth: {apiKey, secret, passphrase}
            const subscribePayload = {
                type: 'user',
                markets, // many servers require this to be non-empty; we filter further client-side
                // Docs / quickstarts differ on `apiKey` vs `apikey`. Send both.
                auth: {
                    apiKey: auth.apiKey,
                    apikey: auth.apiKey,
                    secret: auth.secret,
                    passphrase: auth.passphrase,
                },
            };
            ws.send(JSON.stringify(subscribePayload));

            // Keepalive per quickstart docs
            pingTimer = setInterval(() => {
                try {
                    ws.send('PING');
                } catch {
                    // ignore
                }
            }, 10_000);

            console.log(`🔌 User WS connected: ${wsUrl}`);
            console.log('✅ Subscribed to user channel (streaming realtime; no polling)\n');
        });

        on('message', async (evt: any) => {
            const seenAtMs = Date.now();
            const seenAt = new Date(seenAtMs).toISOString();
            let msg: any;
            try {
                const data = typeof evt?.data === 'string' ? evt.data : evt?.data?.toString?.() ?? evt;
                msg = JSON.parse(typeof data === 'string' ? data : String(data));
            } catch {
                // non-json message; ignore
                return;
            }

            // Some auth errors arrive as JSON before the socket closes; surface them.
            if (
                typeof msg?.error === 'string' ||
                typeof msg?.message === 'string' ||
                msg?.event_type === 'error' ||
                msg?.type === 'error'
            ) {
                const summary = {
                    error: msg?.error,
                    message: msg?.message,
                    code: msg?.code,
                    type: msg?.type || msg?.event_type,
                };
                console.error('⚠️  User WS message indicates error:', summary);
            }

            const conditionId = extractConditionId(msg);
            const eventType = extractEventType(msg);
            const eventTimeMs = parseEventTimeMs(msg);
            const eventTime = typeof eventTimeMs === 'number' ? new Date(eventTimeMs).toISOString() : undefined;

            let slugId: string | undefined =
                (typeof msg?.slug === 'string' ? msg.slug : undefined) ||
                (typeof msg?.market_slug === 'string' ? msg.market_slug : undefined) ||
                (typeof msg?.marketSlug === 'string' ? msg.marketSlug : undefined);

            if (!slugId && conditionId) {
                slugId = await fetchSlugForConditionId(conditionId, conditionIdToSlug);
            }

            if (opts.slugPrefix && slugId && !slugId.startsWith(opts.slugPrefix)) {
                return;
            }

            if (conditionId && slugId) {
                opts.onMarketDiscovered?.({ conditionId, slugId });
            }

            // Build a stable dedup key
            const idLike =
                msg?.id ||
                msg?.trade_id ||
                msg?.tradeId ||
                msg?.order_id ||
                msg?.orderId ||
                msg?.tx_hash ||
                msg?.transactionHash ||
                msg?.data?.id ||
                msg?.data?.trade_id ||
                msg?.data?.tradeId ||
                msg?.data?.order_id ||
                msg?.data?.orderId ||
                msg?.data?.tx_hash ||
                msg?.data?.transactionHash;
            const dedupKey =
                typeof idLike === 'string'
                    ? `id:${idLike}`
                    : `t:${eventTimeMs ?? seenAtMs}|c:${conditionId ?? 'na'}|type:${eventType ?? 'na'}|h:${JSON.stringify(
                          msg
                      ).slice(0, 300)}`;

            const record: WsEventRecord = {
                seenAtMs,
                seenAt,
                eventTimeMs,
                eventTime,
                conditionId,
                slugId,
                eventType,
                dedupKey,
                data: opts.raw ? msg : { ...msg, auth: undefined },
            };

            // in-memory dedupe for runtime
            if (state.seenTxSet[dedupKey]) return;
            state.seenTxSet[dedupKey] = true;
            state.seenTxOrder.push(dedupKey);
            if (state.seenTxOrder.length > MAX_SEEN_TX) {
                const removeCount = state.seenTxOrder.length - MAX_SEEN_TX;
                const removed = state.seenTxOrder.splice(0, removeCount);
                for (const k of removed) delete state.seenTxSet[k];
            }
            await saveState(opts.outDir, opts.user, state);

            const slugOut = slugId || conditionId || 'unknown';
            const unified = toUnified('user_ws', record);
            opts.writer.write(
                opts.unified ? eventsJsonlPathFor(opts.outDir, opts.user, slugOut) : jsonlPathFor(opts.outDir, opts.user, slugOut, 'user'),
                unified
            );
            healthStats.userWsEvents++;
            healthStats.lastEventTime = Date.now();
            if (opts.pretty) console.log(JSON.stringify(unified, null, 2));
        });

        on('error', (e: any) => {
            console.error('❌ User WS error:', e?.message || e);
            // If error occurs and connection is not already closing, force close to trigger reconnection
            if (ws && ws.readyState !== ws.CLOSING && ws.readyState !== ws.CLOSED) {
                try {
                    ws.close();
                } catch {
                    // Ignore errors during close
                }
            }
        });

        on('close', (evt: any, evt2: any) => {
            // Clear ping timer
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }

            // ws lib: (code, reason) OR browser: (CloseEvent)
            const code = typeof evt === 'number' ? evt : typeof evt?.code === 'number' ? evt.code : undefined;
            const reasonRaw =
                typeof evt2 === 'string'
                    ? evt2
                    : evt2?.toString?.()
                      ? evt2.toString()
                      : typeof evt?.reason === 'string'
                        ? evt.reason
                        : undefined;
            const reason = reasonRaw ? String(reasonRaw) : undefined;
            console.log(
                `🔌 User WS closed${typeof code === 'number' ? ` (code=${code})` : ''}${reason ? ` reason=${reason}` : ''}`
            );

            // Schedule reconnection with exponential backoff
            if (shouldRun) {
                reconnectAttempts++;
                healthStats.wsReconnects++;
                const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1));
                console.log(`🔄 User WS reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
                setTimeout(() => connect(), delay);
            }
        });
    };

    // Start initial connection
    connect();
};

const fetchMarketMetaForConditionId = async (conditionId: string): Promise<{
    conditionId: string;
    slugId: string;
    clobTokenIds: string[];
    outcomes?: string[];
} | null> => {
    try {
        const url = `https://gamma-api.polymarket.com/markets?limit=1&condition_ids=${encodeURIComponent(
            conditionId
        )}`;
        const j = await fetchJson<any>(url, 15000);
        if (!Array.isArray(j) || !j[0]) return null;
        const m = j[0];
        const slugId = typeof m.slug === 'string' ? m.slug : conditionId;
        const clobTokenIds = normalizeStringArray(m.clobTokenIds);
        const outcomes = Array.isArray(m.outcomes) ? m.outcomes : undefined;
        return { conditionId, slugId, clobTokenIds, outcomes };
    } catch {
        return null;
    }
};

const connectMarketWs = async (opts: {
    user: string;
    outDir: string;
    slugPrefix?: string;
    pretty: boolean;
    raw: boolean;
    writer: JsonlWriter;
    unified?: boolean;
    compact?: boolean;
}): Promise<{ subscribeToAssetIds: (assetIds: string[]) => void }> => {
    const wsBase = (process.env.CLOB_WS_BASE || 'wss://ws-subscriptions-clob.polymarket.com').replace(
        /\/+$/,
        ''
    );
    const wsUrl = `${wsBase}/ws/market`;
    // In unified mode, avoid writing to the shared REST `_state.json` to prevent contention.
    // Market WS can be high-volume; we keep an in-memory dedup to avoid obvious duplicates within a run.
    const state = opts.unified ? null : await loadState(opts.outDir, opts.user);
    const wsSeen = new Set<string>();
    const wsSeenOrder: string[] = [];

    // Reconnection state
    let reconnectAttempts = 0;
    const MAX_RECONNECT_DELAY_MS = 30000;
    const BASE_RECONNECT_DELAY_MS = 1000;

    // Shared state that persists across reconnections
    const subscribed = new Set<string>();
    const marketToSlug = new Map<string, string>(); // conditionId -> slugId
    const slugToTokenOutcome = new Map<string, Record<string, string>>();
    let currentWs: any = null;

    const loadTokenOutcomeMap = (slugId: string): Record<string, string> | undefined => {
        const cached = slugToTokenOutcome.get(slugId);
        if (cached) return cached;
        try {
            const metaPath = path.join(
                opts.outDir,
                sanitizeFileComponent(opts.user),
                'by_slug',
                sanitizeFileComponent(slugId),
                'meta.json'
            );
            if (!fs.existsSync(metaPath)) return undefined;
            const raw = fs.readFileSync(metaPath, 'utf8');
            const j = JSON.parse(raw);
            const tokenIds = normalizeStringArray(j?.clobTokenIds);
            const outcomes = normalizeStringArray(j?.outcomes);
            if (tokenIds.length > 0 && outcomes.length === tokenIds.length) {
                const m: Record<string, string> = {};
                for (let i = 0; i < tokenIds.length; i++) m[tokenIds[i]] = outcomes[i];
                slugToTokenOutcome.set(slugId, m);
                return m;
            }
        } catch {
            // ignore
        }
        return undefined;
    };

    const doSubscribe = (assetIds: string[]) => {
        const toAdd = assetIds.filter((id) => id && !subscribed.has(id));
        if (toAdd.length === 0) return;
        for (const id of toAdd) subscribed.add(id);
        if (!currentWs) return;
        try {
            // docs: subscribe more assets via operation=subscribe
            currentWs.send(JSON.stringify({ assets_ids: toAdd, operation: 'subscribe' }));
        } catch {
            // ignore
        }
    };

    const connect = () => {
        if (!shouldRun) return;

        let WsLib: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            WsLib = require('ws');
        } catch {
            WsLib = (globalThis as any).WebSocket;
        }
        if (!WsLib) throw new Error('WebSocket is not available in this Node runtime.');

        const ws = new WsLib(wsUrl);
        currentWs = ws;
        let pingTimer: NodeJS.Timeout | null = null;
        let lastPongTime = Date.now();
        const PONG_TIMEOUT_MS = 30000; // If no pong in 30s, consider connection dead

        ws.addEventListener('open', () => {
            // Reset reconnect attempts on successful connection
            reconnectAttempts = 0;

            ws.send(JSON.stringify({ assets_ids: [], type: 'market' }));
            lastPongTime = Date.now();
            pingTimer = setInterval(() => {
                try {
                    // Check if we've received a pong recently
                    const timeSinceLastPong = Date.now() - lastPongTime;
                    if (timeSinceLastPong > PONG_TIMEOUT_MS) {
                        console.warn(`⚠️ Market WS: No pong received in ${Math.round(timeSinceLastPong / 1000)}s, forcing reconnect...`);
                        ws.close();
                        return;
                    }
                    ws.send('PING');
                } catch {
                    // ignore
                }
            }, 10_000);
            console.log(`🔌 Market WS connected: ${wsUrl}`);

            // Re-subscribe to previously subscribed assets after reconnection
            if (subscribed.size > 0) {
                const assetIds = Array.from(subscribed);
                try {
                    ws.send(JSON.stringify({ assets_ids: assetIds, operation: 'subscribe' }));
                    console.log(`🔄 Re-subscribed to ${assetIds.length} assets after reconnection`);
                } catch {
                    // ignore
                }
            }

            // Seed subscriptions from Gamma if a slug prefix is provided.
            (async () => {
                if (!opts.slugPrefix) return;
                try {
                    const is15mSeries = /-15m$/.test(opts.slugPrefix);
                    const candidateSlugs: string[] = [];
                    if (is15mSeries) {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const bucket = Math.floor(nowSec / 900) * 900;
                        for (const t of [bucket - 900, bucket, bucket + 900]) {
                            candidateSlugs.push(`${opts.slugPrefix}-${t}`);
                        }
                    } else {
                        // Fallback: try exact slug
                        candidateSlugs.push(opts.slugPrefix);
                    }
                    console.log(`🧭 Market seed slugs: ${candidateSlugs.join(', ')}`);

                    for (const slug of candidateSlugs) {
                        const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(
                            slug
                        )}`;
                        const j = await fetchJson<any>(url, 15000);
                        const m = Array.isArray(j) ? j[0] : null;
                        const clobTokenIds = normalizeStringArray(m?.clobTokenIds);
                        if (!m?.conditionId || clobTokenIds.length === 0) {
                            const debug = {
                                hasMarket: !!m,
                                conditionIdType: typeof m?.conditionId,
                                hasClobTokenIds: m ? 'clobTokenIds' in m : false,
                                clobTokenIdsType: typeof m?.clobTokenIds,
                                clobTokenIdsIsArray: Array.isArray(m?.clobTokenIds),
                            };
                            console.warn(`⚠️  Seed slug not found or missing token ids: ${slug}`, debug);
                            continue;
                        }
                        const meta = {
                            conditionId: m.conditionId,
                            slugId: m.slug,
                            clobTokenIds,
                            outcomes: normalizeStringArray(m.outcomes),
                        };
                        const metaPath = path.join(
                            opts.outDir,
                            sanitizeFileComponent(opts.user),
                            'by_slug',
                            sanitizeFileComponent(m.slug),
                            'meta.json'
                        );
                        ensureDirForFile(metaPath);
                        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
                        doSubscribe(clobTokenIds);
                        console.log(`✅ Seeded market ${m.slug} (${m.conditionId})`);
                    }
                } catch (e) {
                    console.error('❌ Market seeding failed:', e);
                }
            })();
        });

        ws.addEventListener('message', async (evt: any) => {
            // Update last pong time on any message (PONG responses or data messages indicate connection is alive)
            lastPongTime = Date.now();
            
            const seenAtMs = Date.now();
            const seenAt = new Date(seenAtMs).toISOString();
            let msg: any;
            try {
                msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
            } catch {
                return;
            }

            const conditionId = extractConditionId(msg);
            const eventType = extractEventType(msg);
            const eventTimeMs = parseEventTimeMs(msg);
            const eventTime = typeof eventTimeMs === 'number' ? new Date(eventTimeMs).toISOString() : undefined;

            let slugId: string | undefined =
                (typeof msg?.slug === 'string' ? msg.slug : undefined) ||
                (typeof msg?.market_slug === 'string' ? msg.market_slug : undefined);

            if (!slugId && conditionId) slugId = marketToSlug.get(conditionId);

            // If still unknown, resolve via gamma (cheap + cached).
            if (!slugId && conditionId) {
                const meta = await fetchMarketMetaForConditionId(conditionId);
                if (meta) {
                    marketToSlug.set(meta.conditionId, meta.slugId);
                    slugId = meta.slugId;
                    // subscribe to both outcome token IDs to get book updates
                    doSubscribe(meta.clobTokenIds);
                    // write meta.json for analysis
                    const metaPath = path.join(
                        opts.outDir,
                        sanitizeFileComponent(opts.user),
                        'by_slug',
                        sanitizeFileComponent(meta.slugId),
                        'meta.json'
                    );
                    ensureDirForFile(metaPath);
                    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
                }
            }

            const assetId =
                (typeof msg?.asset_id === 'string' ? msg.asset_id : undefined) ||
                (typeof msg?.assetId === 'string' ? msg.assetId : undefined);

            const dedupKey =
                typeof msg?.hash === 'string'
                    ? `hash:${msg.hash}|t:${eventTimeMs ?? seenAtMs}|a:${assetId ?? 'na'}|e:${eventType ?? 'na'}`
                    : `t:${eventTimeMs ?? seenAtMs}|a:${assetId ?? 'na'}|e:${eventType ?? 'na'}|h:${JSON.stringify(msg).slice(
                          0,
                          200
                      )}`;

            const record: WsEventRecord = {
                seenAtMs,
                seenAt,
                eventTimeMs,
                eventTime,
                conditionId,
                slugId,
                eventType,
                dedupKey,
                data: opts.raw ? msg : msg,
            };

            if (state) {
                if (state.seenTxSet[dedupKey]) return;
                state.seenTxSet[dedupKey] = true;
                state.seenTxOrder.push(dedupKey);
                if (state.seenTxOrder.length > MAX_SEEN_TX) {
                    const removeCount = state.seenTxOrder.length - MAX_SEEN_TX;
                    const removed = state.seenTxOrder.splice(0, removeCount);
                    for (const k of removed) delete state.seenTxSet[k];
                }
                saveState(opts.outDir, opts.user, state);
            } else {
                if (wsSeen.has(dedupKey)) return;
                wsSeen.add(dedupKey);
                wsSeenOrder.push(dedupKey);
                if (wsSeenOrder.length > MAX_SEEN_TX) {
                    const removeCount = wsSeenOrder.length - MAX_SEEN_TX;
                    const removed = wsSeenOrder.splice(0, removeCount);
                    for (const k of removed) wsSeen.delete(k);
                }
            }

            const slugOut = slugId || conditionId || 'unknown';
            const unified = toUnified('market_ws', record);
            const tokenToOutcome = slugId ? loadTokenOutcomeMap(slugId) : undefined;
            const mlEvents = toMlEvents(unified, { compact: opts.compact !== false, raw: opts.raw, tokenToOutcome });
            const outPath = opts.unified
                ? eventsJsonlPathFor(opts.outDir, opts.user, slugOut)
                : jsonlPathFor(opts.outDir, opts.user, slugOut, 'market');
            for (const e of mlEvents) opts.writer.write(outPath, e);
            healthStats.marketWsEvents += mlEvents.length;
            healthStats.lastEventTime = Date.now();
            if (opts.pretty) {
                for (const e of mlEvents) console.log(JSON.stringify(e, null, 2));
            }
        });

        ws.addEventListener('error', (e: any) => {
            console.error('❌ Market WS error:', e?.message || e);
            // If error occurs and connection is not already closing, force close to trigger reconnection
            if (ws && ws.readyState !== ws.CLOSING && ws.readyState !== ws.CLOSED) {
                try {
                    ws.close();
                } catch {
                    // Ignore errors during close
                }
            }
        });

        ws.addEventListener('close', () => {
            // Clear ping timer
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            currentWs = null;

            console.log('🔌 Market WS closed');

=======

        const ws = new WsLib(wsUrl);
        currentWs = ws;
        let pingTimer: NodeJS.Timeout | null = null;
        let lastPongTime = Date.now();
        const PONG_TIMEOUT_MS = 30000; // If no pong in 30s, consider connection dead

        ws.addEventListener('open', () => {
            // Reset reconnect attempts on successful connection
            reconnectAttempts = 0;

            ws.send(JSON.stringify({ assets_ids: [], type: 'market' }));
            lastPongTime = Date.now();
            pingTimer = setInterval(() => {
                try {
                    // Check if we've received a pong recently
                    const timeSinceLastPong = Date.now() - lastPongTime;
                    if (timeSinceLastPong > PONG_TIMEOUT_MS) {
                        console.warn(`⚠️ Market WS: No pong received in ${Math.round(timeSinceLastPong / 1000)}s, forcing reconnect...`);
                        ws.close();
                        return;
                    }
                    ws.send('PING');
                } catch {
                    // ignore
                }
            }, 10_000);
            console.log(`🔌 Market WS connected: ${wsUrl}`);

            // Re-subscribe to previously subscribed assets after reconnection
            if (subscribed.size > 0) {
                const assetIds = Array.from(subscribed);
                try {
                    ws.send(JSON.stringify({ assets_ids: assetIds, operation: 'subscribe' }));
                    console.log(`🔄 Re-subscribed to ${assetIds.length} assets after reconnection`);
                } catch {
                    // ignore
                }
            }

            // Seed subscriptions from Gamma if a slug prefix is provided.
            // This runs asynchronously and failures are non-blocking
            (async () => {
                if (!opts.slugPrefix) return;
                try {
                    const is15mSeries = /-15m$/.test(opts.slugPrefix);
                    const candidateSlugs: string[] = [];
                    if (is15mSeries) {
                        const nowSec = Math.floor(Date.now() / 1000);
                        const bucket = Math.floor(nowSec / 900) * 900;
                        for (const t of [bucket - 900, bucket, bucket + 900]) {
                            candidateSlugs.push(`${opts.slugPrefix}-${t}`);
                        }
                    } else {
                        // Fallback: try exact slug
                        candidateSlugs.push(opts.slugPrefix);
                    }
                    console.log(`🧭 Market seed slugs: ${candidateSlugs.join(', ')}`);

                    // Process slugs with individual error handling and shorter timeout
                    let successCount = 0;
                    for (const slug of candidateSlugs) {
                        try {
                            const url = `https://gamma-api.polymarket.com/markets?limit=1&slug=${encodeURIComponent(
                                slug
                            )}`;
                            // Use shorter timeout (5s) to avoid long waits
                            const j = await fetchJson<any>(url, 5000);
                            
                            const m = Array.isArray(j) ? j[0] : null;
                            const clobTokenIds = normalizeStringArray(m?.clobTokenIds);
                            if (!m?.conditionId || clobTokenIds.length === 0) {
                                continue; // Skip silently if market not found
                            }
                            const meta = {
                                conditionId: m.conditionId,
                                slugId: m.slug,
                                clobTokenIds,
                                outcomes: normalizeStringArray(m.outcomes),
                            };
                            // Save to R2 instead of local file
                            await saveMetaToR2(opts.user, m.slug, meta);
                            doSubscribe(clobTokenIds);
                            console.log(`✅ Seeded market ${m.slug} (${m.conditionId})`);
                            successCount++;
                        } catch (slugError: any) {
                            // Silently skip individual slug failures (timeout, not found, etc.)
                            // This is expected for future slugs that don't exist yet
                            continue;
                        }
                    }
                    
                    if (successCount === 0 && candidateSlugs.length > 0) {
                        console.warn(`⚠️  Market seeding: No markets found for ${candidateSlugs.length} candidate slug(s). This is normal if markets haven't started yet.`);
                    }
                } catch (e: any) {
                    // Non-blocking: log warning but don't fail the WebSocket connection
                    console.warn(`⚠️  Market seeding error (non-blocking): ${e.message || e}`);
                }
            })();
        });

        ws.addEventListener('message', async (evt: any) => {
            // Update last pong time on any message (PONG responses or data messages indicate connection is alive)
            lastPongTime = Date.now();
            
            const seenAtMs = Date.now();
            const seenAt = new Date(seenAtMs).toISOString();
            let msg: any;
            try {
                msg = JSON.parse(typeof evt.data === 'string' ? evt.data : String(evt.data));
            } catch {
                return;
            }

            const conditionId = extractConditionId(msg);
            const eventType = extractEventType(msg);
            const eventTimeMs = parseEventTimeMs(msg);
            const eventTime = typeof eventTimeMs === 'number' ? new Date(eventTimeMs).toISOString() : undefined;

            let slugId: string | undefined =
                (typeof msg?.slug === 'string' ? msg.slug : undefined) ||
                (typeof msg?.market_slug === 'string' ? msg.market_slug : undefined);

            if (!slugId && conditionId) slugId = marketToSlug.get(conditionId);

            // If still unknown, resolve via gamma (cheap + cached).
            if (!slugId && conditionId) {
                const meta = await fetchMarketMetaForConditionId(conditionId);
                if (meta) {
                    marketToSlug.set(meta.conditionId, meta.slugId);
                    slugId = meta.slugId;
                    // subscribe to both outcome token IDs to get book updates
                    doSubscribe(meta.clobTokenIds);
                    // Save meta.json to R2
                    await saveMetaToR2(opts.user, meta.slugId, meta);
                }
            }

            const assetId =
                (typeof msg?.asset_id === 'string' ? msg.asset_id : undefined) ||
                (typeof msg?.assetId === 'string' ? msg.assetId : undefined);

            const dedupKey =
                typeof msg?.hash === 'string'
                    ? `hash:${msg.hash}|t:${eventTimeMs ?? seenAtMs}|a:${assetId ?? 'na'}|e:${eventType ?? 'na'}`
                    : `t:${eventTimeMs ?? seenAtMs}|a:${assetId ?? 'na'}|e:${eventType ?? 'na'}|h:${JSON.stringify(msg).slice(
                          0,
                          200
                      )}`;

            const record: WsEventRecord = {
                seenAtMs,
                seenAt,
                eventTimeMs,
                eventTime,
                conditionId,
                slugId,
                eventType,
                dedupKey,
                data: opts.raw ? msg : msg,
            };

            if (state) {
                if (state.seenTxSet[dedupKey]) return;
                state.seenTxSet[dedupKey] = true;
                state.seenTxOrder.push(dedupKey);
                if (state.seenTxOrder.length > MAX_SEEN_TX) {
                    const removeCount = state.seenTxOrder.length - MAX_SEEN_TX;
                    const removed = state.seenTxOrder.splice(0, removeCount);
                    for (const k of removed) delete state.seenTxSet[k];
                }
                await saveState(opts.outDir, opts.user, state);
            } else {
                if (wsSeen.has(dedupKey)) return;
                wsSeen.add(dedupKey);
                wsSeenOrder.push(dedupKey);
                if (wsSeenOrder.length > MAX_SEEN_TX) {
                    const removeCount = wsSeenOrder.length - MAX_SEEN_TX;
                    const removed = wsSeenOrder.splice(0, removeCount);
                    for (const k of removed) wsSeen.delete(k);
                }
            }

            const slugOut = slugId || conditionId || 'unknown';
            const unified = toUnified('market_ws', record);
            const tokenToOutcome = slugId ? loadTokenOutcomeMap(slugId) : undefined;
            const mlEvents = toMlEvents(unified, { compact: opts.compact !== false, raw: opts.raw, tokenToOutcome });
            const outPath = opts.unified
                ? eventsJsonlPathFor(opts.outDir, opts.user, slugOut)
                : jsonlPathFor(opts.outDir, opts.user, slugOut, 'market');
            for (const e of mlEvents) opts.writer.write(outPath, e);
            healthStats.marketWsEvents += mlEvents.length;
            healthStats.lastEventTime = Date.now();
            if (opts.pretty) {
                for (const e of mlEvents) console.log(JSON.stringify(e, null, 2));
            }
        });

        ws.addEventListener('error', (e: any) => {
            console.error('❌ Market WS error:', e?.message || e);
            // If error occurs and connection is not already closing, force close to trigger reconnection
            if (ws && ws.readyState !== ws.CLOSING && ws.readyState !== ws.CLOSED) {
                try {
                    ws.close();
                } catch {
                    // Ignore errors during close
                }
            }
        });

        ws.addEventListener('close', () => {
            // Clear ping timer
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            currentWs = null;

            console.log('🔌 Market WS closed');

            // Schedule reconnection with exponential backoff
            if (shouldRun) {
                reconnectAttempts++;
                healthStats.wsReconnects++;
                const delay = Math.min(MAX_RECONNECT_DELAY_MS, BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts - 1));
                console.log(`🔄 Market WS reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);
                setTimeout(() => connect(), delay);
            }
        });
    };

    // Start initial connection
    connect();

    return { subscribeToAssetIds: doSubscribe };
};

const upsertTrades = (
    outDir: string,
    user: string,
    state: PersistedState,
    trades: ActivityTrade[],
    slugPrefix?: string,
    prettyConsole?: boolean
) => {
    const userDir = path.join(outDir, sanitizeFileComponent(user));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    const seenAtMs = Date.now();

    const grouped = new Map<string, ActivityTrade[]>(); // slugId -> trades
    for (const t of trades) {
        const slugId = slugKey(t);
        if (!shouldIncludeSlug(slugId, slugPrefix)) continue;
        const groupKey = groupKeyFor(slugId, slugPrefix);
        if (!grouped.has(groupKey)) grouped.set(groupKey, []);
        grouped.get(groupKey)!.push(t);
    }

    let upserted = 0;
    const newlyWrittenByGroup: Record<string, any[]> = {};

    for (const [groupKey, groupTrades] of grouped.entries()) {
        const fileName = `${sanitizeFileComponent(groupKey)}.json`;
        const filePath = path.join(userDir, fileName);

        const lastTs = state.lastTimestampByGroup[groupKey] ?? 0;
        const existing = readJsonArraySafe(filePath);

        const existingByKey = new Map<string, any>();
        for (const item of existing) {
            if (item && typeof item === 'object') {
                const id = typeof item.id === 'string' ? item.id : undefined;
                const tx = typeof item.transactionHash === 'string' ? item.transactionHash : undefined;
                const ts = typeof item.timestamp === 'number' ? item.timestamp : undefined;
                if (id) existingByKey.set(`id:${id}`, item);
                else if (tx && typeof ts === 'number') existingByKey.set(`tx:${tx}|ts:${ts}`, item);
            }
        }

        const candidates = groupTrades
            .filter((t) => t.timestamp >= lastTs)
            .filter((t) => !state.seenTxSet[makeDedupKey(t)])
            .sort((a, b) => (a.timestamp - b.timestamp) || a.transactionHash.localeCompare(b.transactionHash));

        if (candidates.length === 0) continue;

        // Dedupe within this single poll batch as well (the API can return duplicates)
        const batchSeen = new Set<string>();
        const uniqueCandidates: ActivityTrade[] = [];
        for (const t of candidates) {
            const key = makeDedupKey(t);
            if (batchSeen.has(key)) continue;
            batchSeen.add(key);
            uniqueCandidates.push(t);
        }

        if (uniqueCandidates.length === 0) continue;

        for (const t of uniqueCandidates) {
            const obj = toLogObject(t, seenAtMs);
            existingByKey.set(makeDedupKey(t), obj);
        }

        const merged = Array.from(existingByKey.values()).sort(
            (a, b) => (Number(a.timestamp) - Number(b.timestamp)) || String(a.transactionHash).localeCompare(String(b.transactionHash))
        );
        writePrettyJsonArray(filePath, merged);

        newlyWrittenByGroup[groupKey] = uniqueCandidates.map((t) => toLogObject(t, seenAtMs));

        upserted += uniqueCandidates.length;
        const maxTs = Math.max(lastTs, ...uniqueCandidates.map((t) => t.timestamp));
        state.lastTimestampByGroup[groupKey] = maxTs;

        for (const t of uniqueCandidates) {
            const key = makeDedupKey(t);
            state.seenTxSet[key] = true;
            state.seenTxOrder.push(key);
        }
    }

    // prune seenTx cache
    if (state.seenTxOrder.length > MAX_SEEN_TX) {
        const removeCount = state.seenTxOrder.length - MAX_SEEN_TX;
        const removed = state.seenTxOrder.splice(0, removeCount);
        for (const tx of removed) delete state.seenTxSet[tx];
    }

    if (prettyConsole && upserted > 0) {
        for (const groupKey of Object.keys(newlyWrittenByGroup).sort()) {
            const items = newlyWrittenByGroup[groupKey].sort(
                (a, b) => (Number(a.timestamp) - Number(b.timestamp)) || String(a.transactionHash).localeCompare(String(b.transactionHash))
            );
            console.log(`\n🧾 New trades for ${groupKey} (${items.length})`);
            console.log(JSON.stringify(items, null, 2));
        }
        console.log('');
    }

    return upserted;
};

const appendRestTradesUnified = (opts: {
    outDir: string;
    user: string;
    state: PersistedState;
    trades: ActivityTrade[];
    slugPrefix?: string;
    prettyConsole?: boolean;
    raw: boolean;
    writer: JsonlWriter;
    compact: boolean;
}) => {
    const seenAtMs = Date.now();
    const seenAt = new Date(seenAtMs).toISOString();

    // Similar filtering + ordering as `upsertTrades`, but we append to `by_slug/<slugId>/events.jsonl`
    // to keep both market_ws and rest_poll in one timeline.
    const candidates = opts.trades
        .filter((t) => shouldIncludeSlug(slugKey(t), opts.slugPrefix))
        .filter((t) => {
            const gk = groupKeyFor(slugKey(t), opts.slugPrefix);
            const lastTs = opts.state.lastTimestampByGroup[gk] ?? 0;
            return t.timestamp >= lastTs;
        })
        .filter((t) => !opts.state.seenTxSet[makeDedupKey(t)])
        .sort((a, b) => (a.timestamp - b.timestamp) || a.transactionHash.localeCompare(b.transactionHash));

    if (candidates.length === 0) return 0;

    const batchSeen = new Set<string>();
    let appended = 0;
    const maxTsByGroup = new Map<string, number>();

    for (const t of candidates) {
        const key = makeDedupKey(t);
        if (batchSeen.has(key)) continue;
        batchSeen.add(key);
        if (opts.state.seenTxSet[key]) continue;

        const slugId = slugKey(t);
        const groupKey = groupKeyFor(slugId, opts.slugPrefix);

        const eventTimeMs = t.timestamp * 1000;
        const eventTime = new Date(eventTimeMs).toISOString();

        const payloadBase = opts.raw ? (t as any) : (toLogObject(t, seenAtMs) as any);
        const payload = { ...payloadBase, assetId: t.asset };

        const record: WsEventRecord = {
            seenAtMs,
            seenAt,
            eventTimeMs,
            eventTime,
            conditionId: t.conditionId,
            slugId,
            eventType: 'trade',
            dedupKey: key,
            data: payload,
        };

        const unified = toUnified('rest_poll', record);
        const mlEvents = toMlEvents(unified, { compact: opts.compact, raw: opts.raw });
        for (const e of mlEvents) {
            // Tag with endpoint source
            (e as any).endpoint = '/activity';
            opts.writer.write(eventsJsonlPathFor(opts.outDir, opts.user, slugId), e);
        }
        healthStats.restPollEvents += mlEvents.length;
        healthStats.lastEventTime = Date.now();

        // update state
        opts.state.seenTxSet[key] = true;
        opts.state.seenTxOrder.push(key);
        maxTsByGroup.set(groupKey, Math.max(maxTsByGroup.get(groupKey) ?? 0, t.timestamp));

        appended++;
        if (opts.prettyConsole) for (const e of mlEvents) console.log(JSON.stringify(e, null, 2));
    }

    for (const [gk, maxTs] of maxTsByGroup.entries()) {
        const prev = opts.state.lastTimestampByGroup[gk] ?? 0;
        opts.state.lastTimestampByGroup[gk] = Math.max(prev, maxTs);
    }

    // prune seenTx cache
    if (opts.state.seenTxOrder.length > MAX_SEEN_TX) {
        const removeCount = opts.state.seenTxOrder.length - MAX_SEEN_TX;
        const removed = opts.state.seenTxOrder.splice(0, removeCount);
        for (const tx of removed) delete opts.state.seenTxSet[tx];
    }

    return appended;
};

const startRestPollingLoop = async (opts: {
    outDir: string;
    user: string;
    intervalSeconds: number;
    limit: number;
    slugPrefix?: string;
    pretty: boolean;
    raw: boolean;
    writer: JsonlWriter;
    unified: boolean;
    compact: boolean;
}) => {
    const resolvedOut = opts.outDir;
    const userDir = path.join(resolvedOut, sanitizeFileComponent(opts.user));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    let state = await loadState(resolvedOut, opts.user);

    console.log(`🧩 REST polling enabled alongside WS (interval=${opts.intervalSeconds}s, limit=${opts.limit})`);

    while (shouldRun) {
        try {
            const trades = await fetchTrades(opts.user, opts.limit);
            const appended = opts.unified
                ? appendRestTradesUnified({
                      outDir: resolvedOut,
                      user: opts.user,
                      state,
                      trades,
                      slugPrefix: opts.slugPrefix,
                      prettyConsole: opts.pretty,
                      raw: opts.raw,
                      writer: opts.writer,
                      compact: opts.compact,
                  })
                : upsertTrades(resolvedOut, opts.user, state, trades, opts.slugPrefix, opts.pretty);
            await saveState(resolvedOut, opts.user, state);

            const now = new Date().toISOString();
            if (appended > 0) console.log(`[${now}] rest +${appended}`);
        } catch (e) {
            console.error('❌ REST polling error:', e);
        }

        await sleep(opts.intervalSeconds * 1000);
    }
};

let shouldRun = true;
let globalWriter: JsonlWriter | null = null;

const installShutdownHandlers = () => {
    const shutdown = async (signal: string) => {
        console.log(`\n🛑 Received ${signal}, stopping...`);
        shouldRun = false;
        
        // Flush writer before exit
        if (globalWriter) {
            console.log('💾 Flushing writer and uploading remaining slugs...');
            await globalWriter.flush().catch(err => {
                console.error(`❌ Error flushing writer: ${err.message}`);
            });
        }
        
        // Give a moment for uploads to complete
        await new Promise(resolve => setTimeout(resolve, 2000));
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
};

const main = async () => {
    const {
        user,
        outDir,
        intervalSeconds,
        limit,
        once,
        slugPrefix,
        pretty,
        mode,
        raw,
        wsMode,
        deriveCreds,
        unified,
        withRest,
        withOnchain,
        onchainMode,
        compact,
    } = parseArgs(process.argv.slice(2));

    if (!user || !isValidEthereumAddress(user)) {
        console.error(
            '\nUsage: npm run store-user-trades -- --user 0xYourAddress [--mode ws|rest] [--ws-mode user|market|dual] [--with-rest] [--with-onchain] [--onchain-mode pending|block] [--unified] [--slug-prefix btc-updown-15m] [--pretty] [--raw] [--out ./dir] [--interval 2] [--limit 100] [--once]\n'
        );
        process.exit(1);
    }

    installShutdownHandlers();

    const resolvedOut = path.resolve(outDir);
    const userDir = path.join(resolvedOut, sanitizeFileComponent(user));
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });

    if (mode === 'ws') {
        console.log(`📡 Tracking trades for ${user}`);
        console.log(`🗂  Output dir: ${userDir}`);
        if (slugPrefix) console.log(`🎯 Filtering slug prefix: ${slugPrefix}`);
        console.log(
            `⚡ Mode: websocket (${wsMode}) (realtime push)${withRest ? ' + REST polling' : ''}${withOnchain ? ' + on-chain' : ''}${
                unified ? ' (unified events.jsonl)' : ''
            }${compact ? ' (compact ML schema)' : ' (full schema)'}\n`
        );
        const writer = new JsonlWriter();
        globalWriter = writer; // Store for shutdown handler
        let marketSubscribeFn: ((assetIds: string[]) => void) | null = null;

        // Start periodic health logging
        const healthTimer = setInterval(() => {
            if (shouldRun) logHealthStatus();
        }, HEALTH_LOG_INTERVAL_MS);
        
        // Clean up health timer on shutdown
        process.on('beforeExit', () => clearInterval(healthTimer));

        if (wsMode === 'market' || wsMode === 'dual') {
            const { subscribeToAssetIds } = await connectMarketWs({
                user,
                outDir: resolvedOut,
                slugPrefix,
                pretty,
                raw,
                writer,
                unified,
                compact,
            });
            marketSubscribeFn = subscribeToAssetIds;
        }

        if (withRest) {
            // Run REST polling concurrently with market websocket so you can correlate user trades vs market events.
            // In unified mode, REST writes to the same `by_slug/<slugId>/events.jsonl`.
            void startRestPollingLoop({
                outDir: resolvedOut,
                user,
                intervalSeconds,
                limit,
                slugPrefix,
                pretty,
                raw,
                writer,
                unified,
                compact,
            });
        }

        if (withOnchain) {
            // On-chain monitor: lower-latency "intent" signal than the Data API, but harder to decode fully.
            // Writes `type=onchain_tx` events into the same per-slug `events.jsonl` when token ids are detected.
            void startOnchainMonitor({
                outDir: resolvedOut,
                user,
                slugPrefix,
                mode: onchainMode,
                writer,
                compact,
                raw,
                unified,
            });
        }

        if (wsMode === 'user' || wsMode === 'dual') {
            await connectUserWs({
                user,
                outDir: resolvedOut,
                slugPrefix,
                pretty,
                raw,
                writer,
                unified,
                deriveCreds,
                onMarketDiscovered: async ({ conditionId, slugId }) => {
                    // Resolve token IDs and subscribe market channel to the right assets for this market
                    const meta = await fetchMarketMetaForConditionId(conditionId);
                    if (meta) {
                        // Save meta.json to R2
                        await saveMetaToR2(user, slugId, meta);
                        if (marketSubscribeFn) marketSubscribeFn(meta.clobTokenIds);
                    }
                },
            });
        }

        // keep process alive
        await new Promise(() => {});
        return;
    }

    let state = await loadState(resolvedOut, user);

    console.log(`📡 Tracking trades for ${user}`);
    console.log(`🗂  Output dir: ${userDir}`);
    console.log(`⏱  Poll interval: ${intervalSeconds}s (limit=${limit})`);
    if (slugPrefix) {
        console.log(`🎯 Filtering slug prefix: ${slugPrefix}`);
        console.log('✅ Writing: one pretty JSON file per slugId (sorted by timestamp)\n');
    } else {
        console.log('✅ Writing: one pretty JSON file per slugId (sorted by timestamp)\n');
    }

    do {
        try {
            const trades = await fetchTrades(user, limit);
            const appended = upsertTrades(resolvedOut, user, state, trades, slugPrefix, pretty);
            await saveState(resolvedOut, user, state);

            const now = new Date().toISOString();
            if (appended > 0) {
                console.log(`[${now}] +${appended} trade(s)`);
            } else {
                process.stdout.write(`[${now}] .\n`);
            }
        } catch (e) {
            console.error('❌ Error fetching/writing trades:', e);
        }

        if (once) break;
        if (!shouldRun) break;
        await sleep(intervalSeconds * 1000);
    } while (shouldRun);

    console.log('\n👋 Done.');
};

main().catch((e) => {
    console.error('❌ Fatal:', e);
    process.exit(1);
});

