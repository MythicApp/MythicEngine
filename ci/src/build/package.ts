/**
 * @fileoverview Package the build to be ready for distribution.
 */

import * as path from '@std/path';
import * as semver from '@std/semver';
import { Logging } from '../utils/logging.ts';
import { BuildRoot } from '../utils/buildRoot.ts';
import { pathCopy, pathCreate, pathExists, pathList } from '../utils/path.ts';
import { getBrewPrefix, getBrewPrefixOf } from '../checks.ts';
import packages from '../packages.ts';
import { LogPipe } from '../utils/logPipe.ts';
import type { buildPackageFeatureType } from '../main.ts';

// Constants
const WINE_MONO_DOWNLOAD_URL =
    'https://github.com/madewokherd/wine-mono/releases/download/wine-mono-7.4.1/wine-mono-7.4.1-x86.tar.xz';
const WINETRICKS_DOWNLOAD_URL =
    'https://raw.githubusercontent.com/Winetricks/winetricks/master/src/winetricks';
const WINETRICKS_VERBS_DOWNLOAD_URL =
    'https://raw.githubusercontent.com/Winetricks/winetricks/master/files/verbs/all.txt';

/**
 * Use tar utility to extract a tarball.
 * @param tarball The path to the tarball.
 * @param dest The destination to extract the tarball to.
 * @param format The format of the tarball.
 * @returns Whether the tarball was extracted successfully.
 */
const extractTarball = async (
    tarball: string,
    dest: string,
    format: 'xz' | 'gz' = 'xz',
): Promise<boolean> => {
    const logger = Logging.context('extractTarball');
    logger.debug('Extracting %s to %s.', tarball, dest);

    const command = new Deno.Command('tar', {
        args: [
            format === 'xz' ? '-xJf' : '-xzf',
            tarball,
            '-C',
            dest,
        ],
    });

    const { code } = await command.output();
    if (code !== 0) {
        logger.error('Failed to extract %s to %s.', tarball, dest);
        return false;
    }

    return true;
};

/**
 * Use tar utility to create a tarball.
 * @param folder The folder to create the tarball from.
 * @param tarball The path to the tarball.
 * @param format The format of the tarball.
 * @returns Whether the tarball was created successfully.
 */
const createTarball = async (
    folder: string,
    tarball: string,
    format: 'xz' | 'gz' = 'xz',
): Promise<boolean> => {
    const logger = Logging.context('createTarball');
    logger.debug('Creating %s from %s.', tarball, folder);

    const command = new Deno.Command('tar', {
        args: [
            format === 'xz' ? '-cJf' : '-czf',
            tarball,
            '-C',
            folder,
            '.',
        ],
    });

    const { code } = await command.output();
    if (code !== 0) {
        logger.error('Failed to create %s from %s.', tarball, folder);
        return false;
    }

    return true;
};

/**
 * Get the dylib paths of a binary.
 * @param binaryPath The path to the binary.
 * @returns The dylib paths.
 */
const getDylibPaths = async (
    binaryPath: string,
    log: (data: string) => void = () => {},
): Promise<string[] | null> => {
    const installNameTool = new Deno.Command('otool', {
        args: ['-L', binaryPath],
        stdout: 'piped',
    });

    const { code, stdout } = await installNameTool.output();
    if (code !== 0) {
        log('[getDylibPaths] Failed to get the dylib paths for ' + binaryPath);
        return null;
    }

    const dylibPaths = new TextDecoder().decode(stdout).split('\n')
        .slice(1)
        .map((line) => line.trim().split(' ')[0])
        .filter((path) => path.trim() !== '');

    return dylibPaths;
};

/**
 * Use install_name_tool to update the dylib paths.
 * @param binaryPath The path to the binary.
 * @param dylibPath The path to update the dylib paths to.
 * @param oldDylibPath The old dylib path to update.
 * @returns Whether the update was successful.
 */
const updateDylibPaths = async (
    binaryPath: string,
    dylibPath: string,
    oldDylibPath: string,
    log: (data: string) => void = () => {},
): Promise<boolean> => {
    const installNameTool = new Deno.Command('install_name_tool', {
        args: ['-change', oldDylibPath, dylibPath, binaryPath],
    });

    const { code } = await installNameTool.output();
    if (code !== 0) {
        log(`[updateDylibPaths] Failed to update the dylib paths for ${oldDylibPath} -> ${dylibPath} in ${binaryPath}`);
        return false;
    }

    return true;
};

