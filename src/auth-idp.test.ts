import { test } from "node:test";
import assert from "node:assert/strict";
import {
    parseIdpConfig,
    decodeJwtClaims,
    toStringList,
    extractIdentity,
    authorizeIdentity,
    describeIdpConfig,
} from "./auth-idp.js";

const base = {
    IDP_PROVIDER: "azure",
    IDP_CLIENT_ID: "client-abc",
    IDP_CLIENT_SECRET: "secret-xyz",
};

/** Build an unsigned JWT with the given payload (signature is never checked). */
function jwt(payload: unknown): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    return `${enc({ alg: "RS256" })}.${enc(payload)}.signature`;
}

// --- parseIdpConfig ---

test("parseIdpConfig: github is rejected with the reason", () => {
    assert.throws(() => parseIdpConfig({ ...base, IDP_PROVIDER: "github" }), /no OIDC ID token/);
});

test("parseIdpConfig: unknown provider is rejected", () => {
    assert.throws(() => parseIdpConfig({ ...base, IDP_PROVIDER: "okta" }), /must be one of/);
    assert.throws(() => parseIdpConfig({ IDP_PROVIDER: "" }), /must be one of/);
});

test("parseIdpConfig: client id and secret are required", () => {
    assert.throws(() => parseIdpConfig({ IDP_PROVIDER: "azure" }), /IDP_CLIENT_ID is required/);
    assert.throws(() => parseIdpConfig({ IDP_PROVIDER: "azure", IDP_CLIENT_ID: "x" }), /IDP_CLIENT_SECRET is required/);
});

test("parseIdpConfig: generic requires both endpoints", () => {
    assert.throws(() => parseIdpConfig({ ...base, IDP_PROVIDER: "generic" }), /IDP_AUTHORIZATION_ENDPOINT/);
    assert.throws(
        () => parseIdpConfig({ ...base, IDP_PROVIDER: "generic", IDP_AUTHORIZATION_ENDPOINT: "https://idp/auth" }),
        /IDP_TOKEN_ENDPOINT/,
    );
    const cfg = parseIdpConfig({
        ...base,
        IDP_PROVIDER: "generic",
        IDP_AUTHORIZATION_ENDPOINT: "https://idp/auth",
        IDP_TOKEN_ENDPOINT: "https://idp/token",
    });
    assert.equal(cfg.provider, "generic");
    assert.equal(cfg.tokenEndpoint, "https://idp/token");
});

test("parseIdpConfig: provider name is case-insensitive and trimmed", () => {
    assert.equal(parseIdpConfig({ ...base, IDP_PROVIDER: " Azure " }).provider, "azure");
});

test("parseIdpConfig: default scopes ask for an ID token, and offline access where the IdP uses that scope", () => {
    assert.deepEqual(parseIdpConfig(base).scopes, ["openid", "profile", "email", "offline_access"]);
    // Google rejects offline_access — it signals offline with a query param.
    assert.deepEqual(parseIdpConfig({ ...base, IDP_PROVIDER: "google" }).scopes, ["openid", "profile", "email"]);
});

test("parseIdpConfig: IDP_SCOPES overrides the defaults", () => {
    assert.deepEqual(parseIdpConfig({ ...base, IDP_SCOPES: "openid, groups" }).scopes, ["openid", "groups"]);
});

test("parseIdpConfig: redirect patterns default to the hosted Claude clients plus loopback", () => {
    const cfg = parseIdpConfig(base);
    assert.ok(cfg.allowedRedirectUriPatterns.includes("https://claude.ai/api/mcp/auth_callback"));
    assert.ok(cfg.allowedRedirectUriPatterns.includes("http://localhost:*"));
    // Deliberately narrower than fastmcp's own `https://*` default.
    assert.ok(!cfg.allowedRedirectUriPatterns.includes("https://*"));
    assert.deepEqual(parseIdpConfig({ ...base, IDP_ALLOWED_REDIRECT_URIS: "https://mine/cb" }).allowedRedirectUriPatterns, [
        "https://mine/cb",
    ]);
});

