import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { FileTokenStorage } from "./token-store.js";

let dir: string;
let path: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "token-store-test-"));
    path = join(dir, "sub", "oauth-store.json");
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("save then get round-trips the value", async () => {
    const store = new FileTokenStorage(path);
    await store.save("k", { a: 1 }, 60);
    assert.deepEqual(await store.get("k"), { a: 1 });
});

test("missing key returns null", async () => {
    const store = new FileTokenStorage(path);
    assert.equal(await store.get("nope"), null);
});

test("an expired entry is dropped on read", async () => {
    const store = new FileTokenStorage(path);
    await store.save("k", "v", -1); // already expired
    assert.equal(await store.get("k"), null);
    assert.equal(store.size, 0);
});

test("no ttl means the entry does not expire", async () => {
    const store = new FileTokenStorage(path);
    await store.save("k", "v");
    assert.equal(await store.get("k"), "v");
});

test("delete removes the entry", async () => {
    const store = new FileTokenStorage(path);
    await store.save("k", "v", 60);
    await store.delete("k");
    assert.equal(await store.get("k"), null);
});

test("cleanup drops only expired entries", async () => {
    const store = new FileTokenStorage(path);
    await store.save("live", "v", 60);
    await store.save("dead", "v", -1);
    await store.cleanup();
    assert.equal(store.size, 1);
    assert.equal(await store.get("live"), "v");
});

test("entries survive a restart — the point of the file store", async () => {
    const first = new FileTokenStorage(path);
    await first.save("token:1", { upstream: "abc" }, 3600);
    await first.flush();

    const second = new FileTokenStorage(path);
    assert.equal(await second.load(), true);
    assert.deepEqual(await second.get("token:1"), { upstream: "abc" });
});

test("expired entries are not restored", async () => {
    const first = new FileTokenStorage(path);
    await first.save("stale", "v", -1);
    await first.save("fresh", "v", 3600);
    await first.flush();

    const second = new FileTokenStorage(path);
    await second.load();
    assert.equal(second.size, 1);
    assert.equal(await second.get("stale"), null);
});

test("load reports false for a missing file and starts empty", async () => {
    const store = new FileTokenStorage(path);
    assert.equal(await store.load(), false);
    assert.equal(store.size, 0);
});

test("a corrupt file degrades to an empty store rather than throwing", async () => {
    const flat = join(dir, "corrupt.json");
    await writeFile(flat, "{not json");
    const store = new FileTokenStorage(flat);
    assert.equal(await store.load(), false);
    assert.equal(store.size, 0);
    // Still usable afterwards.
    await store.save("k", "v", 60);
    assert.equal(await store.get("k"), "v");
});

test("entries with a malformed expiry are skipped on load", async () => {
    const flat = join(dir, "bad-entry.json");
    await writeFile(flat, JSON.stringify({ good: { expiresAt: Date.now() + 60000, value: "v" }, bad: { value: "v" } }));
    const store = new FileTokenStorage(flat);
    assert.equal(await store.load(), true);
    assert.equal(store.size, 1);
    assert.equal(await store.get("bad"), null);
});

test("the file is created 0600 — it holds OAuth material", async () => {
    const store = new FileTokenStorage(path);
    await store.save("k", "v", 60);
    const mode = (await stat(path)).mode & 0o777;
    assert.equal(mode, 0o600);
});

test("concurrent saves all land, without interleaved writers", async () => {
    const store = new FileTokenStorage(path);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.save(`k${i}`, i, 60)));
    await store.flush();

    const reloaded = new FileTokenStorage(path);
    await reloaded.load();
    assert.equal(reloaded.size, 25);
    assert.equal(await reloaded.get("k24"), 24);
});
