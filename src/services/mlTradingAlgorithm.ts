/**
 * ML Trading Algorithm Service
 * TypeScript wrapper for Python ML trading algorithm
 */

import { spawn } from 'child_process';
import * as path from 'path';
import Logger from '../utils/logger';

export interface MarketData {
    price: number;
    trader_side: 'BUY' | 'SELL' | 'MERGE';
    trader_outcome?: 'Up' | 'Down';
    trader_size?: number;
    trader_usdc_size: number;
    timestamp: number;
    market_slug?: string;
    available_balance: number;
    current_position_size?: number;
}

export interface TradingDecision {
    execute: boolean;
    reason: string;
    predicted_outcome: 'Up' | 'Down' | null;
    confidence: number;
    recommended_size_usd: number;
    ml_confidence: number;
    is_cheaper_outcome?: boolean;
    is_active_hour?: boolean;
    outcome_match?: boolean;
    analysis?: {
        price: number;
        price_distance_from_50: number;
        hour: number;
        is_cheaper_outcome: boolean;
        is_active_hour: boolean;
    };
    patterns?: {
        avg_trade_size: number;
        most_active_hours: string[];
    };
}

export class MLTradingAlgorithm {
    private pythonScriptPath: string;
    private modelsDir: string;
    private enabled: boolean;

    constructor(modelsDir: string = 'models', enabled: boolean = true) {
        this.modelsDir = modelsDir;
        this.enabled = enabled;
        // Path to Python script
        this.pythonScriptPath = path.join(__dirname, 'mlTradingAlgorithm.py');
    }

    /**
     * Check if ML algorithm should execute a trade
     */
    async shouldExecuteTrade(marketData: MarketData): Promise<TradingDecision> {
        if (!this.enabled) {
            Logger.info('ML algorithm disabled - executing trade');
            return {
                execute: true,
                reason: 'ML algorithm disabled',
                predicted_outcome: null,
                confidence: 1.0,
                recommended_size_usd: marketData.trader_usdc_size,
                ml_confidence: 1.0,
            };
        }

        try {
            const decision = await this.callPythonAlgorithm(marketData);
            return decision;
        } catch (error) {
            Logger.warning(`ML algorithm error: ${error}`);
            // Fallback: execute trade if ML fails
            return {
                execute: true,
                reason: `ML algorithm error: ${error}`,
                predicted_outcome: null,
                confidence: 0.5,
                recommended_size_usd: marketData.trader_usdc_size,
                ml_confidence: 0.0,
            };
        }
    }

    /**
     * Get detailed trade recommendation
     */
    async getTradeRecommendation(marketData: MarketData): Promise<TradingDecision> {
        return this.shouldExecuteTrade(marketData);
    }

    /**
     * Call Python algorithm via subprocess
     */
    private async callPythonAlgorithm(marketData: MarketData): Promise<TradingDecision> {
        return new Promise((resolve, reject) => {
            const pythonProcess = spawn('python3', [this.pythonScriptPath], {
                cwd: path.join(__dirname, '../..'),
                env: { ...process.env, PYTHONUNBUFFERED: '1' },
            });

            let stdout = '';
            let stderr = '';

            pythonProcess.stdout.on('data', (data) => {
                stdout += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            pythonProcess.on('close', (code) => {
                if (code !== 0) {
                    // Try to parse error as JSON decision
                    try {
                        const errorDecision = JSON.parse(stderr.trim());
                        resolve(errorDecision as TradingDecision);
                        return;
                    } catch {
                        reject(new Error(`Python process exited with code ${code}: ${stderr || stdout}`));
                        return;
                    }
                }

                try {
                    const result = JSON.parse(stdout.trim());
                    resolve(result as TradingDecision);
                } catch (error) {
                    reject(new Error(`Failed to parse Python output: ${stdout}`));
                }
            });

            pythonProcess.on('error', (error) => {
                reject(new Error(`Failed to spawn Python process: ${error.message}`));
            });

            // Send market data as JSON to stdin
            const input = JSON.stringify(marketData);
            pythonProcess.stdin.write(input);
            pythonProcess.stdin.end();
        });
    }

    /**
     * Enable or disable ML algorithm
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        Logger.info(`ML algorithm ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Check if ML algorithm is available
     */
    async isAvailable(): Promise<boolean> {
        if (!this.enabled) {
            return false;
        }

        try {
            // Test with sample data
            const testData: MarketData = {
                price: 0.5,
                trader_side: 'BUY',
                trader_outcome: 'Up',
                trader_usdc_size: 5,
                timestamp: Math.floor(Date.now() / 1000),
                available_balance: 100,
            };

            await this.callPythonAlgorithm(testData);
            return true;
        } catch (error) {
            Logger.warning(`ML algorithm not available: ${error}`);
            return false;
        }
    }
}

// Singleton instance
let mlAlgorithmInstance: MLTradingAlgorithm | null = null;

/**
 * Get or create ML algorithm instance
 */
export function getMLAlgorithm(enabled: boolean = true): MLTradingAlgorithm {
    if (!mlAlgorithmInstance) {
        mlAlgorithmInstance = new MLTradingAlgorithm('models', enabled);
    }
    return mlAlgorithmInstance;
}