test("parseIdpConfig: group and domain rules are empty unless set", () => {
    const cfg = parseIdpConfig(base);
    assert.deepEqual(cfg.requiredGroups, []);
    assert.deepEqual(cfg.allowedDomains, []);
    assert.deepEqual(cfg.groupsClaims, ["groups", "roles"]);
});

test("parseIdpConfig: allowed domains are normalized", () => {
    const cfg = parseIdpConfig({ ...base, IDP_ALLOWED_DOMAINS: "@Inno7.com, EXAMPLE.ORG" });
    assert.deepEqual(cfg.allowedDomains, ["inno7.com", "example.org"]);
});

test("parseIdpConfig: keys are derived deterministically from the client secret", () => {
    // Auto-generated keys would rotate per restart and invalidate every session
    // plus the persisted token store, so they must be stable.
    const a = parseIdpConfig(base);
    const b = parseIdpConfig(base);
    assert.equal(a.jwtSigningKey, b.jwtSigningKey);
    assert.equal(a.encryptionKey, b.encryptionKey);
    assert.notEqual(a.jwtSigningKey, a.encryptionKey);

    const rotated = parseIdpConfig({ ...base, IDP_CLIENT_SECRET: "secret-rotated" });
    assert.notEqual(rotated.jwtSigningKey, a.jwtSigningKey);
});

test("parseIdpConfig: explicit keys win over derived ones", () => {
    const cfg = parseIdpConfig({ ...base, IDP_JWT_SIGNING_KEY: "jwt-key", IDP_ENCRYPTION_KEY: "enc-key" });
    assert.equal(cfg.jwtSigningKey, "jwt-key");
    assert.equal(cfg.encryptionKey, "enc-key");
});

test("describeIdpConfig: summarizes without leaking secrets", () => {
    const line = describeIdpConfig(parseIdpConfig({ ...base, IDP_TENANT_ID: "tid", IDP_REQUIRED_GROUPS: "vault-team" }));
    assert.match(line, /provider=azure/);
    assert.match(line, /tenant=tid/);
    assert.match(line, /requiredGroups=vault-team/);
    assert.ok(!line.includes("secret-xyz"));
});

// --- decodeJwtClaims ---

test("decodeJwtClaims: decodes a base64url payload", () => {
    assert.deepEqual(decodeJwtClaims(jwt({ sub: "u1", email: "a@b.c" })), { sub: "u1", email: "a@b.c" });
});

test("decodeJwtClaims: handles base64url-specific characters", () => {
    // A payload whose base64 encoding needs - and _ rather than + and /.
    const claims = { sub: "u1", name: "øÿþ~?>?" };
    assert.deepEqual(decodeJwtClaims(jwt(claims)), claims);
});

test("decodeJwtClaims: rejects junk rather than throwing", () => {
    assert.equal(decodeJwtClaims(undefined), null);
    assert.equal(decodeJwtClaims(""), null);
    assert.equal(decodeJwtClaims("not-a-jwt"), null);
    assert.equal(decodeJwtClaims("a.!!!!.c"), null);
    assert.equal(decodeJwtClaims("a." + Buffer.from("[1,2]").toString("base64url") + ".c"), null);
    assert.equal(decodeJwtClaims("a." + Buffer.from('"str"').toString("base64url") + ".c"), null);
});

test("decodeJwtClaims: refuses an implausibly large token", () => {
    assert.equal(decodeJwtClaims("a." + "x".repeat(20000) + ".c"), null);
});

// --- toStringList ---