/**
 * Unsign a binary.
 * @param binaryPath The path to the binary.
 * @returns Whether the unsign was successful.
 */
const unsignBinary = async (
    binaryPath: string,
    log: (data: string) => void = () => {},
): Promise<boolean> => {
    const unsign = new Deno.Command('codesign', {
        args: ['-fs-', binaryPath],
    });

    const { code } = await unsign.output();
    if (code !== 0) {
        log(`[unsignBinary] Failed to unsign ${binaryPath}`);
        return false;
    }

    return true;
};

/**
 * Resolve the rpath of a binary.
 * @param binaryPath The path to the binary.
 * @param rpath The rpath to resolve.
 * @returns The resolved rpath.
 */
const resolveRpath = async (
    binaryPath: string,
    rpath: string,
): Promise<string | null> => {
    // Trim the rpath.
    const trimmed = binaryPath.slice('@rpath/'.length);
    const pathData = path.join(rpath, trimmed);

    if (!await pathExists(pathData)) {
        return null;
    }

    return path.normalize(pathData);
};

/**
 * Update the rpaths of a binary.
 * @param binaryPath The path to the binary.
 * @param pathPrefix The prefix to replace the rpath with.
 */
const updateRpaths = async (
    binaryPath: string,
    pathPrefix: string,
    log: (data: string) => void = () => {},
): Promise<boolean> => {
    const paths = await getDylibPaths(binaryPath, log);
    if (paths === null) {
        log(`[updateRpaths] Failed to get the dylib paths for ${binaryPath}`);
        return false;
    }

    for (const pathData of paths) {
        if (
            pathData.startsWith('/usr/lib') || pathData.startsWith('/System/')
        ) {
            continue;
        }

        const basenameData = path.basename(pathData);
        const newPath = path.join(pathPrefix, basenameData);

        if (!updateDylibPaths(binaryPath, newPath, pathData, log)) {
            log(`[updateRpaths] Failed to update the rpaths for ${binaryPath}`);
            continue;
        }
    }

    if (!unsignBinary(binaryPath, log)) {
        log(`[updateRpaths] Failed to unsign ${binaryPath}`);
        return false;
    }

    return true;
};

/**
 * Recursive dependency check.
 * @param binaryPath The path to the binary.
 * @returns All the dependencies of the binary.
 */
const getDependencies = async (
    binaryPath: string,
    brewPrefix: string,
    globalDependencies: Set<string> = new Set<string>(),
    globalSearched: Set<string> = new Set<string>(),
    log: (data: string) => void = () => {},
): Promise<{
    dependencies: Set<string>;
    searched: Set<string>;
}> => {
    log(`[getDependencies] Getting dependencies for ${binaryPath}`);

    const search = [path.normalize(binaryPath)];
    const dependencies: Set<string> = new Set();
    const searched: Set<string> = new Set();

    while (search.length > 0) {
        const pathData = search.pop();
        if (pathData === undefined) continue;

        if (
            dependencies.has(pathData) || globalDependencies.has(pathData) ||
            searched.has(pathData) || globalSearched.has(pathData)
        ) continue;

        const referenced = await getDylibPaths(pathData, log);
        if (referenced === null) {
            log(`[getDependencies] Failed to get dependencies for ${pathData}`);
            dependencies.add(pathData);
            continue;
        }

        for (const reference of referenced) {
            const normalized = path.normalize(reference);

            // Skip system libraries.
            if (
                reference.startsWith('/usr/lib') ||
                reference.startsWith('/System/') ||
                path.basename(reference).trim() === ''
            ) continue;

            // Skip searched libraries.
            if (searched.has(reference) || globalSearched.has(reference)) {
                continue;
            }

            // Resolve rpath.
            if (reference.startsWith('@rpath/')) {
                const rpath = await resolveRpath(
                    pathData,
                    path.join(brewPrefix, 'lib'),
                );

                if (rpath === null) {
                    log(
                        '[getDependencies] Failed to resolve rpath for ' +
                            reference,
                    );
                    searched.add(reference);
                } else {
                    search.push(rpath);
                }
            } else {
                if (!await pathExists(normalized)) {
                    log('[getDependencies] Failed to find ' + reference);
                    searched.add(reference);
                } else {
                    search.push(normalized);
                }
            }
        }

        dependencies.add(pathData);
    }

    return {
        dependencies,
        searched,
    };
};

/**
 * Parse verbs from Winetricks.
 * @param verbs The verbs to parse.
 * @returns The parsed verbs.
 */
