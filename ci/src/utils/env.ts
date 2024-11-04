/**
 * @fileoverview Typed environment variables for Mythic CI.
 */

import '@std/dotenv/load';

/**
 * A representation of the environment variables.
 */
export interface Env {
    logLevel: string | null;
    s3: {
        bucket: string;
        region: string;
        accessKeyId: string;
        secretAccessKey: string;
    } | null;
}

/**
 * Load the environment variables.
 */
const getEnv = (): Env => {
    const LOG_LEVEL = Deno.env.get('LOG_LEVEL');
    const S3_BUCKET = Deno.env.get('S3_BUCKET');
    const S3_REGION = Deno.env.get('S3_REGION');
    const AWS_ACCESS_KEY_ID = Deno.env.get('AWS_ACCESS_KEY_ID');
    const AWS_SECRET_ACCESS_KEY = Deno.env.get('AWS_SECRET_ACCESS_KEY');

    let s3 = null;
    if (S3_BUCKET && S3_REGION && AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY) {
        s3 = {
            bucket: S3_BUCKET,
            region: S3_REGION,
            accessKeyId: AWS_ACCESS_KEY_ID,
            secretAccessKey: AWS_SECRET_ACCESS_KEY,
        };
    }

    return {
        logLevel: LOG_LEVEL === undefined ? null : LOG_LEVEL,
        s3,
    };
};

/**
 * The environment variables.
 */
export const env = getEnv();
