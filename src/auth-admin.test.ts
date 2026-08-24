import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAdminConfig, adminSessionFor, isAdminSession } from "./auth-admin.js";

const TOKEN = "a-very-long-admin-token-1234567890";

// --- parseAdminConfig ---

test("parseAdminConfig: null when ADMIN_TOKEN is unset", () => {
    assert.equal(parseAdminConfig({}), null);
    assert.equal(parseAdminConfig({ ADMIN_TOKEN: "   " }), null);
});

test("parseAdminConfig: synthesizes a default admin identity", () => {
    const cfg = parseAdminConfig({ ADMIN_TOKEN: TOKEN })!;
    assert.equal(cfg.token, TOKEN);
    assert.equal(cfg.identity.sub, "admin");
    assert.equal(cfg.identity.email, "admin@local");
    assert.deepEqual(cfg.identity.groups, ["vault-admins"]);
});

test("parseAdminConfig: identity fields are overridable", () => {
    const cfg = parseAdminConfig({
        ADMIN_TOKEN: TOKEN,
        ADMIN_EMAIL: "ops@inno7.com",
        ADMIN_SUB: "svc-ops",
        ADMIN_GROUPS: "vault-admins, oncall",
    })!;
    assert.equal(cfg.identity.email, "ops@inno7.com");
    assert.equal(cfg.identity.sub, "svc-ops");
    assert.deepEqual(cfg.identity.groups, ["vault-admins", "oncall"]);
});

// --- adminSessionFor ---

const cfg = parseAdminConfig({ ADMIN_TOKEN: TOKEN });

test("adminSessionFor: matches the exact bearer token", () => {
    const s = adminSessionFor(`Bearer ${TOKEN}`, cfg);
    assert.ok(s);
    assert.equal(s!.admin, true);
    assert.equal(s!.identity.email, "admin@local");
});

test("adminSessionFor: rejects a wrong or malformed header", () => {
    assert.equal(adminSessionFor(`Bearer wrong`, cfg), null);
    assert.equal(adminSessionFor(TOKEN, cfg), null); // missing "Bearer "
    assert.equal(adminSessionFor(undefined, cfg), null);
    assert.equal(adminSessionFor(`Bearer ${TOKEN}x`, cfg), null); // length differs
});

test("adminSessionFor: no config means no admin session", () => {
    assert.equal(adminSessionFor(`Bearer ${TOKEN}`, null), null);
});

// --- isAdminSession ---

test("isAdminSession: only true for an admin-flagged session", () => {
    assert.equal(isAdminSession({ authenticated: true, admin: true, identity: {} }), true);
    assert.equal(isAdminSession({ authenticated: true, identity: {} }), false);
    assert.equal(isAdminSession({ admin: "true" }), false);
    assert.equal(isAdminSession(undefined), false);
    assert.equal(isAdminSession(null), false);
});
