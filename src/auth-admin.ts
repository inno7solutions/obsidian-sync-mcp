/**
 * Local admin fallback (break-glass).
 *
 * A static bearer token, defined in env, that authenticates as a fixed admin
 * identity — usable *alongside* IdP mode, not instead of it. It exists for the
 * cases OAuth can't cover: the IdP is down, or a non-interactive client (curl,
 * a script, CI) needs access without a browser login.
 *
 * Unlike `MCP_AUTH_TOKEN` (which grants an anonymous session and mounts its own
 * OAuth routes, so it collides with the IdP proxy), `ADMIN_TOKEN` is only a
 * bearer check inside `authenticate` — it mounts nothing, so it composes with
 * any auth mode. It carries a real identity, so admin actions are attributable
 * in the audit log, and it bypasses the per-caller POLICY (an admin can write
 * anywhere the process ceiling allows) without needing a matching POLICY rule.
 *
 * It does NOT bypass the process-wide READ_ONLY / WRITE_FOLDERS ceiling: a
 * container locked down at that level stays locked down even for the admin.
 */

import { timingSafeEqual } from "crypto";
import type { IdpIdentity } from "./auth-idp.js";

export interface AdminConfig {
    token: string;
    identity: IdpIdentity;
}

/**
 * Session shape returned for an authenticated admin. `admin: true` drives the
 * POLICY bypass. The index signature makes it assignable to fastmcp's session
 * type (`Record<string, unknown>`), which a plain interface would not be.
 */
export type AdminSession = {
    [key: string]: unknown;
    authenticated: true;
    admin: true;
    identity: IdpIdentity;
};

const MIN_TOKEN_LENGTH = 16;

/**
 * Parse the admin fallback from env, or null if `ADMIN_TOKEN` is unset.
 * The synthesized identity is what appears in the audit log and on the session.
 */
export function parseAdminConfig(env: Record<string, string | undefined>): AdminConfig | null {
    const token = env.ADMIN_TOKEN?.trim();
    if (!token) return null;
    if (token.length < MIN_TOKEN_LENGTH) {
        // Not fatal — the operator may knowingly use a short token in a trusted
        // network — but it is a genuine risk, so it is surfaced loudly at startup.
        console.warn(`WARNING: ADMIN_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters; use a long random secret.`);
    }
    const groups = (env.ADMIN_GROUPS ?? "vault-admins")
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);
    return {
        token,
        identity: {
            sub: env.ADMIN_SUB?.trim() || "admin",
            email: env.ADMIN_EMAIL?.trim() || "admin@local",
            name: "admin (local fallback)",
            groups: groups.length > 0 ? groups : ["vault-admins"],
        },
    };
}

/** Constant-time comparison of the request's Authorization header to `Bearer <token>`. */
function bearerMatches(authHeader: string | undefined, token: string): boolean {
    if (!authHeader) return false;
    const expected = `Bearer ${token}`;
    // Length must match before timingSafeEqual, which throws on unequal-length buffers.
    if (authHeader.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
}

/**
 * Return the admin session if the request carries the admin bearer token, else
 * null (so the caller falls through to the real authenticator).
 */
export function adminSessionFor(authHeader: string | undefined, cfg: AdminConfig | null): AdminSession | null {
    if (!cfg) return null;
    if (!bearerMatches(authHeader, cfg.token)) return null;
    return { authenticated: true, admin: true, identity: cfg.identity };
}

/** True if a session was authenticated via the admin token. */
export function isAdminSession(session: unknown): boolean {
    return !!session && typeof session === "object" && (session as { admin?: unknown }).admin === true;
}