const parseVerbs = (
    verbs: string,
): {
    sectionName: string;
    verbs: {
        name: string;
        description: string | null;
    }[];
}[] => {
    const lines = verbs.split('\n');

    let currentSection = '';
    let currentVerbs: {
        name: string;
        description: string | null;
    }[] = [];
    const parsed: {
        sectionName: string;
        verbs: {
            name: string;
            description: string | null;
        }[];
    }[] = [];

    for (const line of lines) {
        if (line.startsWith('===== ')) {
            if (currentVerbs.length > 0) {
                parsed.push({
                    sectionName: currentSection,
                    verbs: currentVerbs,
                });
            }

            currentSection = line.slice('====='.length, -'====='.length).trim();
            currentVerbs = [];
        } else {
            const [name] = line.split(' ');
            const description = line.slice(name.length).trim();
            currentVerbs.push({
                name,
                description: description === '' ? null : description,
            });
        }
    }

    // Add the last section.
    if (currentVerbs.length > 0) {
        parsed.push({
            sectionName: currentSection,
            verbs: currentVerbs,
        });
    }

    // Capitalize the section names.
    for (const section of parsed) {
        section.sectionName = section.sectionName.split(' ').map((word) =>
            word.charAt(0).toUpperCase() + word.slice(1)
        ).join(' ');
    }

    return parsed;
};

/**
 * @fileoverview Package the build to be ready for distribution.
 */
