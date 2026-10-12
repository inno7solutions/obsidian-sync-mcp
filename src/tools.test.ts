import { test } from "node:test";
import assert from "node:assert/strict";
import { UserError } from "fastmcp";
import { registerTools } from "./tools.js";
import { makeAuditLogger } from "./audit.js";
import { makeResolver } from "./mcp-access.js";
import { buildSnapshot, hashToken } from "./registry/model.js";

/** A tool's reply as the model sees it: UserError (an isError result) becomes its message. */
async function run<T>(p: Promise<T>): Promise<T | string> {
    try {
        return await p;
    } catch (err) {
        if (err instanceof UserError) return err.message;
        throw err;
    }
}

/** Minimal stand-in for FastMCP that just captures registered tools. */
function stubServer() {
    const tools = new Map<string, any>();
    return {
        addTool(tool: any) {
            tools.set(tool.name, tool);
        },
        tools,
    };
}

/** 1×1 transparent PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));

/** A vault stub that records writes and serves one existing note. */
function stubVault(name: string) {
    const calls: Array<[string, string]> = [];
    return {
        name,
        calls,
        async readNote(path: string) {
            return path === "Inbox/existing.md" ? `old in ${name}` : null;
        },
        async writeNote(path: string, content: string) {
            calls.push([path, content]);
            return true;
        },
        async deleteNote() {
            return true;
        },
        async moveNote() {
            return true;
        },
        async getMetadata() {
            return null;
        },
        async getMtime(path: string) {
            return ["Inbox/existing.md", "Inbox/a.md"].includes(path) ? 1000 : null;
        },
        async readBinary(path: string) {
            if (path === "img/pic.png") return { size: PNG.length, bytes: PNG };
            if (path === "big.png") return { size: 9_000_000 };
            return null;
        },
        async findByName(name: string) {
            return ({ "pic.png": ["img/pic.png"], "existing.md": ["Inbox/existing.md"] } as Record<string, string[]>)[name] ?? [];
        },
        async listNotes() {
            return [];
        },
        async listNotesWithMtime() {
            return [];
        },
        async init() {},
        async close() {},
    };
}

const searchIndex = {
    update() {},
    remove() {},
    listWithMtime: () => [],
    listPaths: () => [],
    listFiles: () => [],
    allPaths: () => ["Inbox/existing.md"],
    setFile() {},
    building: false,
    size: 0,
    getTags: () => [],
    listAllTags: () => [],
    getBacklinks: () => [],
    search: (q: string) => (q === "budget" ? { hits: [{ path: "Inbox/existing.md", mtime: 0, matches: 3, snippet: "the budget" }], total: 2 } : { hits: [], total: 0 }),
} as any;

const vault = (slug: string, extra = {}) => ({ type: "vault", slug, displayName: slug.toUpperCase(), obsidianName: `Obs ${slug}`, db: `vault-${slug}`, archived: false, createdAt: "", ...extra });
const user = (username: string, extra = {}) => ({ type: "user", username, email: `${username}@x.com`, name: username, couchPasswordEnc: "", disabled: false, createdAt: "", ...extra });
const grant = (username: string, v: string, mode: string, folders: string[] = []) => ({ type: "grant", username, vault: v, mode, folders });
const token = (t: string, username: string) => ({ type: "token", hash: hashToken(t), username, label: "", createdAt: "" });

function setup(docs: unknown[]) {
    let snapshot = buildSnapshot(docs);
    const vaults = { a: stubVault("a"), b: stubVault("b"), c: stubVault("c") } as Record<string, ReturnType<typeof stubVault>>;
    const server = stubServer();
    const auditLines: string[] = [];
    const audit = makeAuditLogger({ enabled: true, sink: (l) => auditLines.push(l) });
    const resolver = makeResolver(() => snapshot, async (slug) => ({ vault: vaults[slug] as any, index: searchIndex }));
    registerTools(server as any, resolver, audit);
    const call = (tool: string, args: Record<string, unknown>, tok: string): Promise<any> =>
        run(server.tools.get(tool).execute(args, { session: { authenticated: true, tokenHash: hashToken(tok), identity: { sub: "x" } } }));
    return { server, vaults, auditLines, call, setDocs: (d: unknown[]) => (snapshot = buildSnapshot(d)) };
}

