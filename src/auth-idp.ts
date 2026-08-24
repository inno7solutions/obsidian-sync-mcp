/**
 * Identity-provider auth mode: OAuth against a real IdP (Entra, Google,
 * Keycloak, Authentik, ...) instead of one shared password.
 *
 * fastmcp already ships the hard part. Its AuthProvider classes run an OAuth
 * proxy that presents itself to MCP clients as a DCR-capable authorization
 * server (serving the discovery documents clients expect) and forwards
 * upstream to an IdP that does not support dynamic client registration. We add
 * the two things it does not do:
 *
 *   1. Identity. The built-in providers return only tokens — no provider
 *      overrides createSession — so we decode the OIDC ID token ourselves and
 *      put {sub, email, name, groups} on the session, where tools can read it
 *      as `ctx.session.identity`.
 *   2. A gate. Optional group and email-domain requirements, so a token from
 *      the wider tenant is not automatically a session on this vault.
 *
 * Everything here is env-driven and pure where it can be, so the parsing and
 * the identity/authorization rules are unit-testable without a live IdP.
 */

import type { IncomingMessage } from "http";
import { createHash } from "crypto";
import { AzureProvider, GoogleProvider, OAuthProvider } from "fastmcp";

export type IdpProviderName = "azure" | "google" | "generic";

export interface IdpConfig {
    provider: IdpProviderName;
    clientId: string;
    clientSecret: string;
    /** Entra tenant id, or 'common'/'organizations'/'consumers'. Azure only. */
    tenantId?: string;
    /** Generic provider only. */
    authorizationEndpoint?: string;
    /** Generic provider only. */
    tokenEndpoint?: string;
    scopes: string[];
    allowedRedirectUriPatterns: string[];
    /** ID token claims to read group/role membership from, in order. */
    groupsClaims: string[];
    /** Caller must be in at least one of these groups. Empty means no group requirement. */
    requiredGroups: string[];
    /** Caller's email domain must be one of these. Empty means no domain requirement. */
    allowedDomains: string[];
    jwtSigningKey: string;
    encryptionKey: string;
}

export interface IdpIdentity {
    sub: string;
    email?: string;
    name?: string;
    groups: string[];
}

/** Scopes that get us an ID token, plus a refresh token where the IdP uses the standard scope for it. */
const DEFAULT_SCOPES: Record<IdpProviderName, string[]> = {
    // Google signals offline access with a query param, not a scope, and
    // rejects `offline_access` outright.
    google: ["openid", "profile", "email"],
    azure: ["openid", "profile", "email", "offline_access"],
    generic: ["openid", "profile", "email", "offline_access"],
};

/**
 * Redirect URI patterns offered to fastmcp's client-registration check.
 *
 * Read the upstream implementation before trusting this to restrict anything:
 * OAuthProxy.validateRedirectUri() tries these patterns first, but when none
 * matches it still returns true for *any* https:// URI or loopback host. So the
 * list can only widen what is accepted (e.g. a custom-scheme callback such as
 * `vscode://...` via IDP_ALLOWED_REDIRECT_URIS), never narrow it — a tighter
 * list here states intent, it does not enforce. The IdP's own redirect URI
 * allowlist is the boundary that actually holds.
 */
const DEFAULT_REDIRECT_PATTERNS = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "http://localhost:*",
    "http://127.0.0.1:*",
];

const DEFAULT_GROUPS_CLAIMS = ["groups", "roles"];

