/**
 * @fileoverview Contains the upload functions for s3.
 */

import * as semver from '@std/semver';
import { crypto } from '@std/crypto';
import * as base64 from '@std/encoding/base64';
import * as hex from '@std/encoding/hex';
import { z } from 'zod';
import { Logging } from '../utils/logging.ts';
import { S3Data } from '../utils/s3Data.ts';
import {
    DeleteObjectsCommand,
    GetObjectCommand,
    ListObjectsV2Command,
    NoSuchKey,
    PutObjectCommand,
} from '@aws-sdk/client-s3';

// Types
const SemVer = z.string().superRefine((value, ctx) => {
    if (!semver.canParse(value)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid semver.',
        });
        return false;
    }
    return true;
});

const ISOLanguageRegionCode = z.string().regex(/^[a-z]{2}_[A-Z]{2}$/);

export const ReleaseInfoData = z.object({
    name: z.string(),
    description: z.string(),
});

const HashingAlgorithm = z.enum(['blake3']);

export const ReleaseInfo = z.object({
    default: ReleaseInfoData,
    localized: z.record(ISOLanguageRegionCode, ReleaseInfoData),
});

const ArtifactId = z.string().uuid();

const Artifact = z.object({
    id: ArtifactId,
    href: z.string(),
    hash: z.object({
        algorithm: HashingAlgorithm,
        value: z.string(),
    }),
    byteCount: z.number(),
});

const BuildOperatingSystem = z.enum(['macOS']);
const BuildArchitecture = z.enum(['x86_64', 'arm64']);
const SignatureAlgorithm = z.enum(['ed25519']);
const UpdatePriority = z.enum(['critical', 'high', 'medium', 'low']);

const Build = z.object({
    operatingSystem: BuildOperatingSystem,
    architecture: BuildArchitecture,
    artifact: ArtifactId,
    signature: z.object({
        algorithm: SignatureAlgorithm,
        publicKey: z.string(),
        value: z.string(),
    }),
});

const Version = z.object({
    id: z.string().uuid(),
    publishDate: z.string().datetime(),
    version: SemVer,
    updatePriority: UpdatePriority,
    releaseInfo: ArtifactId,
    builds: z.array(Build),
});

const Updates = z.object({
    artifacts: z.record(ArtifactId, Artifact),
    versions: z.record(z.string().uuid(), Version),
});

// Constants
const PREFIX = 'wine';
const ARTIFACTS_PREFIX = 'artifacts';
const VERSIONS = 'versions.json';
export const BRANCHES = ['stable', 'development'] as const;
const MAX_VERSION_STORE = 10;

type Branch = typeof BRANCHES[number];

const wrapInCatch = async <T>(
    promise: Promise<T>,
): Promise<[T, null] | [null, Error]> => {
    try {
        return [await promise, null];
    } catch (error) {
        return [
            null,
            error instanceof Error ? error : new Error('Unknown error.'),
        ];
    }
};

/**
 * Create a url path.
 * @param paths The path.
 * @returns The url path.
 */
const createURLPath = (...paths: string[]): string =>
    [
        ...paths,
    ].map((path) => encodeURIComponent(path)).join('/');

/**
 * Parse a url path.
 * @param path The path.
 * @returns The branch and the path.
 */
const parseURLPath = (pathURL: string): string[] => {
    const data = pathURL
        .split('/')
        .map((part) => decodeURIComponent(part));

    // Remove prefix and postfix if they are empty.
    if (data[0] === '') data.shift();
    if (data[data.length - 1] === '') data.pop();

    return data;
};

/**
 * URL path utils.
 */
const URLPath = {
    create: createURLPath,
    createBranch: (branch: Branch, ...paths: string[]) =>
        createURLPath(PREFIX, branch, ...paths),
    parse: parseURLPath,
};

/**
 * Get the versions.
 * @param client The S3 client.
 * @returns The versions or null if an error occurred.
 */