const DOCS = [
    vault("a"),
    vault("b"),
    vault("c"),
    user("alice"),
    user("bob"),
    grant("alice", "a", "write"),
    grant("alice", "b", "read"),
    grant("bob", "b", "folders", ["Inbox"]),
    token("tok-alice", "alice"),
    token("tok-bob", "bob"),
];

test("list_vaults shows only granted vaults with access level", async () => {
    const { call } = setup(DOCS);
    const out = await call("list_vaults", {}, "tok-alice");
    assert.match(out, /- a — A \(read\/write\)/);
    assert.match(out, /- b — B \(read-only\)/);
    assert.doesNotMatch(out, /- c/);
});

test("vault argument is required when the user has several vaults", async () => {
    const { call } = setup(DOCS);
    assert.match(await call("read_note", { path: "Inbox/existing.md" }, "tok-alice"), /pass the 'vault' argument.*a, b/);
});

test("a single-vault user may omit the vault argument", async () => {
    const { call } = setup(DOCS);
    assert.match(await call("read_note", { path: "Inbox/existing.md" }, "tok-bob"), /old in b/);
});

test("deep links use the vault's Obsidian name", async () => {
    const { call } = setup(DOCS);
    assert.match(await call("read_note", { vault: "a", path: "Inbox/existing.md" }, "tok-alice"), /obsidian:\/\/open\?vault=Obs%20a&file=Inbox%2Fexisting/);
});

test("ungranted vaults are not reachable", async () => {
    const { call, vaults } = setup(DOCS);
    assert.match(await call("read_note", { vault: "c", path: "x.md" }, "tok-alice"), /not found or not accessible: c/);
    assert.match(await call("write_note", { vault: "a", path: "x.md", content: "hi" }, "tok-bob"), /not found or not accessible: a/);
    assert.equal(vaults.a.calls.length, 0);
});

test("write access is per vault", async () => {
    const { call, vaults } = setup(DOCS);
    assert.match(await call("write_note", { vault: "a", path: "x.md", content: "hi" }, "tok-alice"), /Note saved/);
    assert.match(await call("write_note", { vault: "b", path: "x.md", content: "hi" }, "tok-alice"), /Write access denied.*vault 'b' \(read-only\)/);
    assert.deepEqual(vaults.a.calls, [["x.md", "hi"]]);
    assert.equal(vaults.b.calls.length, 0);
});