/** Split a comma-separated env var into trimmed, non-empty entries. */
function splitList(raw: string | undefined): string[] {
    return (raw ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * Derive a stable key from the client secret.
 *
 * fastmcp auto-generates its JWT signing and storage encryption keys when they
 * are not supplied, which would rotate them on every restart and invalidate
 * every live session — and make the persisted token store unreadable. Deriving
 * from a secret we already hold keeps sessions alive across restarts with no
 * extra configuration; rotating the client secret deliberately ends them.
 */
function deriveKey(label: string, secret: string): string {
    return createHash("sha256").update(`obsidian-sync-mcp:${label}:${secret}`).digest("base64");
}

/**
 * Build the IdP config from environment variables. Throws with an actionable
 * message on anything missing or unusable — callers should treat that as fatal.
 */
export function parseIdpConfig(env: Record<string, string | undefined>): IdpConfig {
    const name = (env.IDP_PROVIDER ?? "").trim().toLowerCase();

    if (name === "github") {
        throw new Error(
            "IDP_PROVIDER=github is not supported: GitHub OAuth issues no OIDC ID token, so there is no identity or group claim to authorize against. Use azure, google, or generic with an OIDC-capable provider.",
        );
    }
    if (name !== "azure" && name !== "google" && name !== "generic") {
        throw new Error(`IDP_PROVIDER must be one of: azure, google, generic (got '${env.IDP_PROVIDER ?? ""}').`);
    }
    const provider: IdpProviderName = name;

    const clientId = env.IDP_CLIENT_ID?.trim();
    const clientSecret = env.IDP_CLIENT_SECRET?.trim();
    if (!clientId) throw new Error("IDP_CLIENT_ID is required when IDP_PROVIDER is set.");
    if (!clientSecret) throw new Error("IDP_CLIENT_SECRET is required when IDP_PROVIDER is set.");

    const authorizationEndpoint = env.IDP_AUTHORIZATION_ENDPOINT?.trim() || undefined;
    const tokenEndpoint = env.IDP_TOKEN_ENDPOINT?.trim() || undefined;
    if (provider === "generic" && (!authorizationEndpoint || !tokenEndpoint)) {
        throw new Error(
            "IDP_PROVIDER=generic requires IDP_AUTHORIZATION_ENDPOINT and IDP_TOKEN_ENDPOINT (find them in your IdP's /.well-known/openid-configuration).",
        );
    }

    const scopes = splitList(env.IDP_SCOPES);
    const redirectPatterns = splitList(env.IDP_ALLOWED_REDIRECT_URIS);
    const groupsClaims = splitList(env.IDP_GROUPS_CLAIM);

    return {
        provider,
        clientId,
        clientSecret,
        tenantId: env.IDP_TENANT_ID?.trim() || undefined,
        authorizationEndpoint,
        tokenEndpoint,
        scopes: scopes.length > 0 ? scopes : DEFAULT_SCOPES[provider],
        allowedRedirectUriPatterns: redirectPatterns.length > 0 ? redirectPatterns : DEFAULT_REDIRECT_PATTERNS,
        groupsClaims: groupsClaims.length > 0 ? groupsClaims : DEFAULT_GROUPS_CLAIMS,
        requiredGroups: splitList(env.IDP_REQUIRED_GROUPS),
        allowedDomains: splitList(env.IDP_ALLOWED_DOMAINS).map((d) => d.replace(/^@/, "").toLowerCase()),
        jwtSigningKey: env.IDP_JWT_SIGNING_KEY?.trim() || deriveKey("jwt", clientSecret),
        encryptionKey: env.IDP_ENCRYPTION_KEY?.trim() || deriveKey("storage", clientSecret),
    };
}

const MAX_TOKEN_BYTES = 16 * 1024;

/**
 * Decode a JWT's claims without verifying its signature.
 *
 * Safe *here and only here*: with fastmcp's token swap (on by default) the
 * client holds a proxy-issued JWT, and this ID token comes from the proxy's
 * server-side storage — it arrived over TLS from the IdP's token endpoint and
 * never passed through the caller. If token swap is ever disabled, this needs
 * real signature verification against the IdP's JWKS.
 */
export function decodeJwtClaims(token: string | undefined): Record<string, unknown> | null {
    if (!token || token.length > MAX_TOKEN_BYTES) return null;
    const parts = token.split(".");
    if (parts.length < 2) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
        if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
        return claims as Record<string, unknown>;
    } catch {
        return null;
    }
}

/**
 * Normalize a claim into a string list. IdPs disagree on shape: an array
 * (Entra `groups`/`roles`, Keycloak), a space-delimited string (OAuth scope
 * convention), or a comma-separated one.
 */
export function toStringList(value: unknown): string[] {
    if (Array.isArray(value)) return value.filter((v) => typeof v === "string" && v.length > 0) as string[];
    if (typeof value === "string") return value.split(/[\s,]+/).filter(Boolean);
    return [];
}

/**
 * Pull identity out of ID token claims. Falls back across the spellings the
 * major IdPs use: Entra puts the object id in `oid` and the user name in
 * `preferred_username` or `upn`; Google uses `sub` and `email`.
 */
export function extractIdentity(
    claims: Record<string, unknown> | null,
    groupsClaims: string[] = DEFAULT_GROUPS_CLAIMS,
): IdpIdentity | null {
    if (!claims) return null;
    const str = (key: string): string | undefined => {
        const v = claims[key];
        return typeof v === "string" && v.trim() ? v.trim() : undefined;
    };
    const sub = str("sub") ?? str("oid");
    if (!sub) return null;

    const groups = new Set<string>();
    for (const claim of groupsClaims) {
        for (const g of toStringList(claims[claim])) groups.add(g);
    }

    return {
        sub,
        email: (str("email") ?? str("preferred_username") ?? str("upn"))?.toLowerCase(),
        name: str("name"),
        groups: [...groups],
    };
}

export interface AuthzDecision {
    ok: boolean;
    reason?: string;
}

/** Apply the optional group and email-domain requirements. */
export function authorizeIdentity(
    identity: IdpIdentity,
    rules: { requiredGroups: string[]; allowedDomains: string[] },
): AuthzDecision {
    if (rules.allowedDomains.length > 0) {
        const domain = identity.email?.split("@")[1]?.toLowerCase();
        if (!domain) {
            return { ok: false, reason: "no email claim to check against IDP_ALLOWED_DOMAINS" };
        }
        if (!rules.allowedDomains.includes(domain)) {
            return { ok: false, reason: `email domain '${domain}' is not in IDP_ALLOWED_DOMAINS` };
        }
    }
    if (rules.requiredGroups.length > 0) {
        const hit = identity.groups.some((g) => rules.requiredGroups.includes(g));
        if (!hit) {
            const seen = identity.groups.length > 0 ? identity.groups.join(", ") : "none";
            return { ok: false, reason: `not in any of IDP_REQUIRED_GROUPS (claims carried: ${seen})` };
        }
    }
    return { ok: true };
}

/**
 * What tools see on `ctx.session` in IdP mode.
 *
 * Declared with an index signature so it satisfies fastmcp's session type
 * (`Record<string, unknown>`), which an interface would not.
 */
export type IdpSession = {
    [key: string]: unknown;
    authenticated: true;
    identity: IdpIdentity;
    scopes?: string[];
    expiresAt?: number;
};

/** A fastmcp AuthProvider — the concrete class depends on IDP_PROVIDER. */
type Provider = AzureProvider | GoogleProvider | OAuthProvider;

export interface IdpAuth {
    /** Pass as `auth` so fastmcp mounts the OAuth discovery documents and proxy routes. */
    provider: Provider;
    /** Pass as `authenticate` so our identity and gate run instead of the provider's bare version. */
    authenticate: (req: IncomingMessage | undefined) => Promise<IdpSession>;
}

/** Minimal shape of fastmcp's TokenStorage, matched structurally so we need no exported type. */
interface TokenStorageLike {
    cleanup(): Promise<void>;
    delete(key: string): Promise<void>;
    get(key: string): Promise<null | unknown>;
    save(key: string, value: unknown, ttl?: number): Promise<void>;
}

function buildProvider(cfg: IdpConfig, baseUrl: string, tokenStorage?: TokenStorageLike): Provider {
    const common = {
        allowedRedirectUriPatterns: cfg.allowedRedirectUriPatterns,
        baseUrl,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret,
        encryptionKey: cfg.encryptionKey,
        jwtSigningKey: cfg.jwtSigningKey,
        scopes: cfg.scopes,
        tokenStorage: tokenStorage as never,
    };
    if (cfg.provider === "azure") {
        return new AzureProvider({ ...common, tenantId: cfg.tenantId });
    }
    if (cfg.provider === "google") {
        return new GoogleProvider(common);
    }
    return new OAuthProvider({
        ...common,
        authorizationEndpoint: cfg.authorizationEndpoint!,
        tokenEndpoint: cfg.tokenEndpoint!,
    });
}

function unauthorized(baseUrl: string): Response {
    // RFC 9728: point clients at the resource metadata so they can start the flow.
    return new Response("Unauthorized", {
        status: 401,
        headers: { "WWW-Authenticate": `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"` },
    });
}

/**
 * Build the IdP provider and the authenticate function to hand to FastMCP.
 *
 * Set both: fastmcp takes our `authenticate` over the provider's, while still
 * installing the provider's OAuth discovery documents and proxy endpoints.
 */
export function createIdpAuth(cfg: IdpConfig, baseUrl: string, tokenStorage?: TokenStorageLike): IdpAuth {
    const provider = buildProvider(cfg, baseUrl, tokenStorage);

    const authenticate = async (req: IncomingMessage | undefined): Promise<IdpSession> => {
        const session = await provider.authenticate(req);
        if (!session) throw unauthorized(baseUrl);

        const identity = extractIdentity(decodeJwtClaims(session.idToken), cfg.groupsClaims);
        if (!identity) {
            console.warn("Auth rejected: no usable identity in the ID token (is 'openid' in IDP_SCOPES?).");
            throw unauthorized(baseUrl);
        }

        const decision = authorizeIdentity(identity, cfg);
        if (!decision.ok) {
            // Logged so denials are visible before the audit trail exists.
            console.warn(`Auth denied for ${identity.email ?? identity.sub}: ${decision.reason}.`);
            throw new Response("Forbidden: not authorized for this vault", { status: 403 });
        }

        return { authenticated: true, identity, scopes: session.scopes, expiresAt: session.expiresAt };
    };

    return { provider, authenticate };
}

/**
 * Deployment invariants that code cannot enforce but an operator must know.
 * Logged once at startup.
 */
export const IDP_STARTUP_NOTES = [
    "Note: fastmcp's OAuth proxy answers /oauth/register with the upstream IdP client_id and client_secret, to any caller that can reach the port — that is how it bridges clients expecting dynamic registration. Use a dedicated, minimally privileged app registration for this server (no API permissions beyond openid/profile/email, no client-credentials grant), and treat that secret as recoverable by anyone who can reach it.",
];

/** One-line startup summary. Never includes secrets. */
export function describeIdpConfig(cfg: IdpConfig): string {
    const bits = [`provider=${cfg.provider}`];
    if (cfg.provider === "azure") bits.push(`tenant=${cfg.tenantId ?? "common"}`);
    bits.push(`scopes=${cfg.scopes.join(" ")}`);
    bits.push(cfg.requiredGroups.length > 0 ? `requiredGroups=${cfg.requiredGroups.join(",")}` : "requiredGroups=(none)");
    if (cfg.allowedDomains.length > 0) bits.push(`allowedDomains=${cfg.allowedDomains.join(",")}`);
    return bits.join(", ");
}