const getVersions = async (
    client: S3Data,
    branch: Branch,
): Promise<z.infer<typeof Updates> | 'not-found' | 'error'> => {
    const logger = Logging.context('getVersions');
    logger.debug('Getting the updates.');

    // Get the versions.
    const versionsPath = URLPath.createBranch(branch, VERSIONS);
    const [response, error] = await wrapInCatch(
        client.client.send(
            new GetObjectCommand({
                Bucket: client.bucket,
                Key: versionsPath,
            }),
        ),
    );

    //
    if (error) {
        if (error instanceof NoSuchKey) return 'not-found';
        logger.error('Failed to get the updates: %s.', error.message);
        return 'error';
    } else if (response.Body === undefined) {
        logger.error('Failed to get the updates. No response.');
        return 'error';
    }

    // Parse the response.
    const body = new TextDecoder().decode(
        await response.Body.transformToByteArray(),
    );
    let updates: unknown;
    try {
        updates = JSON.parse(body);
    } catch (error) {
        logger.error(
            'Failed to parse the updates as JSON: %s.',
            error instanceof Error ? error.message : 'Unknown error.',
        );
        return 'error';
    }

    const parsed = Updates.safeParse(updates);
    if (!parsed.success) {
        logger.error(
            'Failed to parse the updates: %s.',
            parsed.error.toString(),
        );
        return 'error';
    }

    return parsed.data;
};

/**
 * Remove obsolete artifacts and versions.
 * @param updates The updates.
 * @returns The updates without the obsolete artifacts and versions.
 */
const removeObsolete = (
    originalUpdates: z.infer<typeof Updates>,
): z.infer<typeof Updates> => {
    // Clone the updates.
    const updates: z.infer<typeof Updates> = {
        artifacts: {},
        versions: {},
    };
    const artifactIds = new Set(Object.keys(originalUpdates.artifacts));

    // Get all the versions.
    const versionsEntries = Object.entries(originalUpdates.versions)
        .sort((a, b) =>
            semver.compare(
                semver.parse(a[1].version),
                semver.parse(b[1].version),
            )
        ); // This will never fail so long the version is parsed from zod.
    const newVersionsMap = new Map<string, z.infer<typeof Version>>();
    for (let i = 0; i < versionsEntries.length && i < MAX_VERSION_STORE; i++) {
        // Get the version.
        const versionEntry = versionsEntries[i];
        if (!versionEntry) continue;
        const [versionId, version] = versionEntry;

        // The builds.
        const builds: z.infer<typeof Build>[] = [];
        for (const build of versionsEntries[i][1].builds) {
            // Add the build to the artifacts.
            artifactIds.add(build.artifact);

            // Add the build.
            builds.push({
                operatingSystem: build.operatingSystem,
                architecture: build.architecture,
                artifact: build.artifact,
                signature: build.signature,
            });
        }

        // Add the release info.
        artifactIds.add(version.releaseInfo);

        // Add the version.
        newVersionsMap.set(versionId, {
            id: versionId, // Always prefer the map id.
            version: version.version,
            updatePriority: version.updatePriority,
            publishDate: version.publishDate,
            releaseInfo: version.releaseInfo,
            builds,
        });
    }

    // Add the artifacts.
    const newArtifactsMap = new Map<string, z.infer<typeof Artifact>>();
    for (const artifactId of artifactIds) {
        const artifact = originalUpdates.artifacts[artifactId];
        if (!artifact) continue; // This should never happen.
        newArtifactsMap.set(artifactId, {
            id: artifactId, // Always prefer the map id.
            href: artifact.href,
            hash: {
                algorithm: artifact.hash.algorithm,
                value: artifact.hash.value,
            },
            byteCount: artifact.byteCount,
        });
    }

    // Set the new updates.
    updates.artifacts = Object.fromEntries(newArtifactsMap);
    updates.versions = Object.fromEntries(newVersionsMap);

    return updates;
};

