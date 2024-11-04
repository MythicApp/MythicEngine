/**
 * @fileoverview Compiles the build.
 */

import { mergeReadableStreams } from '@std/streams';
import * as path from '@std/path';
import { Logging } from '../utils/logging.ts';
import { LogPipe } from '../utils/logPipe.ts';
import { BuildRoot, getBuildEnvironment } from '../utils/buildRoot.ts';
import { pathExists } from '../utils/path.ts';
import { getCPUCount } from '../checks.ts';

/**
 * Run the build compile.
 * @param buildRoot The root of the build (configured).
 * @param cpuCount The number of CPUs to use.
 * @param logPipe The log pipe to write the output to.
 * @returns Whether the build was successful.
 */
const runBuildCompile = async (
    buildRoot: string,
    cpuCount: number,
    logPipe: LogPipe,
): Promise<boolean> => {
    const logger = Logging.context('buildCompile');
    logger.debug('Compiling the build.');

    const file = await logPipe.getPipe();

    const make = new Deno.Command('make', {
        args: ['-j' + cpuCount.toString()],
        cwd: buildRoot,
        env: getBuildEnvironment(),
        stdout: 'piped',
        stderr: 'piped',
    });

    const process = make.spawn();

    await mergeReadableStreams(process.stdout, process.stderr).pipeTo(
        file,
    );

    await process.output();

    return (await process.status).code === 0;
};

/**
 * Build the build.
 * @param buildRoot The root of the build.
 * @param settings The settings for the build.
 */
export const buildCompile = async (
    settings: {
        configureCheck: boolean;
        name: string;
        mode: 'wine64' | 'wine32on64';
        threads: number | null;
    },
): Promise<boolean> => {
    const logger = Logging.context('buildCompile');
    logger.debug('Building the build.');

    // Get the build path.
    const buildPath = path.normalize(
        path.join(
            await BuildRoot.getInstance().getBuildPath('build'),
            settings.name + '-' + settings.mode,
        ),
    );

    const cpuCount = settings.threads ?? await getCPUCount();

    if (settings.configureCheck) {
        if (!await pathExists(path.join(buildPath, 'Makefile'))) {
            logger.error('The build has not been configured.');
            return false;
        }
    }

    const startTime = Date.now();

    if (settings.mode === 'wine64') {
        logger.info('Building Wine 64-bit.');

        const logPipe = await LogPipe.context('compile-wine64');

        if (!await runBuildCompile(buildPath, cpuCount, logPipe)) {
            logger.error('Failed to build Wine 64-bit.');
            return false;
        }
    } else {
        logger.info('Building Wine 32-bit on 64-bit.');

        const logPipe = await LogPipe.context('compile-wine32on64');

        if (!await runBuildCompile(buildPath, cpuCount, logPipe)) {
            logger.error('Failed to build Wine 32-bit on 64-bit.');
            return false;
        }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);

    logger.info(
        'Build complete in %d minute(s) and %d second(s).',
        minutes,
        seconds,
    );
    return true;
};
