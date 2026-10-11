/**
 * Detection of LiveSync's "Obfuscate properties" from document IDs.
 *
 * With obfuscation on, file entries get hashed `_id`s prefixed `f:` instead of
 * path-based IDs, so a sample of IDs reveals which mode the vault actually
 * uses — regardless of what the vault config claims.
 */

export type IdFormat = "obfuscated" | "plain" | "mixed" | "empty";

export function classifyIds(ids: string[]): IdFormat {
    let obfuscated = 0;
    let plain = 0;
    for (const id of ids) {
        if (id.startsWith("f:")) obfuscated++;
        else plain++;
    }
    if (obfuscated === 0 && plain === 0) return "empty";
    if (obfuscated > 0 && plain > 0) return "mixed";
    return obfuscated > 0 ? "obfuscated" : "plain";
}
