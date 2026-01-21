#!/usr/bin/env ts-node
/**
 * Fetch Historical Trades for Ethereum 1-Hour Markets
 * 
 * Steps:
 * 1. Generate market slugs for Ethereum 1-hour markets (decreasing hour)
 * 2. For each slug, fetch conditionId from Polymarket API
 * 3. Fetch user trades using conditionId
 * 4. Prettify and sort data by timestamp
 * 5. Save files slug-wise
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

const USER_ADDRESS = process.env.USER_ADDRESSES?.split(',')[0] || '0x6031b6eed1c97e853c6e0f03ad3ce3529351f96d';
const OUTPUT_DIR = path.join(process.cwd(), 'historical_trades');
const MAX_MARKETS = 100;
const DELAY_BETWEEN_REQUESTS_MS = 500; // Rate limiting

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Generate Ethereum 1-hour market slugs
const generateMarketSlugs = (count: number): string[] => {
    const slugs: string[] = [];
    const now = new Date();
    const monthNames = ['january', 'february', 'march', 'april', 'may', 'june',
                       'july', 'august', 'september', 'october', 'november', 'december'];
    
    let currentDate = new Date(now);
    let marketsGenerated = 0;
    
    // Start from current hour and go backwards
    while (marketsGenerated < count) {
        const month = monthNames[currentDate.getMonth()].toLowerCase();
        const day = currentDate.getDate();
        const hour = currentDate.getHours();
        
        const ampm = hour >= 12 ? 'pm' : 'am';
        const hour12 = hour > 12 ? hour - 12 : (hour === 0 ? 12 : hour);
        
        const slug = `ethereum-up-or-down-${month}-${day}-${hour12}${ampm}-et`;
        slugs.push(slug);
        marketsGenerated++;
        
        // Move back 1 hour
        currentDate.setHours(currentDate.getHours() - 1);
    }
    
    return slugs;
};

// Fetch conditionId from market slug
const fetchConditionId = async (slug: string): Promise<string | null> => {
    try {
        const url = `https://gamma-api.polymarket.com/markets/slug/${slug}`;
        console.log(`   🔗 CURL: curl --request GET --url '${url}'`);
        const response = await axios.get(url, { timeout: 10000 });
        
        if (response.data && response.data.conditionId) {
            console.log(`   ✅ Got conditionId: ${response.data.conditionId}`);
            return response.data.conditionId;
        }
        
        console.log(`   ⚠️  No conditionId in response`);
        return null;
    } catch (error: any) {
        if (error.response?.status === 404) {
            console.log(`   ⚠️  Market not found (404): ${slug}`);
        } else {
            console.error(`   ❌ Error fetching conditionId for ${slug}:`, error.message);
            if (error.response) {
                console.error(`   Response status: ${error.response.status}`);
                console.error(`   Response data:`, JSON.stringify(error.response.data).substring(0, 200));
            }
        }
        return null;
    }
};

// Fetch user trades using conditionId
const fetchUserTrades = async (conditionId: string, slug: string): Promise<any[]> => {
    try {
        const url = `https://data-api.polymarket.com/activity?limit=1000&sortBy=TIMESTAMP&sortDirection=DESC&user=${USER_ADDRESS}&market=${conditionId}`;
        console.log(`   🔗 CURL: curl --request GET --url '${url}'`);
        const response = await axios.get(url, { timeout: 10000 });
        
        console.log(`   📥 Response status: ${response.status}`);
        console.log(`   📦 Response type: ${Array.isArray(response.data) ? 'Array' : typeof response.data}`);
        console.log(`   📊 Response length: ${Array.isArray(response.data) ? response.data.length : 'N/A'}`);
        
        if (Array.isArray(response.data)) {
            if (response.data.length > 0) {
                console.log(`   ✅ Found ${response.data.length} trades`);
                // Show sample trade
                console.log(`   📋 Sample trade:`, JSON.stringify(response.data[0]).substring(0, 150));
            } else {
                console.log(`   ℹ️  Empty array returned (no trades found)`);
            }
            return response.data;
        }
        
        console.log(`   ⚠️  Response is not an array:`, typeof response.data);
        if (response.data) {
            console.log(`   Response preview:`, JSON.stringify(response.data).substring(0, 200));
        }
        
        return [];
    } catch (error: any) {
        console.error(`   ❌ Error fetching trades for ${slug}:`, error.message);
        if (error.response) {
            console.error(`   Response status: ${error.response.status}`);
            console.error(`   Response data:`, JSON.stringify(error.response.data).substring(0, 200));
        }
        return [];
    }
};

// Save trades to file
const saveTrades = (slug: string, trades: any[]): void => {
    if (trades.length === 0) {
        console.log(`   ⏭️  No trades to save for ${slug}`);
        return;
    }
    
    // Sort by timestamp
    trades.sort((a, b) => {
        const tsA = a.timestamp || 0;
        const tsB = b.timestamp || 0;
        return tsA - tsB;
    });
    
    // Prettify and save
    const fileName = `${slug.replace(/[^a-z0-9-]/gi, '_')}.json`;
    const filePath = path.join(OUTPUT_DIR, fileName);
    
    try {
        fs.writeFileSync(filePath, JSON.stringify(trades, null, 2), 'utf8');
        console.log(`   ✅ Saved ${trades.length} trades to ${fileName}`);
    } catch (error: any) {
        console.error(`   ❌ Error saving file for ${slug}:`, error.message);
    }
};

// Sleep utility
const sleep = (ms: number): Promise<void> => {
    return new Promise(resolve => setTimeout(resolve, ms));
};

// Main function
const main = async () => {
    console.log('🚀 Fetching Historical Trades for Ethereum 1-Hour Markets');
    console.log('='.repeat(70));
    console.log(`👤 User: ${USER_ADDRESS}`);
    console.log(`📁 Output directory: ${OUTPUT_DIR}`);
    console.log(`📊 Max markets: ${MAX_MARKETS}`);
    console.log('');
    
    // Generate market slugs
    const slugs = generateMarketSlugs(MAX_MARKETS);
    console.log(`📋 Generated ${slugs.length} market slugs`);
    console.log(`   First: ${slugs[0]}`);
    console.log(`   Last: ${slugs[slugs.length - 1]}`);
    console.log('');
    
    let successCount = 0;
    let tradeCount = 0;
    let skippedCount = 0;
    
    // Process each market
    for (let i = 0; i < slugs.length; i++) {
        const slug = slugs[i];
        console.log(`[${i + 1}/${slugs.length}] Processing: ${slug}`);
        
        // Fetch conditionId
        const conditionId = await fetchConditionId(slug);
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        
        if (!conditionId) {
            skippedCount++;
            console.log(`   ⏭️  Skipped (no conditionId found)\n`);
            continue;
        }
        
        console.log(`   📍 ConditionId: ${conditionId}`);
        
        // Fetch trades
        const trades = await fetchUserTrades(conditionId, slug);
        await sleep(DELAY_BETWEEN_REQUESTS_MS);
        
        if (trades.length > 0) {
            // Save trades
            saveTrades(slug, trades);
            tradeCount += trades.length;
            successCount++;
        } else {
            console.log(`   ℹ️  No trades found for this market`);
            skippedCount++;
        }
        
        console.log('');
        
        // Progress update every 10 markets
        if ((i + 1) % 10 === 0) {
            console.log(`📊 Progress: ${i + 1}/${slugs.length} markets processed`);
            console.log(`   ✅ Success: ${successCount} | 📦 Trades: ${tradeCount} | ⏭️  Skipped: ${skippedCount}\n`);
        }
    }
    
    // Final summary
    console.log('='.repeat(70));
    console.log('✅ COMPLETED');
    console.log('='.repeat(70));
    console.log(`📊 Markets processed: ${slugs.length}`);
    console.log(`✅ Markets with trades: ${successCount}`);
    console.log(`⏭️  Markets skipped: ${skippedCount}`);
    console.log(`📦 Total trades fetched: ${tradeCount}`);
    console.log(`📁 Files saved to: ${OUTPUT_DIR}`);
};

main().catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