/**
 * Clean up unused artifacts.
 * @param client The S3 client.
 * @param updates The updates.
 */
const cleanArtifacts = async (
    client: S3Data,
    branch: Branch,
    updates: z.infer<typeof Updates>,
): Promise<boolean> => {
    const logger = Logging.context('cleanArtifacts');

    // Get the artifacts.
    const artifactsPath = URLPath.createBranch(branch, ARTIFACTS_PREFIX);
    const [response, error] = await wrapInCatch(
        client.client.send(
            new ListObjectsV2Command({
                Bucket: client.bucket,
                Prefix: artifactsPath,
            }),
        ),
    );

    // Check for errors.
    if (error) {
        logger.error('Failed to list the artifacts: %s.', error.message);
        return false;
    } else if (response.Contents === undefined) {
        logger.error('Failed to list the artifacts. No response.');
        return false;
    }

    // Get the artifacts to be deleted.
    const artifactIds = response.Contents
        .map((content) => content.Key)
        .filter((key) => key !== undefined)
        .filter((key) =>
            !(URLPath.parse(key).pop() ?? '' in updates.artifacts)
        );

    if (artifactIds.length === 0) {
        logger.info('No artifacts to delete.');
        return true;
    }

    // Delete the artifacts.
    const [deleteResponse, deleteError] = await wrapInCatch(
        client.client.send(
            new DeleteObjectsCommand({
                Bucket: client.bucket,
                Delete: {
                    Objects: artifactIds.map((key) => ({ Key: key })),
                },
            }),
        ),
    );

    // Check for errors.
    if (deleteError) {
        logger.error(
            'Failed to delete the artifacts: %s.',
            deleteError.message,
        );
        return false;
    }

    for (const unsuccessful of deleteResponse.Errors ?? []) {
        logger.warning('Failed to delete artifact: %s.', unsuccessful.Key);
    }

    logger.info('Deleted %d artifacts.', artifactIds.length);

    return true;
};

/**
 * Create an artifact.
 * @param client The S3 client.
 * @param branch The branch.
 * @param artifact The artifact's data.
 */
const createArtifact = async (
    client: S3Data,
    branch: Branch,
    artifact: Uint8Array,
): Promise<z.infer<typeof Artifact> | null> => {
    const logger = Logging.context('createArtifact');

    // Get the hash.
    const hash = await crypto.subtle.digest('BLAKE3', artifact);
    const hashValue = hex.encodeHex(new Uint8Array(hash));

    // Get the byte count.
    const byteCount = artifact.byteLength;

    // Create the URL.
    const artifactId = crypto.randomUUID();
    const artifactPath = URLPath.createBranch(
        branch,
        ARTIFACTS_PREFIX,
        artifactId,
    );

    // Upload the artifact.
    const [_, error] = await wrapInCatch(
        client.client.send(
            new PutObjectCommand({
                Bucket: client.bucket,
                Key: artifactPath,
                Body: artifact,
            }),
        ),
    );

    // Check for errors.
    if (error) {
        logger.error('Failed to upload the artifact: %s.', error.message);
        return null;
    }

    // Return the artifact.
    return {
        id: artifactId,
        href: '/' + artifactPath,
        hash: {
            algorithm: 'blake3',
            value: hashValue,
        },
        byteCount,
    };
};

/**
 * Upload a version.json file.
 * @param client The S3 client.
 * @param branch The branch.
 * @param version The version.
 * @returns True if the version was uploaded.
 */
const uploadVersions = async (
    client: S3Data,
    branch: Branch,
    versions: z.infer<typeof Updates>,
): Promise<boolean> => {
    const logger = Logging.context('uploadVersion');

    // Create the version.
    const versionPath = URLPath.createBranch(branch, VERSIONS);

    // Upload the version.
    const [_, error] = await wrapInCatch(
        client.client.send(
            new PutObjectCommand({
                Bucket: client.bucket,
                Key: versionPath,
                Body: JSON.stringify(versions),
            }),
        ),
    );

    // Check for errors.
    if (error) {
        logger.error('Failed to upload the version: %s.', error.message);
        return false;
    }

    logger.info('Uploaded version %s.', versionPath);

    return true;
};

