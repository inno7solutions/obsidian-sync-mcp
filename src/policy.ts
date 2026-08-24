/**
 * Per-caller write authorization (Phase 2).
 *
 * Phase 1 puts an identity ({sub, email, groups}) on every session. This maps
 * that identity to what the caller may write, via a small JSON policy in the
 * POLICY env var, and combines it with the process-wide READ_ONLY / WRITE_FOLDERS
 * ceiling. The result is one `Access` value per request that the tool layer
 * enforces — both by hiding write tools from readers (fastmcp `canAccess`) and
 * by checking each path (`isPathWritable`).
 *
 * Two invariants:
 *   - The env ceiling can only ever *remove* access, never grant it. Effective
 *     access is the intersection of the ceiling and the caller's policy, so a
 *     locked-down container stays locked down whatever the policy says.
 *   - Default deny. When a policy is configured but no rule matches the caller,
 *     they are read-only. Writing requires a rule that says so.
 *
 * Pure and dependency-light on purpose, so the rules are unit-testable without a
 * server or a live IdP.
 */

import { isPathWritable } from "./write-scope.js";
import type { IdpIdentity } from "./auth-idp.js";
import { isAdminSession } from "./auth-admin.js";

/**
 * Effective write access for one caller.
 * - `writeFolders === null`  → writes anywhere (within the vault's own path rules)
 * - `writeFolders === []`    → nothing is writable (equivalent to read-only)
 * - `writeFolders === [...]` → writes only inside those folders
 */
export interface Access {
    readOnly: boolean;
    writeFolders: string[] | null;
}

/** One POLICY entry: a group (or "*" for everyone) mapped to what it may write. */
export interface AccessRule {
    /** Group/role name to match against the caller's claims, or "*" for a catch-all. */
    group: string;
    /** Read-only for this group. Takes precedence over writeFolders. */
    readOnly?: boolean;
    /** Writable folders: a list, or null for unrestricted. Ignored if readOnly is true. */
    writeFolders?: string[] | null;
}

export const READ_ONLY_ACCESS: Access = { readOnly: true, writeFolders: [] };

/** Strip surrounding slashes and drop empty segments, matching write-scope's normalization. */
function normalizeFolder(f: string): string {
    return f.trim().replace(/^\/+|\/+$/g, "");
}

function normalizeFolders(raw: unknown): string[] | null {
    if (raw === null) return null; // explicit "unrestricted"
    if (!Array.isArray(raw)) throw new Error("writeFolders must be an array of strings or null");
    const folders = raw
        .map((f) => {
            if (typeof f !== "string") throw new Error("writeFolders entries must be strings");
            return normalizeFolder(f);
        })
        .filter(Boolean);
    return folders;
}

/**
 * Parse the POLICY env var (a JSON array of rules) into a rule list, or null if
 * unset. Throws with an actionable message on malformed input — callers should
 * treat that as a fatal startup error, since a broken policy must not silently
 * fall back to allowing writes.
 */
