import type { environmentCheckType } from './main.ts';
import type { buildPackageFeatureType } from './main.ts';
import packages from './packages.ts';
import { Logging } from './utils/logging.ts';

/**
 * Get the prefix of a brew package.
 * @param name The name of the package.
 * @returns The prefix of the package, or null if there is an error or the package is not found.
 */
export const getBrewPrefixOf = async (name: string): Promise<string | null> => {
    const logger = Logging.context('getBrewPrefix');
    logger.debug('Getting brew prefix of %s.', name);

    const command = new Deno.Command('brew', {
        args: ['--prefix', name],
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    return new TextDecoder().decode(stdout).trim();
};

/**
 * Get the brew prefix.
 * @returns The brew prefix, or null if there is an error.
 */
export const getBrewPrefix = async (): Promise<string | null> => {
    const logger = Logging.context('getBrewPrefix');
    logger.debug('Getting brew prefix.');

    const command = new Deno.Command('brew', {
        args: ['--prefix'],
    });
    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    return new TextDecoder().decode(stdout).trim();
};

/**
 * Get the version of the installed xcode.
 * @returns The version of Xcode, or null if Xcode is not installed.
 */
export const getXcodeVersion = async (): Promise<number | null> => {
    const logger = Logging.context('getXcodeVersion');
    logger.debug('Checking Xcode version.');

    const command = new Deno.Command('xcodebuild', {
        args: ['-version'],
    });

    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    // Use a regex to extract the version from the output.
    const version = new TextDecoder().decode(stdout).trim();
    const match = version.match(/Xcode (.+)/);
    if (!match) {
        return null;
    }
    const versionNumber = parseFloat(match[1]);

    return isNaN(versionNumber) ? null : versionNumber;
};

/**
 * Get the version of the installed bison.
 * @returns The version of Bison, or null if Bison is not installed.
 */
export const getBisonVersion = async (): Promise<string | null> => {
    const logger = Logging.context('getBisonVersion');
    logger.debug('Checking Bison version.');

    const command = new Deno.Command('bison', {
        args: ['--version'],
    });

    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    const version = new TextDecoder().decode(stdout).trim();
    const match = version.match(/bison(?: \(GNU Bison\))? (.+)/);
    if (!match) return null;

    return match[1];
};

/**
 * Get the LLVM path.
 * @returns The path to LLVM, or null if LLVM is not installed.
 */
export const getLLVMPath = async (): Promise<string | null> => {
    const logger = Logging.context('getLLVMPath');
    logger.debug('Getting LLVM path.');

    const command = new Deno.Command('which', {
        args: ['clang'],
    });

    const { code, stdout } = await command.output();
    if (code !== 0) return null;

    return new TextDecoder().decode(stdout).trim();
};

/**
 * Get the type of the CPU architecture.
 * @returns The type of the CPU architecture or null if there is an error.
 */
export const getCPUArch = async (): Promise<string | null> => {
    const logger = Logging.context('checkArch');
    logger.debug('Checking CPU architecture.');

    const command = new Deno.Command('uname', {
        args: ['-m'],
    });

    const { code, stdout } = await command.output();
    if (code !== 0) {
        return null;
    }

    return new TextDecoder().decode(stdout).trim();
};

/**
 * Get the cpu count.
 * @returns The number of CPUs, or 1 if the number of CPUs cannot be determined.
 */
export const getCPUCount = async (): Promise<number> => {
    const logger = Logging.context('getCPUCount');
    logger.debug('Getting the number of CPUs.');

    const command = new Deno.Command('sysctl', {
        args: ['-n', 'hw.ncpu'],
    });

    const { code, stdout } = await command.output();

    if (code !== 0) {
        return 1;
    }

    const int = parseInt(new TextDecoder().decode(stdout).trim(), 10);
    return Math.max(isNaN(int) ? 1 : int, 1);
};

/**
 * Preform checks
 * @param skipedChecks The checks to skip.
 * @returns Whether the checks were successful.
 */
export const preformChecks = async (
    skipedChecks: (typeof environmentCheckType)['allowedValues'],
): Promise<boolean> => {
    const logger = Logging.context('preformChecks');

    // Get the CPU architecture.
    const cpuArch = await getCPUArch();
    const currentCPUArchMessage =
        'The current CPU architecture is %s. Did you mean to run this through Rosetta?';
    if (cpuArch !== 'x86_64') {
        if (!skipedChecks.includes('cpuArchitecture')) {
            logger.error(currentCPUArchMessage, cpuArch);
            logger.info(
                'Help: Run `arch -x86_64 $SHELL` to start a new shell in Rosetta or ' +
                    'use \`--skip-environment-check cpuArchitecture\` to skip this check.',
            );
            return false;
        }
        logger.warning(currentCPUArchMessage, cpuArch);
    }

    // Chceck the brew prefix.
    const brewPrefix = await getBrewPrefix();
    const brewPrefixMessage =
        'The brew prefix %s is not an intel prefix. Did you mean to run this through Rosetta?';
    if (brewPrefix !== '/usr/local') {
        if (!skipedChecks.includes('brewPath')) {
            logger.error(brewPrefixMessage, brewPrefix);
            logger.info(
                'Help: Run `eval "$(/usr/local/bin/brew shellenv)"` to run brew through Rosetta or use ' +
                    '`--skip-environment-check brewPrefix` to skip this check.',
            );
            return false;
        }
        logger.warning(brewPrefixMessage, brewPrefix);
    }

    // Get the xcode version.
    const xcodeVersion = await getXcodeVersion();
    const xcodeVersionMessage =
        'The current Xcode version is %s, which is not known to build properly. ' +
        'Did you mean to switch to a version between 12.0 and 15.2?';
    if (xcodeVersion === null || xcodeVersion < 12.0) {
        if (!skipedChecks.includes('xcodeVersion')) {
            logger.error(xcodeVersionMessage, xcodeVersion ?? 'unknown');
            logger.info(
                'Help: Use Xcode 12.0 or later or use `--skip-environment-check xcodeVersion` ' +
                    'to skip this check.',
            );
            return false;
        }
        logger.warning(xcodeVersionMessage, xcodeVersion ?? 'unknown');
    }

    // Get the bison version.
    const bisonVersion = await getBisonVersion();
    const bisonVersionMessage =
        'The current Bison version is %s, which is not known to build properly. ' +
        'Did you forget to install or add Bison to the PATH?';
    if (bisonVersion === null || !bisonVersion.startsWith('3.')) {
        if (!skipedChecks.includes('bisonVersion')) {
            logger.error(bisonVersionMessage, bisonVersion ?? 'unknown');
            logger.info(
                'Help: Run \`brew install bison\` to install Bison or use ' +
                    '`--skip-environment-check bisonVersion` to skip this check.',
            );
            return false;
        }
        logger.warning(bisonVersionMessage, bisonVersion ?? 'unknown');
    }

    // Get the LLVM path.
    const llvmPath = await getLLVMPath();
    const llvmPathMessage =
        'The current clang path is %s, which is not known to be cx-llvm. ' +
        'Did you forget to install or add clang to the PATH?';
    if (llvmPath === null || !llvmPath.includes('cx-llvm')) {
        if (!skipedChecks.includes('clangPath')) {
            logger.error(llvmPathMessage, llvmPath ?? 'unknown');
            logger.info(
                'Help: Run `export PATH=$(brew --prefix cx-llvm)/bin:$PATH` to install cx-llvm or use ' +
                    '`--skip-environment-check llvmPath` to skip this check.',
            );
            return false;
        }
        logger.warning(llvmPathMessage, llvmPath ?? 'unknown');
    }

    // Check the libraries.
    const missingLibraries = [];
    for (const pkg of packages.libraries) {
        if (pkg.type === 'gstreamer') continue;
        if (await getBrewPrefixOf(pkg.package) === null) {
            missingLibraries.push(pkg);
        }
    }
    for (const pkg of packages.tools) {
        if (await getBrewPrefixOf(pkg.package) === null) {
            missingLibraries.push(pkg);
        }
    }
    const missingLibrariesMessage = 'The following packages are missing: %s.';
    if (missingLibraries.length > 0) {
        if (!skipedChecks.includes('installedPackages')) {
            logger.error(
                missingLibrariesMessage,
                missingLibraries.map((pkg) => pkg.package).join(', '),
            );
            logger.info(
                'Help: Use `--skip-environment-check missingPackages` to skip this check.',
            );
            return false;
        }
        logger.warning(
            missingLibrariesMessage,
            missingLibraries.map((pkg) => pkg.package).join(', '),
        );
    }

    return true;
};
