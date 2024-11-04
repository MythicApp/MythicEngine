/**
 * @fileoverview Utilities for working with build roots.
 */

import * as path from '@std/path';
import { pathCreate } from './path.ts';

export class BuildRoot {
    private static instance = new BuildRoot();
    private root: string | null = null;

    /**
     * Singleton instance.
     */
    private constructor() {}

    /**
     * Get the singleton instance.
     */
    public static getInstance(): BuildRoot {
        return this.instance;
    }

    /**
     * Initialize the build root.
     * @param root The root of the build.
     */
    public initialize(root: string): void {
        this.root = root;
    }

    /**
     * Get the root of the build.
     */
    public getRoot(): string {
        if (this.root === null) {
            throw new ReferenceError('BuildRoot has not been initialized.');
        }

        return this.root;
    }

    /**
     * Get the build path for a given build.
     * @param forStage The stage of the build.
     * @param appending The path to append.
     * @param create Whether to create the path.
     * @returns The build path.
     * @throws {ReferenceError} If the build root has not been initialized.
     */
    public async getBuildPath(
        forStage: 'build' | 'install' | 'package' | 'cache',
        appending: string | null = null,
        create = true,
    ): Promise<string> {
        const buildPath = path.join(this.getRoot(), forStage, appending ?? '');

        if (create) {
            await pathCreate(buildPath);
        }

        return buildPath;
    }
}

/**
 * Get the environment variables for a build.
 */
export const getBuildEnvironment = (): Record<string, string> => {
    return {
        'CC': 'clang',
        'CXX': 'clang++',
        'CPATH': '/usr/local/include',
        'LIBRARY_PATH': '/usr/local/lib',
        'CFLAGS': '-O3',
        'CROSSCFLAGS':
            '-O3 -Wno-error=incompatible-pointer-types -Wno-error=int-conversion',
        'LDFLAGS':
            '-Wl,-ld_classic -Wl,-headerpad_max_install_names -Wl,-rpath,@loader_path/../../ -Wl,-rpath,/usr/local/lib',
        'MACOSX_DEPLOYMENT_TARGET': '10.14',
    };
};
