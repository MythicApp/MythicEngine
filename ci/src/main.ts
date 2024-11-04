/**
 * @fileoverview CLI entrypoint.
 */

import { parse } from '@std/semver';
import * as path from '@std/path';
import { type ArgumentValue, Command, EnumType } from '@cliffy/command';
import { z } from 'zod';
import { env } from './utils/env.ts';
import { Logging } from './utils/logging.ts';
import { BuildRoot } from './utils/buildRoot.ts';
import { LogPipe } from './utils/logPipe.ts';
import { buildConfigure } from './build/configure.ts';
import { pathCreate, pathCWDIfNotAbsolute, pathExists } from './utils/path.ts';
import { preformChecks } from './checks.ts';
import packages from './packages.ts';
import { buildCompile } from './build/compile.ts';
import { buildInstall } from './build/install.ts';
import { buildPackage } from './build/package.ts';
import { BRANCHES, buildDistribute } from './build/disribute.ts';
import { S3Data } from './utils/s3Data.ts';
import { ReleaseInfo } from './build/disribute.ts';

export const logLevelType = new EnumType(['debug', 'info', 'warning', 'error']);
export const environmentCheckType = new EnumType([
    'cpuArchitecture',
    'brewPath',
    'xcodeVersion',
    'bisonVersion',
    'clangPath',
    'installedPackages',
]);
export const miscListPackagesPackageType = new EnumType(['tools', 'libraries']);
export const miscCreateDistributionBranchType = new EnumType(BRANCHES);
export const miscCreateDistributionUpdatePriorityType = new EnumType([
    'low',
    'medium',
    'high',
]);
export const miscAddDistributionPackageTargetOperatingSystemType = new EnumType(
    ['macOS'],
);
export const miscAddDistributionPackageTargetArchitectureType = new EnumType([
    'x86_64',
    'arm64',
]);
export const buildConfigureTargetType = new EnumType(['wine64', 'wine32on64']);
export const buildConfigureModeType = new EnumType(['release', 'debug']);
export const buildPackageFeatureType = new EnumType([
    'game-porting-toolkit',
    'directx-vulkan',
    'wine-mono',
    'gstreamer-libraries',
    'standard-libraries',
    'winetricks',
]);
const semverType = ({ label, name, value }: ArgumentValue): string => {
    try {
        parse(value);
    } catch (error) {
        throw new Error(
            `${label} ${name} must be a valid semver version, got "${value}" instead: ${
                (error as TypeError).message
            }`,
        );
    }
    return value;
};
const alphaNumericSymbolType = (
    { label, name, value }: ArgumentValue,
): string => {
    const alphaNumericSymbols =
        'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
    if (value.split('').some((char) => !alphaNumericSymbols.includes(char))) {
        throw new Error(
            `${label} ${name} must be an alphanumeric (including - and _) string, got "${value}" instead.`,
        );
    }
    return value;
};

declare module '@cliffy/command' {
    /**
     * Inline transformations for Command. Maybe the a pipe operator would be useful. 🤔
     */
    interface Command {
        inlineTransform(transform: (command: Command) => void): this;
    }
}

Command.prototype.inlineTransform = function (
    transform: (command: Command) => void,
): Command {
    transform(this);
    return this;
};

/**
 * Get the dirName of the script.
 */
const getDirName = (): string => {
    const fileName = new URL(import.meta.url).pathname;
    return path.dirname(fileName);
};

/**
 * Get the wine root.
 */
const getWineRoot = (): string => {
    const dirName = getDirName();
    return path.join(dirName, '..', '..');
};

/**
 * Setup the logger.
 * @param logLevel The log level.
 */
const setupLogger = (logLevel: string | undefined): void => {
    if (env.logLevel) Logging.overrideLogLevel(env.logLevel);
    if (logLevel) Logging.overrideLogLevel(logLevel);
};

/**
 * Setup the build root and logs.
 * @param buildRoot The build root.
 * @param buildLogs The build logs.
 */
