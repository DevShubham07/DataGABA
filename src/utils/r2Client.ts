import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as dotenv from 'dotenv';

dotenv.config();

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || 'MergedLogs';
const R2_ENDPOINT = `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;

// Initialize R2 client (R2 is S3-compatible)
let r2Client: S3Client | null = null;

const getR2Client = (): S3Client | null => {
    if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
        return null;
    }

    if (!r2Client) {
        // Configure environment to limit concurrent connections
        // AWS SDK v3 respects NODE_TLS_REJECT_UNAUTHORIZED and uses default HTTP agent
        // We'll handle rate limiting through our retry logic and upload queue instead
        process.env.AWS_MAX_ATTEMPTS = '1'; // We handle retries ourselves
        
        r2Client = new S3Client({
            region: 'auto',
            endpoint: R2_ENDPOINT,
            credentials: {
                accessKeyId: R2_ACCESS_KEY_ID,
                secretAccessKey: R2_SECRET_ACCESS_KEY,
            },
            maxAttempts: 1, // We handle retries ourselves in uploadToR2
        });
    }

    return r2Client;
};

export interface R2UploadOptions {
    key: string;
    content: string | Buffer;
    contentType?: string;
}

/**
 * Append data to R2 file (downloads existing, appends, uploads)
 */
export const appendToR2 = async (key: string, newContent: string, contentType: string = 'application/x-ndjson'): Promise<boolean> => {
    const client = getR2Client();
    if (!client) {
        console.warn('⚠️  R2 credentials not configured, skipping R2 append');
        return false;
    }

    try {
        // Download existing content
        const existingContent = await downloadFromR2(key);
        
        // Combine: existing + new content
        const combinedContent = existingContent 
            ? existingContent + (existingContent.endsWith('\n') ? '' : '\n') + newContent
            : newContent;

        // Upload combined content
        return await uploadToR2({
            key,
            content: combinedContent,
            contentType,
        }, 3);
    } catch (error: any) {
        console.error(`❌ R2 append failed for ${key}:`, error.message);
        return false;
    }
};

/**
 * Upload data to R2 with retry logic
 */
export const uploadToR2 = async (options: R2UploadOptions, maxRetries: number = 3): Promise<boolean> => {
    const client = getR2Client();
    if (!client) {
        console.warn('⚠️  R2 credentials not configured, skipping R2 upload');
        return false;
    }

    const content = typeof options.content === 'string' ? Buffer.from(options.content, 'utf8') : options.content;
    const command = new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: options.key,
        Body: content,
        ContentType: options.contentType || 'application/json',
    });

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            await client.send(command);
            return true;
        } catch (error: any) {
            const isRateLimit = error.message?.includes('concurrent request rate') || 
                               error.message?.includes('rate') ||
                               error.statusCode === 429;
            
            if (isRateLimit && attempt < maxRetries) {
                // Exponential backoff: 1s, 2s, 4s
                const delay = Math.pow(2, attempt) * 1000;
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }
            
            // Don't log rate limit errors on first attempt (expected)
            if (!isRateLimit || attempt > 0) {
                console.error(`❌ R2 upload failed for ${options.key} (attempt ${attempt + 1}/${maxRetries + 1}):`, error.message);
            }
            return false;
        }
    }
    
    return false;
};

/**
 * Check if object exists in R2
 */
export const existsInR2 = async (key: string): Promise<boolean> => {
    const client = getR2Client();
    if (!client) {
        return false;
    }

    try {
        const command = new HeadObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
        });

        await client.send(command);
        return true;
    } catch {
        return false;
    }
};

/**
 * Download data from R2
 */
export const downloadFromR2 = async (key: string): Promise<string | null> => {
    const client = getR2Client();
    if (!client) {
        return null;
    }

    try {
        const command = new GetObjectCommand({
            Bucket: R2_BUCKET_NAME,
            Key: key,
        });

        const response = await client.send(command);
        if (!response.Body) {
            return null;
        }

        const chunks: Uint8Array[] = [];
        for await (const chunk of response.Body as any) {
            chunks.push(chunk);
        }

        const buffer = Buffer.concat(chunks);
        return buffer.toString('utf8');
    } catch (error: any) {
        // Don't log errors for missing keys (expected when files don't exist yet)
        if (error.name !== 'NoSuchKey' && error.name !== 'NotFound') {
            console.error(`❌ R2 download failed for ${key}:`, error.message);
        }
        return null;
    }
};

/**
 * Check if R2 is configured
 */
export const isR2Configured = (): boolean => {
    return !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
};

/**
 * Get R2 bucket name
 */
export const getR2BucketName = (): string => {
    return R2_BUCKET_NAME;
};
