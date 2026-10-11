import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, grantToAccess, hashToken, isValidName, newToken, pickVault, vaultSecurity } from "./model.js";
import { makeAuthenticate } from "../mcp-access.js";
import { seal, open } from "../secret-box.js";

const docs = [
    { type: "vault", slug: "a", displayName: "A", obsidianName: "A", db: "vault-a", archived: false, createdAt: "" },
    { type: "vault", slug: "old", displayName: "Old", obsidianName: "Old", db: "vault-old", archived: true, createdAt: "" },
    { type: "user", username: "alice", email: "alice@x.com", name: "Alice", couchPasswordEnc: "", disabled: false, createdAt: "" },
    { type: "user", username: "eve", email: "eve@x.com", name: "Eve", couchPasswordEnc: "", disabled: true, createdAt: "" },
    { type: "grant", username: "alice", vault: "a", mode: "write", folders: [] },
    { type: "grant", username: "alice", vault: "old", mode: "write", folders: [] },
    { type: "grant", username: "eve", vault: "a", mode: "read", folders: [] },
    { type: "token", hash: hashToken("good"), username: "alice", label: "", createdAt: "" },
    { type: "token", hash: hashToken("disabled-user"), username: "eve", label: "", createdAt: "" },
];
const s = buildSnapshot(docs);

test("grantToAccess maps modes; folder mode without folders is read-only", () => {
    assert.deepEqual(grantToAccess({ mode: "write", folders: [] }), { readOnly: false, writeFolders: null });
    assert.deepEqual(grantToAccess({ mode: "read", folders: [] }), { readOnly: true, writeFolders: [] });
    assert.deepEqual(grantToAccess({ mode: "folders", folders: ["Inbox"] }), { readOnly: false, writeFolders: ["Inbox"] });
    assert.deepEqual(grantToAccess({ mode: "folders", folders: [] }), { readOnly: true, writeFolders: [] });
});

test("pickVault ignores archived vaults and disabled users", () => {
    const hit = pickVault(s, "alice");
    assert.ok(!("error" in hit) && hit.vault.slug === "a", "alice's only active vault is picked implicitly");
    assert.ok("error" in pickVault(s, "alice", "old"));
    assert.ok("error" in pickVault(s, "eve"));
});

test("vaultSecurity: enabled grantees + service, never an empty members list", () => {
    assert.deepEqual(vaultSecurity(s, "a", "mcp-service").members, { names: ["alice", "mcp-service"], roles: ["_admin"] });
    // Archived: nobody but admins, and roles keeps the db from turning public.
    assert.deepEqual(vaultSecurity(s, "old", "mcp-service").members, { names: [], roles: ["_admin"] });
});

test("names are safe for doc ids and CouchDB db names", () => {
    assert.ok(isValidName("team-notes"));
    for (const bad of ["Team", "1abc", "a:b", "", "a".repeat(41), "a_b"]) assert.ok(!isValidName(bad), bad);
});

test("tokens are random and only their hash identifies them", () => {
    const t = newToken();
    assert.match(t, /^osm_[A-Za-z0-9_-]{43}$/);
    assert.notEqual(t, newToken());
    assert.equal(hashToken(t).length, 64);
});

test("authenticate: valid token → session; unknown token or disabled user → 401", async () => {
    const auth = makeAuthenticate(() => s);
    const req = (h?: string) => ({ headers: h ? { authorization: h } : {} }) as any;
    const session = await auth(req("Bearer good"));
    assert.equal(session.identity.email, "alice@x.com");
    assert.equal(session.tokenHash, hashToken("good"));
    for (const h of [undefined, "Bearer nope", "Bearer disabled-user", "Basic good"]) {
        await assert.rejects(auth(req(h)), (r: unknown) => r instanceof Response && r.status === 401, String(h));
    }
});

test("secret-box round-trips and rejects the wrong key", () => {
    const sealed = seal("passphrase", "registry-key-123456");
    assert.equal(open(sealed, "registry-key-123456"), "passphrase");
    assert.throws(() => open(sealed, "wrong-key-12345678"));
});

test("authenticate: ?vault= pins the session; an unreachable vault fails the connect", async () => {
    const auth = makeAuthenticate(() => s);
    const req = (url: string) => ({ url, headers: { authorization: "Bearer good" } }) as any;
    assert.equal((await auth(req("/mcp?vault=a"))).vault, "a");
    assert.equal((await auth(req("/mcp"))).vault, undefined);
    for (const url of ["/mcp?vault=old", "/mcp?vault=nope"]) {
        await assert.rejects(auth(req(url)), (r: unknown) => r instanceof Response && r.status === 403, url);
    }
});