const setupBuildRootAndLogs = async (
    opts: unknown,
): Promise<boolean> => {
    const buildRoot = (opts as { buildRoot: string | undefined }).buildRoot;
    const buildLogs =
        (opts as { buildLogs: true | string | undefined }).buildLogs;
    const skipEnvironmentCheck = (opts as {
        skipEnvironmentCheck:
            | (typeof environmentCheckType)['allowedValues']
            | undefined;
    }).skipEnvironmentCheck;
    // Default build root and logs.
    const defaultBuildRoot = path.normalize(
        path.join(getDirName(), '..', '.build'),
    );
    const defaultBuildLogs = path.normalize(
        path.join(getDirName(), '..', '.logs'),
    );

    // Set the build root.
    const buildRootPath = buildRoot
        ? path.normalize(pathCWDIfNotAbsolute(buildRoot))
        : defaultBuildRoot;
    BuildRoot.getInstance().initialize(buildRootPath);

    // Create the build root.
    await pathCreate(buildRootPath);

    // Set the build logs.
    if (buildLogs === 'stdout') {
        LogPipe.setLogPipeStdout();
    } else if (buildLogs === true) {
        LogPipe.setLogPipeDirectory(defaultBuildLogs);
    } else if (typeof buildLogs === 'string') {
        LogPipe.setLogPipeDirectory(
            path.normalize(pathCWDIfNotAbsolute(buildLogs)),
        );
    }

    // Set the environment check.
    const environmentCheck = path.join(buildRootPath, '.environment-check');
    if (!await pathExists(environmentCheck)) {
        if (!await preformChecks(skipEnvironmentCheck ?? [])) {
            return false;
        }
        await Deno.writeTextFile(environmentCheck, '');
    }

    return true;
};

/**
 * Main entrypoint for the CLI.
 */
