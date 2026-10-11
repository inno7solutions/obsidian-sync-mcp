/**
 * Per-vault write access. A registry grant resolves to one `Access` value per
 * (user, vault); the tool layer checks every written path against it.
 */

import { isPathWritable } from "./write-scope.js";

/**
 * Effective write access for one caller in one vault.
 * - `writeFolders === null`  → writes anywhere (within the vault's own path rules)
 * - `writeFolders === []`    → nothing is writable (equivalent to read-only)
 * - `writeFolders === [...]` → writes only inside those folders
 */
export interface Access {
    readOnly: boolean;
    writeFolders: string[] | null;
}

/** True when `path` is writable under this access. */
export function isWritable(access: Access, path: string): boolean {
    if (access.readOnly) return false;
    if (access.writeFolders !== null && access.writeFolders.length === 0) return false;
    return isPathWritable(path, access.writeFolders);
}

/** Short human-readable description of an access value, for denial messages. */
export function describeAccess(access: Access): string {
    if (access.readOnly || (access.writeFolders !== null && access.writeFolders.length === 0)) return "read-only";
    if (access.writeFolders === null) return "the whole vault";
    return access.writeFolders.map((f) => f + "/").join(", ");
}
