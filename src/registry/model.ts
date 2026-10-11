/**
 * Registry data model: vaults (one CouchDB database each), users (one CouchDB
 * account each), grants (user × vault → access) and MCP API tokens.
 *
 * Everything here is pure so access decisions are unit-testable without CouchDB.
 */

import { createHash, randomBytes } from "crypto";
import type { Access } from "../policy.js";

export interface VaultRecord {
    type: "vault";
    slug: string;
    displayName: string;
    /** Name of the Obsidian vault on users' devices — only used for obsidian:// deep links. */
    obsidianName: string;
    db: string;
    /** E2E passphrase sealed with REGISTRY_KEY; absent = unencrypted vault. Fixed at creation. */
    passphraseEnc?: string;
    archived: boolean;
    createdAt: string;
}

export interface UserRecord {
    type: "user";
    /** Also the CouchDB user name. */
    username: string;
    email: string;
    name: string;
    /** CouchDB password sealed with CREDENTIALS_KEY (admin role only), so Setup URIs can be issued later. */
    couchPasswordEnc: string;
    disabled: boolean;
    createdAt: string;
}

export type GrantMode = "read" | "write" | "folders";

export interface GrantRecord {
    type: "grant";
    username: string;
    vault: string;
    mode: GrantMode;
    /** Only for mode "folders". */
    folders: string[];
}

export interface TokenRecord {
    type: "token";
    /** sha256 of the token; the token itself is never stored. */
    hash: string;
    username: string;
    label: string;
    createdAt: string;
}

export type RegistryDoc = VaultRecord | UserRecord | GrantRecord | TokenRecord;

export interface Snapshot {
    vaults: Map<string, VaultRecord>;
    users: Map<string, UserRecord>;
    grants: GrantRecord[];
    tokens: Map<string, TokenRecord>;
}

export const docId = {
    vault: (slug: string) => `vault:${slug}`,
    user: (username: string) => `user:${username}`,
    grant: (username: string, slug: string) => `grant:${username}:${slug}`,
    token: (hash: string) => `token:${hash}`,
};

/** Lowercase, starts with a letter, no ':' (used inside doc ids) — also valid in a CouchDB db name. */
const NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const isValidName = (s: string) => NAME_RE.test(s);

export const dbNameFor = (slug: string) => `vault-${slug}`;

export function emptySnapshot(): Snapshot {
    return { vaults: new Map(), users: new Map(), grants: [], tokens: new Map() };
}

export function buildSnapshot(docs: unknown[]): Snapshot {
    const s = emptySnapshot();
    for (const d of docs as RegistryDoc[]) {
        if (!d || typeof d !== "object") continue;
        if (d.type === "vault") s.vaults.set(d.slug, d);
        else if (d.type === "user") s.users.set(d.username, d);
        else if (d.type === "grant") s.grants.push(d);
        else if (d.type === "token") s.tokens.set(d.hash, d);
    }
    return s;
}

export function grantToAccess(g: Pick<GrantRecord, "mode" | "folders">): Access {
    if (g.mode === "write") return { readOnly: false, writeFolders: null };
    if (g.mode === "folders" && g.folders.length > 0) return { readOnly: false, writeFolders: [...g.folders] };
    return { readOnly: true, writeFolders: [] };
}

export interface UserVault {
    vault: VaultRecord;
    access: Access;
}

/** Vaults a user may use right now: user enabled, vault not archived, grant present. */
export function userVaults(s: Snapshot, username: string): UserVault[] {
    const user = s.users.get(username);
    if (!user || user.disabled) return [];
    const out: UserVault[] = [];
    for (const g of s.grants) {
        if (g.username !== username) continue;
        const vault = s.vaults.get(g.vault);
        if (!vault || vault.archived) continue;
        out.push({ vault, access: grantToAccess(g) });
    }
    return out.sort((a, b) => a.vault.slug.localeCompare(b.vault.slug));
}

/**
 * Pick the vault a tool call targets. An explicit name must be one of the
 * user's vaults; without one, the user must have exactly one. Errors name the
 * choices so the model can retry.
 */
export function pickVault(s: Snapshot, username: string, requested?: string): UserVault | { error: string } {
    const mine = userVaults(s, username);
    const names = mine.map((v) => v.vault.slug).join(", ") || "(none)";
    if (requested) {
        const hit = mine.find((v) => v.vault.slug === requested);
        return hit ?? { error: `Vault not found or not accessible: ${requested}. Your vaults: ${names}.` };
    }
    if (mine.length === 1) return mine[0];
    if (mine.length === 0) return { error: "You have no vault access. Ask an administrator for a grant." };
    return { error: `You have access to several vaults; pass the 'vault' argument. Your vaults: ${names}.` };
}

/**
 * CouchDB members of a vault database: every enabled user with a grant, plus
 * the MCP service account. `_admin` in roles keeps the list non-empty, because
 * an empty members section makes a CouchDB database readable by any user.
 */
export function vaultSecurity(s: Snapshot, slug: string, serviceUser: string) {
    const vault = s.vaults.get(slug);
    const names = new Set<string>();
    if (vault && !vault.archived) {
        names.add(serviceUser);
        for (const g of s.grants) {
            const user = s.users.get(g.username);
            if (g.vault === slug && user && !user.disabled) names.add(user.username);
        }
    }
    return {
        admins: { names: [], roles: [] },
        members: { names: [...names].sort(), roles: ["_admin"] },
    };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => "osm_" + randomBytes(32).toString("base64url");
export const newPassword = () => randomBytes(24).toString("base64url");
