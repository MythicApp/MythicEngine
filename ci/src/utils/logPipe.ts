/**
 * @fileoverview Stores logs from the builds.
 */

import { join } from '@std/path';
import { pathCreate } from './path.ts';

const logPipeDirectoryOverride: {
    current: { type: 'path'; path: string } | { type: 'stdout' } | null;
} = { current: null };

export class LogPipe {
    /**
     * The name of the log pipe.
     */
    private name: string;
    /**
     * The id of the log pipe.
     */
    private id: string;

    /**
     * Create a new log pipe.
     * @param name The name of the log pipe.
     */
    private constructor(name: string) {
        this.name = name;
        this.id = crypto.randomUUID();
    }

    /**
     * Get the log pipe directory.
     * @returns The log pipe directory.
     */
    public static getLogPipeDirectory(): string | null {
        if (
            logPipeDirectoryOverride.current !== null &&
            logPipeDirectoryOverride.current.type === 'path'
        ) {
            return logPipeDirectoryOverride.current.path;
        }

        return null;
    }

    /**
     * Check if the log pipe is set to stdout.
     */
    public static isLogPipeStdout(): boolean {
        return logPipeDirectoryOverride.current === null;
    }

    /**
     * Override the log pipe directory.
     * @param directory The directory to override with.
     */
    public static setLogPipeDirectory(directory: string): void {
        logPipeDirectoryOverride.current = { type: 'path', path: directory };
    }

    /**
     * Override the log pipe to stdout.
     */
    public static setLogPipeStdout(): void {
        logPipeDirectoryOverride.current = { type: 'stdout' };
    }

    /**
     * Disable the log pipe.
     */
    public static disableLogPipe(): void {
        logPipeDirectoryOverride.current = null;
    }

    /**
     * Add a entry to the index.
     */
    private async addEntry() {
        const directory = LogPipe.getLogPipeDirectory();
        if (directory === null) return;

        await pathCreate(directory);

        const index = await Deno.open(join(directory, 'index.ini'), {
            write: true,
            create: true,
            append: true,
        });
        await index.write(
            new TextEncoder().encode(`${this.id}=${this.name}\n`),
        );
        index.close();
    }

    /**
     * Get the qualified file path.
     * @returns The qualified file path or null if disabled.
     */
    public getFilePath(): string | null {
        const directory = LogPipe.getLogPipeDirectory();
        if (directory === null) return null;
        return join(directory, this.id);
    }

    /**
     * Get a pipe for the log.
     * @returns The pipe for the log.
     */
    public async getPipe(): Promise<WritableStream> {
        if (LogPipe.isLogPipeStdout()) {
            return Deno.stdout.writable;
        }

        const file = this.getFilePath();
        if (file === null) {
            return (await Deno.open('/dev/null', { write: true })).writable;
        }

        return (await Deno.open(file, { write: true, create: true })).writable;
    }

    /**
     * Create a new log pipe.
     * @param file The file to write the logs to.
     */
    public static async context(file: string): Promise<LogPipe> {
        const alphaNumericSymbol =
            'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.';
        if (file.split('').some((char) => !alphaNumericSymbol.includes(char))) {
            throw new Error('Invalid characters in file name.');
        }

        const pipe = new LogPipe(file);
        await pipe.addEntry();

        return pipe;
    }
}