/**
 * Parse a PKCS#8 file with ed25519 data
 * @param data The data.
 * @returns The key data.
 */
const parsePKCS8Ed25519 = async (
    data: Uint8Array,
): Promise<CryptoKey | null> => {
    const START_TAG = '-----BEGIN PRIVATE KEY-----\n';
    const END_TAG = '\n-----END PRIVATE KEY-----';

    // Get the key data.
    const keyData = new TextDecoder().decode(data);
    const keyStart = keyData.indexOf(START_TAG);
    const keyEnd = keyData.indexOf(END_TAG);

    if (keyStart === -1 || keyEnd === -1) {
        return null;
    }

    const key = keyData.substring(keyStart + START_TAG.length, keyEnd);
    const keyBuffer = base64.decodeBase64(key);

    // Import the key.
    try {
        return await crypto.subtle.importKey(
            'pkcs8',
            keyBuffer,
            'Ed25519',
            true,
            ['sign'],
        );
    } catch {
        return null;
    }
};

/**
 * Parse a SPKI file with ed25519 data.
 * @param data The data.
 * @returns The key data.
 */
const parseSPKIEd25519 = async (
    data: Uint8Array,
): Promise<CryptoKey | null> => {
    const START_TAG = '-----BEGIN PUBLIC KEY-----\n';
    const END_TAG = '\n-----END PUBLIC KEY-----';

    // Get the key data.
    const keyData = new TextDecoder().decode(data);
    const keyStart = keyData.indexOf(START_TAG);
    const keyEnd = keyData.indexOf(END_TAG);

    if (keyStart === -1 || keyEnd === -1) {
        console;
        return null;
    }

    const key = keyData.substring(keyStart + START_TAG.length, keyEnd);

    // Parse the key as base64.
    const keyBuffer = base64.decodeBase64(key);

    // Import the key.
    try {
        return await crypto.subtle.importKey(
            'spki',
            keyBuffer,
            'Ed25519',
            true,
            ['verify'],
        );
    } catch {
        return null;
    }
};

/**
 * Create a build.
 */
const createBuildArtifact = async (
    client: S3Data,
    branch: Branch,
    data: {
        operatingSystem: z.infer<typeof BuildOperatingSystem>;
        architecture: z.infer<typeof BuildArchitecture>;
        artifact: Uint8Array;
        privateKey: CryptoKey;
        publicKey: CryptoKey;
    },
): Promise<
    {
        build: z.infer<typeof Build>;
        artifact: z.infer<typeof Artifact>;
    } | null
> => {
    const logger = Logging.context('createBuildArtifact');

    // Sign the artifact.
    const signature = await crypto.subtle.sign(
        {
            name: 'ed25519',
        },
        data.privateKey,
        data.artifact,
    );

    // Create the artifact.
    const artifact = await createArtifact(client, branch, data.artifact);

    // Check for errors.
    if (artifact === null) {
        logger.error('Failed to create the artifact.');
        return null;
    }

    // Create the build.
    const build: z.infer<typeof Build> = {
        operatingSystem: data.operatingSystem,
        architecture: data.architecture,
        artifact: artifact.id,
        signature: {
            algorithm: 'ed25519',
            publicKey: base64.encodeBase64(
                await crypto.subtle.exportKey('spki', data.publicKey),
            ),
            value: hex.encodeHex(new Uint8Array(signature)),
        },
    };

    return { build, artifact };
};

export const buildDistribute = {
    getVersions,
    cleanArtifacts,
    createArtifact,
    removeObsolete,
    uploadVersions,
    createBuildArtifact,
    parsePKCS8Ed25519,
    parseSPKIEd25519,
};
