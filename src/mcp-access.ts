/**
 * MCP-role access: bearer token → registry user → per-vault grants.
 *
 * The session only records *which* token authenticated. Every tool call looks
 * the token, user and grants up again in the current registry snapshot, so
 * revoking a token, disabling a user or removing a grant takes effect on the
 * next call, even inside an open MCP session.
 *
 * `/mcp?vault=<id>` pins a connection to one vault, so a client can mount a
 * single vault as its own MCP server (e.g. project knowledge in a coding session).
 */

import type { IncomingMessage } from "http";
import { hashToken, pickVault, userVaults, type Snapshot } from "./registry/model.js";
import type { PickedVault, VaultResolver } from "./tools.js";
import type { OpenVault } from "./vault-manager.js";

export type McpSession = {
    [key: string]: unknown;
    authenticated: true;
    tokenHash: string;
    identity: { sub: string; email: string };
    /** Vault this connection is pinned to via `?vault=`; absent = all granted vaults. */
    vault?: string;
};

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function makeAuthenticate(snapshot: () => Snapshot) {
    return async (req: IncomingMessage): Promise<McpSession> => {
        const match = BEARER_RE.exec(req.headers["authorization"] ?? "");
        const hash = match ? hashToken(match[1]) : "";
        const token = hash ? snapshot().tokens.get(hash) : undefined;
        const user = token ? snapshot().users.get(token.username) : undefined;
        if (!token || !user || user.disabled) {
            throw new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
        }
        const vault = new URL(req.url ?? "/", "http://localhost").searchParams.get("vault")?.trim() || undefined;
        // Fail the connect, not every later call, when the pinned vault is out of reach.
        if (vault && "error" in pickVault(snapshot(), user.username, vault)) {
            throw new Response(`No access to vault '${vault}'.`, { status: 403 });
        }
        return { authenticated: true, tokenHash: hash, identity: { sub: user.username, email: user.email }, ...(vault ? { vault } : {}) };
    };
}

/** The registry user behind a session, or undefined if its token was revoked since. */
export function sessionUser(s: Snapshot, session: unknown): string | undefined {
    const hash = (session as McpSession | undefined)?.tokenHash;
    return hash ? s.tokens.get(hash)?.username : undefined;
}

export function makeResolver(snapshot: () => Snapshot, open: (slug: string) => Promise<OpenVault>): VaultResolver {
    const toPicked = (v: { vault: { slug: string; displayName: string; obsidianName: string }; access: PickedVault["access"] }): PickedVault => ({
        slug: v.vault.slug,
        displayName: v.vault.displayName,
        obsidianName: v.vault.obsidianName,
        access: v.access,
    });
    return {
        list(session) {
            const s = snapshot();
            const user = sessionUser(s, session);
            const pinned = (session as McpSession | undefined)?.vault;
            return user ? userVaults(s, user).filter((v) => !pinned || v.vault.slug === pinned).map(toPicked) : [];
        },
        pick(session, requested) {
            const s = snapshot();
            const user = sessionUser(s, session);
            if (!user) return { error: "Your access token is no longer valid." };
            const pinned = (session as McpSession | undefined)?.vault;
            if (pinned && requested && requested !== pinned) return { error: `This connection is limited to vault '${pinned}'.` };
            const hit = pickVault(s, user, pinned ?? requested);
            return "error" in hit ? hit : toPicked(hit);
        },
        open,
    };
}