export const buildPackage = async (
    wineRoot: string,
    settings: {
        installName: string;
        packageName: string;
        features: (typeof buildPackageFeatureType)['allowedValues'];
        version: string;
    },
): Promise<boolean> => {
    const logger = Logging.context('installLibs');
    logger.debug('Installing the libs.');

    const installRoot = path.normalize(
        path.join(
            await BuildRoot.getInstance().getBuildPath('install'),
            settings.installName,
        ),
    );
    const packageRoot = path.normalize(
        path.join(
            await BuildRoot.getInstance().getBuildPath('package'),
            settings.packageName,
        ),
    );
    const packageRootTarXz = packageRoot + '.tar.xz';
    const cacheRoot = path.normalize(
        path.join(await BuildRoot.getInstance().getBuildPath('cache')),
    );

    // Paths
    const winePath = path.join(packageRoot, 'wine');
    const dxvkPath = path.join(packageRoot, 'directx-vulkan');
    const winetricksPath = path.join(packageRoot, 'winetricks');

    // Cache paths
    const wineMonoCache = path.join(cacheRoot, 'wine-mono');
    const wineMonoExtractedCache = path.join(wineMonoCache, 'mono');
    const wineMonoTarballCache = path.join(wineMonoCache, 'wine-mono.tar.xz');
    const winetricksCache = path.join(cacheRoot, 'winetricks');
    const winetricksVerbsCache = path.join(winetricksCache, 'verbs.txt');
    const winetricksBinaryCache = path.join(winetricksCache, 'winetricks');

    // Copy all files from the source to the target.
    logger.info('Copying wine files.');
    await pathCreate(winePath);
    await pathCopy(installRoot, winePath);

    // Get the wine version
    const wineVersionFile = await Deno.readTextFile(
        path.join(wineRoot, 'VERSION'),
    );
    const wineVersionString = /Wine version (.+)/.exec(wineVersionFile);
    if (wineVersionString === null || wineVersionString.length < 2) {
        logger.error('Failed to get the wine version.');
        return false;
    }
    let wineVersion;
    try {
        const parts = wineVersionString[1].split('.');
        // Wine version is in the format of x.x
        if (parts.length < 3) {
            parts.push('0');
        }

        wineVersion = semver.parse(parts.join('.'));
    } catch (e) {
        logger.error(
            'Failed to get the wine version. %s',
            (e as Error).message,
        );
        return false;
    }

    // Copy the DXVK files.
    if (settings.features.includes('directx-vulkan')) {
        logger.info('Installing DXVK.');
        await pathCreate(dxvkPath);
        await pathCopy(path.join(wineRoot, 'dxvk'), dxvkPath);
    }

    // Copy the GPTK files.
    if (settings.features.includes('game-porting-toolkit')) {
        // Disabling GPTK will probably break the build but okay ig.
        logger.info('Installing GPTK.');
        await pathCopy(
            path.join(wineRoot, 'gptk', 'redist', 'lib'),
            path.join(winePath, 'lib'),
        );
    }

    // Wine Mono
    if (settings.features.includes('wine-mono')) {
        logger.info('Installing Wine Mono.');
        if (!await pathExists(wineMonoExtractedCache)) {
            // Create the cache directory.
            await pathCreate(wineMonoExtractedCache); // Tar will throw an error if the directory does not exist.

            // Get the tarball.
            logger.info('Downloading Wine Mono; cache does not exist.');
            const [wineMonoRequest, error] = await fetch(WINE_MONO_DOWNLOAD_URL)
                .then((response) => [response, null] as [Response, null])
                .catch((e) => [null, e] as [null, unknown]);

            if (wineMonoRequest === null) {
                logger.error(
                    'Failed to download Wine Mono. %s',
                    error instanceof Error ? error.message : String(error),
                );
                return false;
            }

            await wineMonoRequest.body?.pipeTo(
                (await Deno.open(wineMonoTarballCache, {
                    write: true,
                    create: true,
                })).writable,
            );

            // Extract Wine Mono.
            await extractTarball(wineMonoTarballCache, wineMonoExtractedCache);
        }

        // Copy Wine Mono.
        await pathCopy(
            wineMonoExtractedCache,
            path.join(winePath, 'share', 'wine', 'mono'),
        );
    }

    // Get Winetricks.
    if (settings.features.includes('winetricks')) {
        logger.info('Installing Winetricks.');
        if (
            !await pathExists(winetricksBinaryCache) ||
            !await pathExists(winetricksVerbsCache)
        ) {
            // Create the cache directory.
            await pathCreate(winetricksCache);

            // Download Winetricks.
            logger.info('Downloading Winetricks; cache does not exist.');

            // Download the binary.
            const [winetricksRequest, winetricksError] = await fetch(
                WINETRICKS_DOWNLOAD_URL,
            )
                .then((response) => [response, null] as [Response, null])
                .catch((e) => [null, e] as [null, unknown]);

            if (winetricksRequest === null) {
                logger.error(
                    'Failed to download Winetricks. %s',
                    winetricksError instanceof Error
                        ? winetricksError.message
                        : String(winetricksError),
                );
                return false;
            }

            await winetricksRequest.body?.pipeTo(
                (await Deno.open(winetricksBinaryCache, {
                    write: true,
                    create: true,
                })).writable,
            );

            // Download the verbs.
            const [winetricksVerbsRequest, verbsError] = await fetch(
                WINETRICKS_VERBS_DOWNLOAD_URL,
            )
                .then((response) => [response, null] as [Response, null])
                .catch((e) => [null, e] as [null, unknown]);

            if (winetricksVerbsRequest === null) {
                logger.error(
                    'Failed to download Winetricks verbs. %s',
                    verbsError instanceof Error
                        ? verbsError.message
                        : String(verbsError),
                );
                return false;
            }

            await winetricksVerbsRequest.body?.pipeTo(
                (await Deno.open(winetricksVerbsCache, {
                    write: true,
                    create: true,
                })).writable,
            );
        }

        // Read the verbs.
        const verbs = await Deno.readTextFile(winetricksVerbsCache);
        const parsed = await parseVerbs(verbs);

        // Copy the verbs and binary.
        await pathCreate(winetricksPath);
        await Deno.writeTextFile(
            path.join(winetricksPath, 'verbs.json'),
            JSON.stringify(parsed),
        );
        await Deno.writeTextFile(
            path.join(winetricksPath, 'winetricks'),
            await Deno.readTextFile(winetricksBinaryCache),
        );

        // Make the binary executable.
        await Deno.chmod(path.join(winetricksPath, 'winetricks'), 0o755);
    }

    if (
        settings.features.includes('standard-libraries') ||
        settings.features.includes('gstreamer-libraries')
    ) {
        // Get the prefixes.
        const gstreamerPath = await getBrewPrefixOf('gstreamer');
        const brewPrefix = await getBrewPrefix();
        if (gstreamerPath === null) {
            logger.error('Failed to get the gstreamer path from brew.');
            return false;
        }
        if (brewPrefix === null) {
            logger.error('Failed to get the brew prefix.');
            return false;
        }

        const gstreamerEnabled = settings.features.includes(
            'gstreamer-libraries',
        );
        const standardEnabled = settings.features.includes(
            'standard-libraries',
        );

        // There are too many logs so I thought it would be better to create a log file.
        const logPipe = await LogPipe.context('package-libs');
        const file = await logPipe.getPipe();
        const writer = file.getWriter();
        const log = (data: string) => {
            writer.write(new TextEncoder().encode(data + '\n'));
        };

        // Get all the dependencies.
        const allDeps = new Set<string>();
        const allSearched = new Set<string>();
        for (const lib of packages.libraries) {
            if (lib.type === 'gstreamer' && !gstreamerEnabled) continue;
            if (lib.type === 'brew' && !standardEnabled) continue;

            const pathData = lib.type === 'gstreamer'
                ? path.join(
                    gstreamerPath,
                    'lib',
                    'gstreamer-1.0',
                    lib.library + '.dylib',
                )
                : path.join(brewPrefix, 'lib', lib.library + '.dylib');

            const dependencies = await getDependencies(
                pathData,
                brewPrefix,
                allDeps,
                allSearched,
                log,
            );
            for (const dep of dependencies.dependencies) {
                allDeps.add(path.normalize(dep));
            }
            for (const search of dependencies.searched) {
                allSearched.add(path.normalize(search));
            }
        }

        // Copy the dependencies.
        logger.info('Copying dependencies.');
        const gstreamerLibs = path.join(winePath, 'lib', 'gstreamer-1.0');
        const wineLibs = path.join(winePath, 'lib');
        const items = Array.from(allDeps);
        for (const item of items) {
            const isGstreamer = item.includes('/gstreamer-1.0/');
            const dest = isGstreamer ? gstreamerLibs : wineLibs;
            const loaderPath = isGstreamer
                ? '@loader_path/../'
                : '@loader_path/';

            log('[buildPackage] Copying ' + item + ' to ' + dest);

            // Copy the file.
            const destPath = path.join(dest, path.basename(item));
            await pathCreate(destPath.slice(0, destPath.lastIndexOf('/')));
            // To avoid copying permissions, we will use the read and write functions.
            const file = await Deno.open(item, { read: true });
            file.readable.pipeTo(
                (await Deno.open(destPath, { write: true, create: true }))
                    .writable,
            );

            // Update the rpaths.
            await updateRpaths(destPath, loaderPath, log);
        }

        // Copy the gstreamer libs.
        await pathCopy(
            path.join(gstreamerPath, 'lib', 'gstreamer-1.0', 'include'),
            path.join(winePath, 'lib', 'gstreamer-1.0'),
        );

        // Update the GStreamer rpaths.
        await updateRpaths(
            path.join(
                winePath,
                'lib',
                'wine',
                'x86_64-unix',
                'winegstreamer.dll.so',
            ),
            '@rpath/',
            log,
        );

        // Close the file.
        await writer.close();

        logger.info('Finished copying dependencies.');
    }

    // Final JSON file.
    const jsonFile = path.join(packageRoot, 'package.json');

    const packageData = {
        metadata: {
            buildDate: new Date().toISOString(),
            wineVersion: semver.format(wineVersion),
            version: settings.version,
        },
        package: {
            wine: {
                wine: path.relative(
                    packageRoot,
                    path.join(winePath, 'bin', 'wine64'),
                ),
                wineserver: path.relative(
                    packageRoot,
                    path.join(winePath, 'bin', 'wineserver'),
                ),
            },
            winetricks: settings.features.includes('winetricks')
                ? {
                    verbs: path.relative(
                        packageRoot,
                        path.join(winetricksPath, 'verbs.json'),
                    ),
                    binary: path.relative(
                        packageRoot,
                        path.join(winetricksPath, 'winetricks'),
                    ),
                }
                : null,
            directXVulkan: settings.features.includes('directx-vulkan')
                ? {
                    bits32: (await pathList(path.join(dxvkPath, 'x32'), true))
                        .filter((item) => item.isFile)
                        .map((item) =>
                            path.relative(
                                packageRoot,
                                path.join(dxvkPath, 'x32', item.path),
                            )
                        ),
                    bits64: (await pathList(path.join(dxvkPath, 'x64'), true))
                        .filter((item) => item.isFile)
                        .map((item) =>
                            path.relative(
                                packageRoot,
                                path.join(dxvkPath, 'x64', item.path),
                            )
                        ),
                }
                : null,
        },
    };

    await Deno.writeTextFile(jsonFile, JSON.stringify(packageData));

    // Create the tarball.
    logger.info('Creating the tarball.');
    if (!await createTarball(packageRoot, packageRootTarXz)) {
        logger.error('Failed to create the tarball.');
        return false;
    }

    return true;
};
