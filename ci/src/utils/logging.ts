/**
 * @fileoverview Logging utilities for Mythic CI.
 */

import { env } from './env.ts';
import { sprintf } from '@std/fmt/printf';

const enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARNING = 2,
    ERROR = 3,
}

const logLevelOverride: { current: null | LogLevel } = { current: null };

export class Logging {
    /**
     * The context of the logger.
     */
    private contextData: string;

    /**
     * Create a new logger.
     * @param context The context of the logger.
     */
    private constructor(context: string) {
        this.contextData = context;
    }

    /**
     * Create a new logger.
     * @param context The context of the logger.
     */
    public static context(context: string): Logging {
        return new Logging(context);
    }

    /**
     * Parse the log level from the environment.
     */
    public static parseLogLevel(string: string): LogLevel | null {
        switch (string.toUpperCase()) {
            case 'DEBUG':
                return LogLevel.DEBUG;
            case 'INFO':
                return LogLevel.INFO;
            case 'WARNING':
                return LogLevel.WARNING;
            case 'ERROR':
                return LogLevel.ERROR;
            default:
                return null;
        }
    }

    /**
     * Get the log level.
     */
    public static getLogLevel(): LogLevel {
        if (logLevelOverride.current !== null) {
            return logLevelOverride.current;
        }
        logLevelOverride.current = Logging.parseLogLevel(env.logLevel ?? '') ??
            LogLevel.INFO;
        return logLevelOverride.current;
    }

    /**
     * Override the log level.
     * @param level The log level to override with.
     */
    public static overrideLogLevel(level: string): void {
        const parsed = Logging.parseLogLevel(level);
        if (parsed === null) return;
        logLevelOverride.current = parsed;
    }

    /**
     * Log a message.
     * @param level The log level.
     * @param message The message to log.
     */
    private log(level: LogLevel, format: string, args: unknown[]): void {
        const config: Record<LogLevel, {
            color: string;
            text: string;
        }> = {
            [LogLevel.DEBUG]: {
                color: '\x1b[36;38;5;117m', // fallback to cyan
                text: '🐞 DEBUG  ',
            },
            [LogLevel.INFO]: {
                color: '\x1b[32;38;5;43m', // fallback to green
                text: '📝 INFO   ',
            },
            [LogLevel.WARNING]: {
                color: '\x1b[33;38;5;223m', // fallback to yellow
                text: '🚧️ WARNING',
            },
            [LogLevel.ERROR]: {
                color: '\x1b[31m', // red
                text: '🛑 ERROR  ',
            },
        };

        if (level < Logging.getLogLevel()) {
            return;
        }

        const { color, text } = config[level];
        const consoleData = sprintf(
            '\x1b[0;1m%s[%s  %s]\x1b[0m%s %s\x1b[0m',
            color,
            text,
            this.contextData,
            color,
            sprintf(format, ...args),
        );

        // Print to srderr
        Deno.stderr.writeSync(new TextEncoder().encode(consoleData + '\n'));
    }

    /**
     * Log a debug message.
     * @param message The message to log.
     * @param args The arguments to format the message with.
     */
    public debug(format: string, ...args: unknown[]): void {
        this.log(LogLevel.DEBUG, format, args);
    }

    /**
     * Log an info message.
     * @param message The message to log.
     * @param args The arguments to format the message with.
     */
    public info(message: string, ...args: unknown[]): void {
        this.log(LogLevel.INFO, message, args);
    }

    /**
     * Log a warning message.
     * @param message The message to log.
     * @param args The arguments to format the message with.
     */
    public warning(message: string, ...args: unknown[]): void {
        this.log(LogLevel.WARNING, message, args);
    }

    /**
     * Log an error message.
     * @param message The message to log.
     * @param args The arguments to format the message with.
     */
    public error(message: string, ...args: unknown[]): void {
        this.log(LogLevel.ERROR, message, args);
    }
}
