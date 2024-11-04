/**
 * @fileoverview S3 utility functions
 */

import { S3Client } from '@aws-sdk/client-s3';
import { Logging } from './logging.ts';
import { env } from './env.ts';

/**
 * S3 utility functions.
 */
export class S3Data {
    private static instance: S3Data | null = null;

    readonly client: S3Client;
    readonly bucket: string;

    /**
     * Singleton instance.
     */
    private constructor() {
        const logger = Logging.context('s3');
        logger.debug('Creating S3 client.');

        if (!env.s3) {
            logger.error('S3 environment variables not set.');
            throw new Error('S3 environment variables not set.');
        }

        this.client = new S3Client({
            region: env.s3.region,
            credentials: {
                accessKeyId: env.s3.accessKeyId,
                secretAccessKey: env.s3.secretAccessKey,
            },
        });

        this.bucket = env.s3.bucket;
    }

    /**
     * Get the singleton instance.
     * @returns The singleton instance.
     */
    public static getInstance(): S3Data | null {
        if (this.instance === null) {
            try {
                this.instance = new S3Data();
                return this.instance;
            } catch {
                return null;
            }
        }

        return this.instance;
    }
}
