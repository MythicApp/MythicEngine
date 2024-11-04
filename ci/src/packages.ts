import json from './packages.json' with { type: 'json' };

/**
 * A tool required for the build process.
 */
interface Tool {
    name: string;
    package: string;
}

/**
 * A library required for the end product.
 */
interface LibraryNormal {
    library: string;
    type: 'gstreamer';
}

/**
 * A library required for the end product.
 */
interface LibraryBrew {
    library: string;
    package: string;
    type: 'brew';
}

/**
 * A library required for the end product.
 */
type Library = LibraryNormal | LibraryBrew;

export const tools: Tool[] = json.tools as Tool[];
export const libraries: Library[] = json.libraries as Library[];
export default {
    tools,
    libraries,
};
