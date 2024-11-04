/**
 * @fileoverview Configure the build.
 */

import * as path from '@std/path';
import { mergeReadableStreams } from '@std/streams';
import { Logging } from '../utils/logging.ts';
import { LogPipe } from '../utils/logPipe.ts';
import { BuildRoot, getBuildEnvironment } from '../utils/buildRoot.ts';
import { pathCreate } from '../utils/path.ts';

/**
 * Create configure options for the build.
 * @param wine32on64Dir The directory for Wine64 directory. If null, Wine32 will not be configured.
 * @param enableWineDebug Whether to enable Wine debug.
 * @returns The configure options.
 */
export const createConfigureOptions = (
    wine32on64Dir: string | null,
    debug: boolean,
): string[] => {
    return [
        '--prefix=', // Prefix is empty so that it is portable.
        '--enable-loader',
        '--disable-tests',
        debug ? '--enable-winedbg' : '--disable-winedbg',
        wine32on64Dir === null ? '--enable-win64' : '--enable-win32on64',
        '--without-alsa',
        '--without-capi',
        '--with-coreaudio',
        '--with-cups',
        '--without-dbus',
        '--without-fontconfig',
        '--with-freetype',
        '--with-gettext',
        '--without-gettextpo',
        '--without-gphoto',
        '--with-gnutls',
        '--without-gssapi',
        wine32on64Dir === null ? '--with-gstreamer' : '--without-gstreamer', // gstreamer is not needed on the 32-bit build.
        '--without-inotify', // inotify is not really used until wine 9.0. (even with inotify-kqueue)
        '--without-krb5',
        '--with-mingw',
        '--without-netapi',
        wine32on64Dir === null ? '--with-openal' : '--without-openal', // openal is not needed on the 32-bit build.
        '--with-opencl',
        '--with-opengl',
        '--without-oss',
        '--with-pcap',
        '--with-pthread',
        '--without-pulse',
        '--without-sane',
        '--with-sdl',
        '--without-udev',
        '--with-unwind',
        '--without-usb',
        '--without-v4l2',
        '--with-vulkan',
        wine32on64Dir === null ? null : `--with-wine64=${wine32on64Dir}`,
        '--without-x',
    ].filter((option) => option !== null);
};

/**
 * Run the configure script.
 * @param wineRoot The root of the Wine build.
 * @param cwd The current working directory.
 * @param configureOptions The options to pass to configure.
 * @param logPipe The log pipe to write to.
 * @returns The exit code of the configure script.
 */
const runConfigure = async (
    wineRoot: string,
    cwd: string,
    configureOptions: string[],
    logPipe: LogPipe,
): Promise<boolean> => {
    const logger = Logging.context('runConfigure');
    logger.debug('Running configure.');

    const file = await logPipe.getPipe();

    const configure = new Deno.Command(
        path.join(wineRoot, 'configure'),
        {
            args: configureOptions,
            cwd,
            env: {
                'ac_cv_lib_soname_MoltenVK': 'libMoltenVK.dylib',
                'ac_cv_lib_soname_Vulkan': '',
                ...getBuildEnvironment(),
            },
            stdout: 'piped',
            stderr: 'piped',
        },
    );

    const process = configure.spawn();

    await mergeReadableStreams(process.stdout, process.stderr).pipeTo(
        file,
    );

    await process.output();

    return (await process.status).code === 0;
};

export const buildConfigure = async (
    wineRoot: string,
    settings: {
        name: string;
        mode: 'wine64' | 'wine32on64';
        wineDebug: boolean;
    },
): Promise<boolean> => {
    const logger = Logging.context('buildConfigure');

    const buildRoot = path.normalize(
        path.join(
            await BuildRoot.getInstance().getBuildPath('build'),
            settings.name + '-' + settings.mode,
        ),
    );
    const buildRoot64 = path.normalize(
        path.join(
            await BuildRoot.getInstance().getBuildPath('build'),
            settings.name + '-wine64',
        ),
    );

    // Create the build directory.
    await pathCreate(buildRoot);

    // Configure the Wine build.
    if (settings.mode === 'wine64') {
        logger.info('Configuring Wine64.');
        const wine64LogPipe = await LogPipe.context('configure-wine64');
        const wine64ConfigureOptions = createConfigureOptions(
            null,
            settings.wineDebug,
        );
        if (
            !await runConfigure(
                wineRoot,
                buildRoot,
                wine64ConfigureOptions,
                wine64LogPipe,
            )
        ) {
            logger.error('Failed to configure Wine64.');
            return false;
        }
    } else {
        logger.info('Configuring Wine32-on-64.');
        const wine32on64LogPipe = await LogPipe.context('configure-wine32on64');
        const wine32on64ConfigureOptions = createConfigureOptions(
            buildRoot64,
            settings.wineDebug,
        );

        if (
            !await runConfigure(
                wineRoot,
                buildRoot,
                wine32on64ConfigureOptions,
                wine32on64LogPipe,
            )
        ) {
            logger.error('Failed to configure Wine32-on-64.');
            return false;
        }
    }

    logger.info('Successfully configured the build.');
    return true;
};