test("toStringList: accepts the shapes IdPs actually send", () => {
    assert.deepEqual(toStringList(["a", "b"]), ["a", "b"]);
    assert.deepEqual(toStringList("a b"), ["a", "b"]);
    assert.deepEqual(toStringList("a,b"), ["a", "b"]);
    assert.deepEqual(toStringList("a, b  c"), ["a", "b", "c"]);
    assert.deepEqual(toStringList(["a", 1, null, ""]), ["a"]);
    assert.deepEqual(toStringList(undefined), []);
    assert.deepEqual(toStringList({}), []);
});

// --- extractIdentity ---

test("extractIdentity: reads sub, email and name", () => {
    const id = extractIdentity({ sub: "u1", email: "Jane@Inno7.com", name: "Jane" });
    assert.deepEqual(id, { sub: "u1", email: "jane@inno7.com", name: "Jane", groups: [] });
});

test("extractIdentity: falls back to the Entra spellings", () => {
    const id = extractIdentity({ oid: "obj-1", preferred_username: "jane@inno7.com" });
    assert.equal(id?.sub, "obj-1");
    assert.equal(id?.email, "jane@inno7.com");
    assert.equal(extractIdentity({ oid: "obj-1", upn: "jane@inno7.com" })?.email, "jane@inno7.com");
});

test("extractIdentity: no subject means no identity", () => {
    assert.equal(extractIdentity({ email: "a@b.c" }), null);
    assert.equal(extractIdentity({ sub: "   " }), null);
    assert.equal(extractIdentity(null), null);
});

test("extractIdentity: unions every configured group claim", () => {
    const id = extractIdentity({ sub: "u1", groups: ["g1", "g2"], roles: "g2 g3" });
    assert.deepEqual(id?.groups.sort(), ["g1", "g2", "g3"]);
});

test("extractIdentity: honours a custom claim name", () => {
    const id = extractIdentity({ sub: "u1", "custom:teams": ["t1"], groups: ["ignored"] }, ["custom:teams"]);
    assert.deepEqual(id?.groups, ["t1"]);
});

// --- authorizeIdentity ---

const identity = { sub: "u1", email: "jane@inno7.com", groups: ["vault-editors"] };

test("authorizeIdentity: no rules configured allows any authenticated caller", () => {
    assert.equal(authorizeIdentity(identity, { requiredGroups: [], allowedDomains: [] }).ok, true);
});

test("authorizeIdentity: enforces the email domain", () => {
    assert.equal(authorizeIdentity(identity, { requiredGroups: [], allowedDomains: ["inno7.com"] }).ok, true);
    const denied = authorizeIdentity(identity, { requiredGroups: [], allowedDomains: ["other.com"] });
    assert.equal(denied.ok, false);
    assert.match(denied.reason!, /inno7\.com/);
});

test("authorizeIdentity: a domain rule with no email claim is a denial", () => {
    const denied = authorizeIdentity({ sub: "u1", groups: [] }, { requiredGroups: [], allowedDomains: ["inno7.com"] });
    assert.equal(denied.ok, false);
    assert.match(denied.reason!, /no email claim/);
});

test("authorizeIdentity: required groups are any-of", () => {
    assert.equal(authorizeIdentity(identity, { requiredGroups: ["vault-editors", "vault-admins"], allowedDomains: [] }).ok, true);
    const denied = authorizeIdentity(identity, { requiredGroups: ["vault-admins"], allowedDomains: [] });
    assert.equal(denied.ok, false);
    assert.match(denied.reason!, /vault-editors/); // reports what the token did carry
});

test("authorizeIdentity: a caller with no groups is denied when groups are required", () => {
    const denied = authorizeIdentity({ sub: "u1", groups: [] }, { requiredGroups: ["vault-team"], allowedDomains: [] });
    assert.equal(denied.ok, false);
    assert.match(denied.reason!, /none/);
});

test("authorizeIdentity: both rules must pass", () => {
    const rules = { requiredGroups: ["vault-editors"], allowedDomains: ["other.com"] };
    assert.equal(authorizeIdentity(identity, rules).ok, false);
});
