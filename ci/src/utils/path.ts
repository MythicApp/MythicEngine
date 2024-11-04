/**
 * @fileoverview Utilities for working with paths.
 */

import { join, normalize, relative } from '@std/path';

export const pathExists = async (
    pathName: string,
    isDirectory: boolean | null = null,
): Promise<boolean> => {
    try {
        const stat = await Deno.stat(pathName);
        if (isDirectory === null) {
            return true;
        }

        return stat.isDirectory === isDirectory;
    } catch {
        return false;
    }
};

/**
 * Create a path with leading directories.
 * @param pathName The path to create.
 * @returns
 */
export const pathCreate = async (
    pathName: string,
): Promise<void> => {
    const path = normalize(pathName);

    const parts = path.split('/');

    let currentPath = '';
    for (const part of parts) {
        currentPath += part + '/';

        if (!await pathExists(currentPath, true)) {
            Deno.mkdirSync(currentPath);
        }
    }
};

/**
 * List the contents of a directory.
 * @param pathName The path to list.
 * @param recursive Whether to list recursively.
 * @returns The contents of the directory.
 */
export const pathList = async (
    pathName: string,
    recursive = false,
): Promise<
    {
        path: string;
        isFile: boolean;
        isDirectory: boolean;
        isSymlink: boolean;
        mode: number | null;
    }[]
> => {
    const path = normalize(pathName);

    const toCheck = ['/'];
    const results: ({
        path: string;
        isFile: boolean;
        isDirectory: boolean;
        isSymlink: boolean;
        mode: number | null;
    })[] = [];

    while (toCheck.length > 0) {
        const current = toCheck.pop() as string;
        if (!current) continue;
        const fileName = join(path, current);
        const stat = await Deno.lstat(fileName);

        if (stat.isDirectory && recursive) {
            for await (const entry of Deno.readDir(fileName)) {
                toCheck.push(join(current, entry.name));
            }
        }

        results.push({
            path: current,
            isFile: stat.isFile,
            isDirectory: stat.isDirectory,
            isSymlink: stat.isSymlink,
            mode: stat.mode,
        });
    }

    return results;
};

/**
 * Copy a path.
 * @param source The source path.
 * @param target The target path.
 */
export const pathCopy = async (
    source: string,
    target: string,
): Promise<void> => {
    const sourcePath = normalize(source);
    const targetPath = normalize(target);

    const listings = await pathList(sourcePath, true);

    const promisesFile: Promise<void>[] = [];

    // Directories are guaranteed to be first.
    for (const listing of listings) {
        const fileName = join(targetPath, listing.path);
        if (listing.isDirectory) {
            if (await pathExists(fileName, false)) {
                await Deno.remove(fileName);
            }

            await pathCreate(fileName);
        } else if (listing.isSymlink) {
            if (await pathExists(fileName, null)) {
                await Deno.remove(fileName, { recursive: true });
            }

            const link = await Deno.readLink(join(sourcePath, listing.path));

            // If starting with the source path, replace it with the target path.
            const linkPath = normalize(link).startsWith(sourcePath)
                ? relative(
                    listing.path,
                    normalize(link).substring(sourcePath.length),
                )
                : link;

            await Deno.symlink(linkPath, fileName);
        } else {
            if (await pathExists(fileName, null)) {
                await Deno.remove(fileName);
            }
            promisesFile.push((async () => {
                await Deno.copyFile(join(sourcePath, listing.path), fileName);
                if (listing.mode !== null) {
                    await Deno.chmod(fileName, listing.mode);
                }
            })());
        }
    }

    await Promise.all(promisesFile);
};

export const pathCWDIfNotAbsolute = (
    pathName: string,
): string => {
    return pathName.startsWith('/') ? pathName : join(Deno.cwd(), pathName);
};