test("folder grants scope writes, and move_note checks both ends", async () => {
    const { call, vaults } = setup(DOCS);
    assert.match(await call("write_note", { path: "Projects/x.md", content: "hi" }, "tok-bob"), /Write access denied.*Inbox\//);
    assert.match(await call("write_note", { path: "Inbox/x.md", content: "hi" }, "tok-bob"), /Note saved/);
    assert.match(await call("move_note", { from: "Inbox/a.md", to: "Projects/a.md" }, "tok-bob"), /Write access denied: 'Projects\/a.md'/);
    assert.deepEqual(vaults.b.calls, [["Inbox/x.md", "hi"]]);
});

test("revoking a token, disabling a user or archiving a vault applies to the next call", async () => {
    const { call, setDocs } = setup(DOCS);
    setDocs(DOCS.filter((d: any) => d.hash !== hashToken("tok-bob")));
    assert.match(await call("read_note", { path: "Inbox/existing.md" }, "tok-bob"), /no longer valid/);
    setDocs(DOCS.map((d: any) => (d.type === "user" && d.username === "bob" ? { ...d, disabled: true } : d)));
    assert.match(await call("read_note", { path: "Inbox/existing.md" }, "tok-bob"), /no vault access/);
    setDocs(DOCS.map((d: any) => (d.type === "vault" && d.slug === "a" ? { ...d, archived: true } : d)));
    assert.match(await call("read_note", { vault: "a", path: "x.md" }, "tok-alice"), /not found or not accessible: a/);
});

test("audit: records vault and actor, never the body", async () => {
    const { call, auditLines } = setup(DOCS);
    await call("write_note", { vault: "a", path: "x.md", content: "secret body" }, "tok-alice");
    await call("write_note", { vault: "b", path: "x.md", content: "hi" }, "tok-alice");
    const [ok, denied] = auditLines.map((l) => JSON.parse(l));
    assert.equal(ok.vault, "a");
    assert.equal(ok.outcome, "ok");
    assert.equal(ok.params.content_len, Buffer.byteLength("secret body"));
    assert.ok(!auditLines[0].includes("secret body"));
    assert.equal(denied.vault, "b");
    assert.equal(denied.outcome, "denied");
});

test("audit: inaccessible vault is logged as denied", async () => {
    const { call, auditLines } = setup(DOCS);
    await call("read_note", { vault: "c", path: "x.md" }, "tok-alice");
    const e = JSON.parse(auditLines[0]);
    assert.equal(e.vault, "c");
    assert.equal(e.outcome, "denied");
});

test("audit: a thrown tool error is logged as error and rethrown", async () => {
    const { call, vaults, auditLines } = setup(DOCS);
    vaults.a.writeNote = async () => {
        throw new Error("couchdb down");
    };
    await assert.rejects(() => call("write_note", { vault: "a", path: "x.md", content: "hi" }, "tok-alice"), /couchdb down/);
    const e = JSON.parse(auditLines[0]);
    assert.equal(e.outcome, "error");
    assert.equal(e.error, "couchdb down");
});

test("move_note refuses to overwrite an existing note", async () => {
    const { call, vaults } = setup(DOCS);
    let moved = false;
    vaults.b.moveNote = async () => (moved = true);
    assert.match(await call("move_note", { from: "Inbox/a.md", to: "Inbox/existing.md" }, "tok-bob"), /Destination already exists/);
    assert.equal(moved, false);
    assert.match(await call("move_note", { from: "Inbox/a.md", to: "Inbox/new.md" }, "tok-bob"), /Moved/);
});

test("read_notes returns found notes and flags missing ones", async () => {
    const { call } = setup(DOCS);
    const out = await call("read_notes", { paths: ["Inbox/existing.md", "nope.md"] }, "tok-bob");
    assert.match(out, /## Inbox\/existing.md\n\[Open in Obsidian\][^\n]*\n\nold in b/);
    assert.match(out, /## nope.md\n\nNote not found\./);
});

test("search_notes lists hits with snippet, link and overflow count", async () => {
    const { call, auditLines } = setup(DOCS);
    const out = await call("search_notes", { query: "budget" }, "tok-bob");
    assert.match(out, /- \[Inbox\/existing.md\]\(obsidian:\/\/open[^)]*\)\n  > the budget/);
    assert.match(out, /and 1 more/);
    assert.match(await call("search_notes", { query: "zzz" }, "tok-bob"), /No notes match: zzz/);
    assert.ok(!auditLines[0].includes("budget"), "query text stays out of the audit log");
    assert.equal(JSON.parse(auditLines[0]).params.query_len, 6);
});

test("read_note returns images as image content, resolving a bare file name", async () => {
    const { call } = setup(DOCS);
    const out = await call("read_note", { path: "pic.png" }, "tok-bob");
    assert.equal(out.content[1].type, "image");
    assert.equal(out.content[1].mimeType, "image/png");
    assert.equal(Buffer.from(out.content[1].data, "base64").length, PNG.length);
    assert.match(out.content[0].text, /^img\/pic.png\n\[Open in Obsidian\]/);
    assert.match(await call("read_note", { path: "big.png" }, "tok-bob"), /Image too large to return: big.png is 9.0 MB/);
    assert.match(await call("read_note", { path: "nope.png" }, "tok-bob"), /Note not found: nope.png/);
});

test("read_note resolves a bare note name like an Obsidian link", async () => {
    const { call } = setup(DOCS);
    assert.match(await call("read_note", { path: "existing" }, "tok-bob"), /^Resolved 'existing' to 'Inbox\/existing.md'\.\n\[Open in Obsidian\][\s\S]*old in b/);
});

test("read_notes keeps images and binary files out of the batch", async () => {
    const { call, vaults } = setup(DOCS);
    vaults.b.readNote = async (p: string) => {
        if (p === "doc.pdf") throw new Error("Not a text file: doc.pdf.");
        return null;
    };
    const out = await call("read_notes", { paths: ["img/pic.png", "doc.pdf"] }, "tok-bob");
    assert.match(out, /## img\/pic.png\n\nImage: use read_note to view it\./);
    assert.match(out, /## doc.pdf\n\nNot a text file: doc.pdf\./);
});

test("a connection pinned to one vault sees and reaches only that vault", async () => {
    const { server, vaults } = setup(DOCS);
    const pinned = (tool: string, args: Record<string, unknown>): Promise<any> =>
        run(server.tools.get(tool).execute(args, { session: { authenticated: true, tokenHash: hashToken("tok-alice"), identity: { sub: "x" }, vault: "a" } }));
    const list = await pinned("list_vaults", {});
    assert.match(list, /- a — A/);
    assert.doesNotMatch(list, /- b/);
    assert.match(await pinned("write_note", { path: "x.md", content: "hi" }), /Note saved/, "no vault argument needed");
    assert.match(await pinned("read_note", { vault: "b", path: "Inbox/existing.md" }), /limited to vault 'a'/);
    assert.deepEqual(vaults.a.calls, [["x.md", "hi"]]);
});

test("a vault-scoped token stays in its vault even on an unpinned session", async () => {
    const docs = [...DOCS, { ...token("tok-scoped", "alice"), vault: "a" }];
    const { call } = setup(docs);
    const list = await call("list_vaults", {}, "tok-scoped");
    assert.match(list, /- a — A/);
    assert.doesNotMatch(list, /- b/);
    assert.match(await call("read_note", { vault: "b", path: "Inbox/existing.md" }, "tok-scoped"), /limited to vault 'a'/);
});

test("list_notes and list_folders include attachments on request", async () => {
    const { call } = setup(DOCS);
    const saved = { listWithMtime: searchIndex.listWithMtime, listPaths: searchIndex.listPaths, listFiles: searchIndex.listFiles };
    Object.assign(searchIndex, {
        listWithMtime: () => [{ path: "Inbox/a.md", mtime: 0 }],
        listPaths: () => ["Inbox/a.md"],
        listFiles: () => [
            { path: "Inbox/pic.png", mtime: 0, size: 2_500_000 },
            { path: "Inbox/tiny.png", mtime: 0, size: 70 },
        ],
    });
    try {
        const plain = await call("list_notes", {}, "tok-bob");
        assert.doesNotMatch(plain, /pic.png/);
        const all = await call("list_notes", { include_attachments: true }, "tok-bob");
        assert.match(all, /\[Inbox\/pic.png\]\([^)]*\) \(attachment, 2.5 MB\)/);
        assert.match(all, /\[Inbox\/tiny.png\]\([^)]*\) \(attachment, 70 B\)/);
        assert.match(await call("list_folders", {}, "tok-bob"), /- Inbox \(1 notes, 2 attachments\)/);
    } finally {
        Object.assign(searchIndex, saved);
    }
});

test("move_note update_links rewrites writable linking notes and lists the rest", async () => {
    const { SearchIndex } = await import("./search.js");
    const files = new Map<string, string>([
        ["Inbox/a.md", "self link [[a]]"],
        ["Inbox/x.md", "see [[a#Intro]] and [b](Inbox/a.md)"],
        ["Projects/y.md", "also [[Inbox/a|A]]"],
        ["Inbox/z.md", "mentions a but no link"],
    ]);
    const index = new SearchIndex();
    for (const [p, c] of files) index.update(p, c, 0);
    const mem = {
        async readNote(p: string) {
            return files.get(p) ?? null;
        },
        async getMtime(p: string) {
            return files.has(p) ? 1 : null;
        },
        async writeNote(p: string, c: string) {
            files.set(p, c);
            return true;
        },
        async moveNote(f: string, t: string) {
            files.set(t, files.get(f)!);
            files.delete(f);
            return true;
        },
    };
    const server = stubServer();
    registerTools(server as any, makeResolver(() => buildSnapshot(DOCS), async () => ({ vault: mem as any, index })));
    const out = await run(server.tools
        .get("move_note")
        .execute({ from: "Inbox/a.md", to: "Inbox/b.md", update_links: true }, { session: { authenticated: true, tokenHash: hashToken("tok-bob"), identity: { sub: "x" } } }));
    assert.match(out as string, /Updated 3 links in 2 notes: Inbox\/b.md, Inbox\/x.md\./);
    assert.match(out as string, /Not updated \(no write access or write failed\): Projects\/y.md\./);
    assert.equal(files.get("Inbox/x.md"), "see [[b#Intro]] and [b](Inbox/b.md)");
    assert.equal(files.get("Inbox/b.md"), "self link [[b]]");
    assert.equal(files.get("Projects/y.md"), "also [[Inbox/a|A]]");
    assert.equal(files.get("Inbox/z.md"), "mentions a but no link");
});
