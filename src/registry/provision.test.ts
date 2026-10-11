import { test } from "node:test";
import assert from "node:assert/strict";
import { Provisioner } from "./provision.js";
import { buildSnapshot, hashToken } from "./model.js";
import { uriPassphrase } from "./setup-uri.js";

/** In-memory registry + a Couch fake that records calls in order. */
function setup(docs: Record<string, any>) {
    const calls: string[] = [];
    const store = {
        db: "reg",
        load: async () => buildSnapshot(Object.values(docs)),
        put: async (id: string, doc: any) => void (docs[id] = doc),
        remove: async (id: string) => void delete docs[id],
    };
    const couch = {
        request: async (method: string, path: string) => (calls.push(`${method} ${path}`), { status: 200, json: {} }),
        remove: async (db: string, id: string) => void calls.push(`remove ${db}/${id}`),
    };
    const p = new Provisioner({ couch: couch as any, store: store as any, registryKey: "k".repeat(16), credentialsKey: "c".repeat(16), serviceUser: "svc", servicePassword: "x", publicCouchUrl: "" });
    return { p, docs, calls };
}

const base = () => ({
    "vault:a": { type: "vault", slug: "a", displayName: "A", obsidianName: "A", db: "vault-a", archived: false, createdAt: "" },
    "user:alice": { type: "user", username: "alice", email: "", name: "", couchPasswordEnc: "", disabled: false, createdAt: "" },
    "user:bob": { type: "user", username: "bob", email: "", name: "", couchPasswordEnc: "", disabled: false, createdAt: "" },
    "grant:alice:a": { type: "grant", username: "alice", vault: "a", mode: "write", folders: [] },
    [`token:${hashToken("t")}`]: { type: "token", hash: hashToken("t"), username: "alice", label: "", createdAt: "" },
});

test("setGrant rejects unknown modes", async () => {
    const { p } = setup(base());
    await assert.rejects(p.setGrant("alice", "a", "admin" as any), /Unknown access mode/);
});

test("revokeToken only revokes the named user's token", async () => {
    const { p, docs } = setup(base());
    const id = `token:${hashToken("t")}`;
    await assert.rejects(p.revokeToken("bob", hashToken("t")), /No such token/);
    assert.ok(docs[id]);
    await p.revokeToken("alice", hashToken("t"));
    assert.equal(docs[id], undefined);
});

test("deleteUser drops vault membership before the CouchDB account", async () => {
    const { p, calls } = setup(base());
    await p.deleteUser("alice");
    assert.ok(calls.indexOf("PUT /vault-a/_security") < calls.indexOf("remove _users/org.couchdb.user:alice"), calls.join("\n"));
});

test("URI passphrase carries 128 random bits", () => {
    assert.match(uriPassphrase(), /^[A-Za-z0-9_-]{22}$/);
    assert.notEqual(uriPassphrase(), uriPassphrase());
});

test("issueToken: scope needs a grant on that vault and is stored on the token", async () => {
    const { p, docs } = setup(base());
    await assert.rejects(p.issueToken("bob", "x", "a"), /no grant on a/);
    await p.issueToken("alice", "x", "a");
    const t = Object.values(docs).find((d: any) => d.type === "token" && d.label === "x") as any;
    assert.equal(t.vault, "a");
});