export const ignite = async (args: string[]): Promise<void> => {
    const program = new Command()
        .name('ci')
        .version('0.1.0')
        .description('Command line framework to abstract wine building.')
        .type('logLevel', logLevelType)
        .globalOption('--log-level <level:logLevel>', 'Set the log level.')
        .globalAction((opts) => setupLogger(opts.logLevel));

    // List the packages.
    const miscGroup = program.group('Miscellaneous');
    miscGroup
        .command('list-packages')
        .description('List the packages to download.')
        .type('package', miscListPackagesPackageType)
        .arguments('<package:package>')
        .action((_, checkPackages) => {
            if (checkPackages === 'tools') {
                for (const tool of packages.tools) {
                    console.log(tool.package);
                }
            } else if (checkPackages === 'libraries') {
                for (const library of packages.libraries) {
                    if (library.type === 'gstreamer') continue;
                    console.log(library.package);
                }
            }
        });
    miscGroup
        .command('create-distribution')
        .description('Create a distribution and return a UUID.')
        .type('branch', miscCreateDistributionBranchType)
        .type('semver', semverType)
        .type('priorities', miscCreateDistributionUpdatePriorityType)
        .option(
            '--uuid <uuid:string>',
            'The UUID of the distribution. If provided, the any distribution with the same UUID will be overwritten.',
        )
        .option(
            '--branch <branch:branch>',
            'The branch to create the distribution on.',
            { required: true },
        )
        .option('--name <name:string>', 'The name of the distribution.')
        .option(
            '--description <description:string>',
            'The description of the distribution.',
        )
        .option(
            '--version <version:semver>',
            'The version of the distribution.',
            { required: true },
        )
        .option(
            '--update-priority <priority:priorities>',
            'The priority of the distribution.',
            { default: 'low' },
        )
        .option(
            '--description-file <file:string>',
            'The path to the file containing the description.',
            { conflicts: ['name', 'description'] },
        )
        .action(async (opts) => {
            const logger = Logging.context('createDistribution');
            logger.debug('Creating a distribution.');

            // Create S3 client.
            const s3 = S3Data.getInstance();
            if (!s3) {
                logger.error('Failed to create S3 client.');
                return 1;
            }

            // Create the localizations file.
            let releaseInfo: z.infer<typeof ReleaseInfo> | null = null;
            if (opts.descriptionFile !== undefined) {
                const localizationsFile = path.normalize(
                    pathCWDIfNotAbsolute(opts.descriptionFile),
                );
                if (!await pathExists(localizationsFile, true)) {
                    logger.error('The localizations file does not exist.');
                    return 1;
                }

                // Parse the localizations file.
                const localizations = await Deno.readTextFile(
                    localizationsFile,
                );

                let unknownJSON: unknown;
                try {
                    unknownJSON = JSON.parse(localizations);
                } catch {
                    logger.error('Failed to parse the localizations file.');
                    return 1;
                }

                const releaseInfoResult = await ReleaseInfo.safeParseAsync(
                    unknownJSON,
                );
                if (!releaseInfoResult.success) {
                    logger.error('Failed to parse the localizations file.');
                    return 1;
                }

                releaseInfo = releaseInfoResult.data;
            } else if (
                opts.name !== undefined && opts.description !== undefined
            ) {
                releaseInfo = {
                    default: {
                        name: opts.name,
                        description: opts.description,
                    },
                    localized: {},
                };
            } else {
                logger.error(
                    'No localizations file or name and description provided.',
                );
                return 1;
            }
            if (releaseInfo === null) {
                logger.error('Failed to create the localizations file.');
                return 1;
            }

            // Get the current versions.json
            const versionsDataOrNull = await buildDistribute.getVersions(
                s3,
                opts.branch,
            );
            if (versionsDataOrNull === 'error') {
                logger.error('Failed to get versions.json.');
                return 1;
            }
            const versionsData = versionsDataOrNull === 'not-found'
                ? {
                    artifacts: {},
                    versions: {},
                }
                : versionsDataOrNull;

            // Create the artifact.
            const artifact = await buildDistribute.createArtifact(
                s3,
                opts.branch,
                new TextEncoder().encode(JSON.stringify(releaseInfo)),
            );
            if (artifact === null) {
                logger.error('Failed to create the artifact.');
                return 1;
            }

            // Add the artifact to the versions.json
            const versionUUID = opts.uuid ?? crypto.randomUUID();
            versionsData.artifacts[artifact.id] = artifact;
            versionsData.versions[versionUUID] = {
                id: versionUUID,
                version: opts.version,
                updatePriority: opts.updatePriority,
                publishDate: new Date().toISOString(),
                releaseInfo: artifact.id,
                builds: [],
            };

            // Remove obsolete artifacts.
            const newVersions = buildDistribute.removeObsolete(versionsData);
            if (
                !await buildDistribute.cleanArtifacts(
                    s3,
                    opts.branch,
                    newVersions,
                )
            ) return 1;

            // Upload the new versions.json
            if (
                !await buildDistribute.uploadVersions(
                    s3,
                    opts.branch,
                    newVersions,
                )
            ) return 1;

            // Return the UUID.
            console.log(versionUUID);

            return 0;
        });

    miscGroup
        .command('add-distribution-package')
        .description('Add a package to a distribution.')
        .type(
            'targetOperatingSystem',
            miscAddDistributionPackageTargetOperatingSystemType,
        )
        .type(
            'targetArchitecture',
            miscAddDistributionPackageTargetArchitectureType,
        )
        .type('branch', miscCreateDistributionBranchType)
        .option('--uuid <uuid:string>', 'The UUID of the distribution.', {
            required: true,
        })
        .option('--branch <branch:branch>', 'The branch of the distribution.', {
            required: true,
        })
        .option('--package <package:string>', 'The package to add.', {
            required: true,
        })
        .option(
            '--public-key <publicKey:string>',
            'The path to the public key for the package.',
            { required: true },
        )
        .option(
            '--private-key <privateKey:string>',
            'The path to the private key for the package.',
            { required: true },
        )
        .option(
            '--target-operating-system <targetOperatingSystem:targetOperatingSystem>',
            'The target operating system.',
            { required: true },
        )
        .option(
            '--target-architecture <targetArchitecture:targetArchitecture>',
            'The target architecture.',
            { required: true },
        )
        .action(async (opts) => {
            const logger = Logging.context('addDistributionPackage');
            logger.debug('Adding a package to a distribution.');

            // Parse the keys.
            let publicKeyData: Uint8Array;
            try {
                publicKeyData = await Deno.readFile(
                    pathCWDIfNotAbsolute(opts.publicKey),
                );
            } catch {
                logger.error('Failed to read the public key.');
                return 1;
            }
            let privateKeyData: Uint8Array;
            try {
                privateKeyData = await Deno.readFile(
                    pathCWDIfNotAbsolute(opts.privateKey),
                );
            } catch {
                logger.error('Failed to read the private key.');
                return 1;
            }
            const publicKey = await buildDistribute.parseSPKIEd25519(
                publicKeyData,
            );
            if (publicKey === null) {
                logger.error('Failed to parse the public key.');
                return 1;
            }
            const privateKey = await buildDistribute.parsePKCS8Ed25519(
                privateKeyData,
            );
            if (privateKey === null) {
                logger.error('Failed to parse the private key.');
                return 1;
            }

            // Get the tar ball.
            const buffer = await Deno.readFile(
                pathCWDIfNotAbsolute(opts.package),
            );

            // Create S3 client.
            const s3 = S3Data.getInstance();
            if (!s3) {
                logger.error('Failed to create S3 client.');
                return 1;
            }

            // Get the current versions.json
            const versionsDataOrNull = await buildDistribute.getVersions(
                s3,
                opts.branch,
            );
            if (versionsDataOrNull === 'error') {
                logger.error('Failed to get versions.json.');
                return 1;
            }
            const versionsData = versionsDataOrNull === 'not-found'
                ? {
                    artifacts: {},
                    versions: {},
                }
                : versionsDataOrNull;

            // Get the distribution.
            const distribution = versionsData.versions[opts.uuid];
            if (distribution === undefined) {
                logger.error('The distribution does not exist.');
                return 1;
            }

            // Create the package.
            const packageData = await buildDistribute.createBuildArtifact(
                s3,
                opts.branch,
                {
                    operatingSystem: opts.targetOperatingSystem,
                    architecture: opts.targetArchitecture,
                    publicKey,
                    privateKey,
                    artifact: buffer,
                },
            );

            if (packageData === null) {
                logger.error('Failed to create the package.');
                return 1;
            }

            // Add the package to the distribution.
            distribution.builds.push(packageData.build);
            versionsData.artifacts[packageData.artifact.id] =
                packageData.artifact;

            // Upload the new versions.json
            if (
                !await buildDistribute.uploadVersions(
                    s3,
                    opts.branch,
                    versionsData,
                )
            ) return 1;

            return 0;
        });

    // Build the project.
    const buildGroup = program.group('Build');
    const addBuildMetadata = (command: Command) => {
        command
            .globalOption(
                '--build-logs [directory:string]',
                'Set the directory for build logs. (magic values: "stdout")',
            )
            .globalOption(
                '--build-root <directory:string>',
                'Set the directory for the build.',
            )
            .type('environmentCheck', environmentCheckType)
            .globalOption(
                '--skip-environment-check <checks:environmentCheck[]>',
                'Skip the environment check.',
                { separator: ',' },
            );
    };
    buildGroup
        .command('configure')
        .description('Configure the project with automake.')
        .type('configure', buildConfigureTargetType)
        .type('mode', buildConfigureModeType)
        .type('alphaNumericSymbol', alphaNumericSymbolType)
        .option(
            '--build-name <name:alphaNumericSymbol>',
            'The name of the build.',
            { required: true },
        )
        .option(
            '--target <target:configure[]>',
            'The mode to configure the project.',
            { required: true, separator: ',' },
        )
        .option('--mode <mode:mode>', 'The mode to configure the project.', {
            required: true,
        })
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            if (opts.target.includes('wine64')) {
                const result = await buildConfigure(getWineRoot(), {
                    name: opts.buildName,
                    mode: 'wine64',
                    wineDebug: opts.mode === 'debug',
                });

                if (!result) return 1;
            }

            if (opts.target.includes('wine32on64')) {
                const result = await buildConfigure(getWineRoot(), {
                    name: opts.buildName,
                    mode: 'wine32on64',
                    wineDebug: opts.mode === 'debug',
                });

                if (!result) return 1;
            }

            return 0;
        });
    buildGroup
        .command('build')
        .description('Build the project with make.')
        .type('configure', buildConfigureTargetType)
        .type('alphaNumericSymbol', alphaNumericSymbolType)
        .option(
            '--build-name <name:alphaNumericSymbol>',
            'The name of the build.',
            { required: true },
        )
        .option(
            '--target <target:configure[]>',
            'The mode to build the project.',
            { required: true, separator: ',' },
        )
        .option(
            '--threads <threads:number>',
            'The number of threads to use for building. Defaults to the number of CPUs available.',
        )
        .option('--skip-configure-check', 'Skip the configure check.')
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            const cpuCount = opts.threads ?? null;

            if (opts.target.includes('wine64')) {
                const result = await buildCompile({
                    configureCheck: !opts.skipConfigureCheck,
                    name: opts.buildName,
                    mode: 'wine64',
                    threads: cpuCount,
                });

                if (!result) return 1;
            }

            if (opts.target.includes('wine32on64')) {
                const result = await buildCompile({
                    configureCheck: !opts.skipConfigureCheck,
                    name: opts.buildName,
                    mode: 'wine32on64',
                    threads: cpuCount,
                });

                if (!result) return 1;
            }

            return 0;
        });
    buildGroup
        .command('install')
        .description('Install the project with make.')
        .type('configure', buildConfigureTargetType)
        .type('alphaNumericSymbol', alphaNumericSymbolType)
        .option(
            '--build-name <name:alphaNumericSymbol>',
            'The name of the build.',
            { required: true },
        )
        .option(
            '--install-name <name:alphaNumericSymbol>',
            'The name of the installation.',
            { required: true },
        )
        .option(
            '--target <targets:configure[]>',
            'The mode to install the project.',
            { required: true, separator: ',' },
        )
        .option('--skip-build-check', 'Skip the build check.')
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            if (opts.target.includes('wine64')) {
                const result = await buildInstall({
                    installName: opts.installName,
                    buildName: opts.buildName,
                    mode: 'wine64',
                    skipBuildCheck: opts.skipBuildCheck ?? false,
                });

                if (!result) return 1;
            }

            if (opts.target.includes('wine32on64')) {
                const result = await buildInstall({
                    installName: opts.installName,
                    buildName: opts.buildName,
                    mode: 'wine32on64',
                    skipBuildCheck: opts.skipBuildCheck ?? false,
                });

                if (!result) return 1;
            }

            return 0;
        });
    buildGroup
        .command('package')
        .description('Package the project.')
        .type('feature', buildPackageFeatureType)
        .type('semver', semverType)
        .type('alphaNumericSymbol', alphaNumericSymbolType)
        .option('--install-name <name:string>', 'The name of the build.', {
            required: true,
        })
        .option(
            '--package-name <name:alphaNumericSymbol>',
            'The name of the package.',
            { required: true },
        )
        .option('--features <features:feature[]>', 'The features to package.', {
            separator: ',',
            default: [],
        })
        .option('--version <version:semver>', 'The version of the package.', {
            required: true,
        })
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            const result = await buildPackage(getWineRoot(), {
                installName: opts.installName,
                packageName: opts.packageName,
                features: opts.features,
                version: opts.version,
            });

            if (!result) return 1;

            return 0;
        });
    buildGroup
        .command('clean')
        .description('Clean all build artifacts.')
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            // Clean the build artifacts.
            await Deno.remove(BuildRoot.getInstance().getRoot(), {
                recursive: true,
            });

            // Clean the logs.
            const logDir = LogPipe.getLogPipeDirectory();
            if (logDir) {
                await Deno.remove(logDir, { recursive: true });
            }

            return 0;
        });
    buildGroup
        .command('get-path')
        .description('Get the log directory.')
        .type('alphaNumericSymbol', alphaNumericSymbolType)
        .option('--logs', 'Get the log directory.', {
            conflicts: ['package'],
        })
        .option(
            '--package <package:alphaNumericSymbol>',
            'Get the package directory.',
            {
                conflicts: ['logs'],
            },
        )
        .inlineTransform(addBuildMetadata)
        .action(async (opts) => {
            if (!await setupBuildRootAndLogs(opts)) return 1;

            if (opts.logs) {
                const logDir = LogPipe.getLogPipeDirectory();
                if (logDir) {
                    console.log(logDir);
                    return 0;
                }
            } else if (opts.package) {
                const packageDir = path.join(
                    await BuildRoot.getInstance().getBuildPath('package'),
                    opts.package + '.tar.xz',
                );
                console.log(packageDir);
                return 0;
            }
        });

    // Parse the arguments 💥
    await program.parse(args);
};

// Initialize the CLI. 🔥
ignite(Deno.args); // note: Deno.args automatically excludes the first argument (the script name)
