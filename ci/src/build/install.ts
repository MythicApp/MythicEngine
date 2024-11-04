/**
 * @fileoverview Install the build.
 */

import { mergeReadableStreams } from '@std/streams';
import * as path from '@std/path';
import { Logging } from '../utils/logging.ts';
import { LogPipe } from '../utils/logPipe.ts';
import { BuildRoot, getBuildEnvironment } from '../utils/buildRoot.ts';
import { pathCreate, pathExists } from '../utils/path.ts';

/**
 * Run the build install.
 * @param buildRoot The root of the build (configured + compiled).
 * @param targetRoot The root of the target.
 * @param logPipe The log pipe to write the output to.
 */
const runBuildInstall = async (
    buildRoot: string,
    targetRoot: string,
    logPipe: LogPipe,
): Promise<boolean> => {
    const logger = Logging.context('buildInstall');
    logger.debug('Installing the build.');

    const file = await logPipe.getPipe();

    const make = new Deno.Command('make', {
        args: ['install-lib', 'DESTDIR=' + targetRoot],
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
 * Install the build.
 * @param buildRoot The root of the build.
 * @param settings The settings for the build.
 */
export const buildInstall = async (
    settings: {
        buildName: string;
        installName: string;
        mode: 'wine64' | 'wine32on64';
        skipBuildCheck: boolean;
    },
): Promise<boolean> => {
    const logger = Logging.context('buildInstall');
    logger.debug('Installing the build.');

    const buildPath = path.normalize(path.join(
        await BuildRoot.getInstance().getBuildPath('build'),
        settings.buildName + '-' + settings.mode,
    ));
    const installPath = path.normalize(path.join(
        await BuildRoot.getInstance().getBuildPath('install'),
        settings.buildName,
    ));

    if (!settings.skipBuildCheck) {
        if (!await pathExists(path.join(buildPath, 'wine'))) {
            logger.error('The build has not been built.');
            return false;
        }
    }

    await pathCreate(installPath);

    const startTime = Date.now();

    if (settings.mode === 'wine64') {
        logger.info('Installing Wine64.');
        const wine64LogPipe = await LogPipe.context('install-wine64');
        if (!await runBuildInstall(buildPath, installPath, wine64LogPipe)) {
            logger.error('Failed to install Wine64.');
            return false;
        }
    } else {
        logger.info('Installing Wine32-on-64.');
        const wine32on64LogPipe = await LogPipe.context('install-wine32on64');
        if (!await runBuildInstall(buildPath, installPath, wine32on64LogPipe)) {
            logger.error('Failed to install Wine32-on-64.');
            return false;
        }
    }

    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    const minutes = Math.floor(duration / 60);
    const seconds = Math.floor(duration % 60);

    logger.info(
        'Install complete in %d minute(s) and %d second(s).',
        minutes,
        seconds,
    );
    return true;
};