export function parsePolicy(raw: string | undefined): AccessRule[] | null {
    const trimmed = raw?.trim();
    if (!trimmed) return null;

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (err) {
        throw new Error(`POLICY is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
        throw new Error("POLICY must be a JSON array of rules, e.g. [{\"group\":\"editors\",\"writeFolders\":[\"Inbox\"]}].");
    }

    const rules: AccessRule[] = parsed.map((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`POLICY rule ${i} must be an object.`);
        }
        const e = entry as Record<string, unknown>;
        const group = e.group;
        if (typeof group !== "string" || !group.trim()) {
            throw new Error(`POLICY rule ${i} needs a non-empty "group" (use "*" for a catch-all).`);
        }
        if (e.readOnly !== undefined && typeof e.readOnly !== "boolean") {
            throw new Error(`POLICY rule ${i} "readOnly" must be a boolean.`);
        }
        const rule: AccessRule = { group: group.trim() };
        if (e.readOnly === true) {
            rule.readOnly = true;
        } else if ("writeFolders" in e) {
            rule.writeFolders = normalizeFolders(e.writeFolders);
        }
        return rule;
    });

    return rules;
}

/**
 * Resolve a caller's identity to write access using the policy rules.
 *
 * First-match wins in array order — so put specific groups before a "*"
 * catch-all. A rule matches when its group is one of the caller's groups, or is
 * "*". With no matching rule, access is read-only (default deny).
 */
export function resolvePolicy(identity: IdpIdentity | undefined, rules: AccessRule[]): Access {
    const groups = new Set(identity?.groups ?? []);
    for (const rule of rules) {
        if (rule.group === "*" || groups.has(rule.group)) {
            if (rule.readOnly) return { readOnly: true, writeFolders: [] };
            const writeFolders = rule.writeFolders ?? null;
            return { readOnly: false, writeFolders };
        }
    }
    return { ...READ_ONLY_ACCESS };
}

/**
 * Intersect two folder scopes: the set of paths writable under *both*.
 * `null` means unrestricted on that side. The result keeps the narrower of any
 * two overlapping folders; non-overlapping folders drop out entirely, so two
 * disjoint scopes yield `[]` (nothing writable).
 */
export function intersectFolders(a: string[] | null, b: string[] | null): string[] | null {
    if (a === null) return b === null ? null : [...b];
    if (b === null) return [...a];
    const out = new Set<string>();
    for (const fa of a) {
        for (const fb of b) {
            if (fa === fb || fa.startsWith(fb + "/")) out.add(fa); // fa is inside fb
            else if (fb.startsWith(fa + "/")) out.add(fb); // fb is inside fa
        }
    }
    return [...out];
}

/**
 * Combine a caller's policy access with the process-wide ceiling. The ceiling
 * can only narrow: if the process is read-only, or the intersection of writable
 * folders is empty, the caller is read-only.
 */
export function combineWithCeiling(
    access: Access,
    ceiling: { readOnly: boolean; writeFolders: string[] | null },
): Access {
    if (ceiling.readOnly || access.readOnly) return { readOnly: true, writeFolders: [] };
    const writeFolders = intersectFolders(ceiling.writeFolders, access.writeFolders);
    // An empty (non-null) intersection means the two scopes do not overlap: nothing writable.
    if (writeFolders !== null && writeFolders.length === 0) return { readOnly: true, writeFolders: [] };
    return { readOnly: false, writeFolders };
}

/** True when the caller can write at least one path — used to show/hide write tools. */
export function canWrite(access: Access): boolean {
    return !access.readOnly && (access.writeFolders === null || access.writeFolders.length > 0);
}

/** True when `path` is writable under this access. */
export function isWritable(access: Access, path: string): boolean {
    if (access.readOnly) return false;
    if (access.writeFolders !== null && access.writeFolders.length === 0) return false;
    return isPathWritable(path, access.writeFolders);
}

/** The process-wide ceiling, from READ_ONLY / WRITE_FOLDERS. */
export interface Ceiling {
    readOnly: boolean;
    writeFolders: string[] | null;
}

/** Resolves any session to its effective write access. */
export type AccessResolver = (session: unknown) => Access;

/** Pull an IdpIdentity off a session object, if one is present. */
function sessionIdentity(session: unknown): IdpIdentity | undefined {
    if (session && typeof session === "object" && "identity" in session) {
        const id = (session as { identity?: unknown }).identity;
        if (id && typeof id === "object" && "sub" in id) return id as IdpIdentity;
    }
    return undefined;
}

/**
 * Build the per-request access resolver.
 *
 * With no policy configured, every caller gets the ceiling directly — this is
 * the exact pre-Phase-2 behavior for password and no-auth modes, and for IdP
 * mode it means "any authenticated caller has the container's full write scope".
 * With a policy, each caller's rule is resolved from their identity and then
 * narrowed by the ceiling.
 */
export function makeAccessResolver(rules: AccessRule[] | null, ceiling: Ceiling): AccessResolver {
    // Full write access, subject only to the ceiling — what an admin resolves to.
    const unrestricted: Access = { readOnly: false, writeFolders: null };
    const shared: Access | null = rules === null ? { readOnly: ceiling.readOnly, writeFolders: ceiling.writeFolders } : null;
    return (session: unknown) => {
        // The local admin bypasses POLICY entirely, but never the ceiling.
        if (isAdminSession(session)) return combineWithCeiling(unrestricted, ceiling);
        if (shared) return shared;
        return combineWithCeiling(resolvePolicy(sessionIdentity(session), rules!), ceiling);
    };
}

/** Short human-readable description of an access value, for denial messages. */
export function describeAccess(access: Access): string {
    if (access.readOnly || (access.writeFolders !== null && access.writeFolders.length === 0)) return "read-only";
    if (access.writeFolders === null) return "the whole vault";
    return access.writeFolders.map((f) => f + "/").join(", ");
}
