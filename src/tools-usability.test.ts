import { test } from "node:test";
import assert from "node:assert/strict";
import { UserError } from "fastmcp";
import { registerTools } from "./tools.js";
import { makeResolver } from "./mcp-access.js";
import { buildSnapshot, hashToken } from "./registry/model.js";
import { SearchIndex } from "./search.js";

/** One user with full write access to one vault, backed by an in-memory vault and a real index. */
function setup(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    const mtimes = new Map([...files.keys()].map((p) => [p, 1000]));
    let clock = 2000;
    const vault = {
        async readNote(p: string) {
            return files.get(p) ?? null;
        },
        async writeNote(p: string, c: string) {
            files.set(p, c);
            mtimes.set(p, clock++);
            return true;
        },
        async deleteNote(p: string) {
            mtimes.delete(p);
            return files.delete(p);
        },
        async moveNote(f: string, t: string) {
            files.set(t, files.get(f)!);
            mtimes.set(t, clock++);
            files.delete(f);
            mtimes.delete(f);
            return true;
        },
        async getMtime(p: string) {
            return mtimes.get(p) ?? null;
        },
        async getMetadata(p: string) {
            return files.has(p) ? { path: p, size: 1, ctime: 0, mtime: mtimes.get(p)!, frontmatter: {}, tags: [], links: [] } : null;
        },
        async findByName() {
            return [];
        },
        async listNotesWithMtime() {
            return [];
        },
        async listNotes() {
            return [];
        },
    };
    const index = new SearchIndex();
    for (const [p, c] of files) index.update(p, c, 1000);
    const docs = [
        { type: "vault", slug: "v", displayName: "V", obsidianName: "V", db: "vault-v", archived: false, createdAt: "" },
        { type: "user", username: "u", email: "u@x.com", name: "u", couchPasswordEnc: "", disabled: false, createdAt: "" },
        { type: "grant", username: "u", vault: "v", mode: "write", folders: [] },
        { type: "token", hash: hashToken("t"), username: "u", label: "", createdAt: "" },
    ];
    const tools = new Map<string, any>();
    registerTools({ addTool: (tool: any) => tools.set(tool.name, tool) } as any, makeResolver(() => buildSnapshot(docs), async () => ({ vault: vault as any, index })));
    const session = { authenticated: true, tokenHash: hashToken("t"), identity: { sub: "u" } };
    /** Raw call: rejects with UserError for isError results. */
    const raw = (tool: string, args: Record<string, unknown>) => tools.get(tool).execute(args, { session });
    /** The reply text either way. */
    const call = async (tool: string, args: Record<string, unknown>): Promise<string> => {
        try {
            return await raw(tool, args);
        } catch (err) {
            if (err instanceof UserError) return err.message;
            throw err;
        }
    };
    return { files, index, raw, call };
}

test("errors are isError results, not ordinary text", async () => {
    const { raw } = setup({ "a.md": "x" });
    await assert.rejects(raw("read_note", { path: "missing.md" }), (e: unknown) => e instanceof UserError && /Note not found/.test(e.message));
    await assert.rejects(raw("edit_note", { path: "a.md", content: "y", operation: "replace", old_text: "nope" }), UserError);
});

test("paths without an extension get .md, so new notes stay visible", async () => {
    const { call, files } = setup({});
    assert.match(await call("write_note", { path: "/projects/plan", content: "hi" }), /Note saved: projects\/plan.md \(modified /);
    assert.ok(files.has("projects/plan.md"));
    assert.match(await call("read_note", { path: "projects/plan" }), /hi$/);
    assert.match(await call("list_notes", {}), /projects\/plan.md/);
});

test("not found suggests close paths", async () => {
    const { call } = setup({ "Projects/Plan.md": "x", "Notes/Meeting.md": "y" });
    assert.match(await call("read_note", { path: "projects/plan.md" }), /Note not found: projects\/plan.md\. Did you mean: Projects\/Plan.md\?/);
    assert.match(await call("read_notes", { paths: ["Notes/Meetng.md"] }), /Did you mean: Notes\/Meeting.md\?/);
});

test("list_notes says why it is empty, and pages with offset", async () => {
    const notes = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`n${i}.md`, "x"]));
    const { call, index } = setup(notes);
    assert.match(await call("list_notes", { name: "zzz" }), /No notes match these filters \(name 'zzz'\)\./);
    assert.match(await call("list_notes", { folder: "nowhere" }), /No notes in folder: nowhere\./);
    const first = await call("list_notes", { limit: 2 });
    assert.match(first, /n0.md[\s\S]*n1.md/);
    assert.match(first, /3 more \(5 total\)\. Use offset=2 for the next page\./);
    assert.match(await call("list_notes", { limit: 2, offset: 4 }), /n4.md/);
    index.building = true;
    assert.match(await call("search_notes", { query: "zzz" }), /No notes match: zzz\n\(Search index still building: 5 notes so far/);
});

test("write_note create_only and expected_modified protect existing notes", async () => {
    const { call, files } = setup({ "a.md": "original" });
    assert.match(await call("write_note", { path: "a.md", content: "new", create_only: true }), /Note already exists: a.md/);
    assert.match(await call("write_note", { path: "a.md", content: "new", expected_modified: "1970-01-01T00:00:00.999Z" }), /changed since you read it \(now modified 1970-01-01T00:00:01.000Z\)/);
    assert.equal(files.get("a.md"), "original");
    const read = await call("read_note", { path: "a.md" });
    const stamp = /modified ([^)\s]+)/.exec(read)![1];
    assert.match(await call("edit_note", { path: "a.md", content: "more", expected_modified: stamp }), /Note edited/);
    assert.equal(files.get("a.md"), "original\nmore");
});

test("delete_note moves to _trash by default, hides it, and deletes for good from there", async () => {
    const { call, files } = setup({ "a.md": "x", "_trash/a.md": "older" });
    assert.match(await call("delete_note", { path: "a.md" }), /Moved to trash: _trash\/a \S+\.md\./);
    assert.ok(!files.has("a.md"));
    assert.equal(files.get("_trash/a.md"), "older", "an earlier trashed copy is kept");
    assert.doesNotMatch(await call("list_notes", {}), /_trash/);
    assert.match(await call("list_notes", { folder: "_trash" }), /_trash\/a.md/);
    assert.match(await call("delete_note", { path: "_trash/a.md" }), /Deleted permanently/);
    assert.ok(!files.has("_trash/a.md"));
});

test("set_properties changes frontmatter only", async () => {
    const { call, files } = setup({ "p.md": "---\nstatus: draft\n---\nBody" });
    assert.match(await call("set_properties", { path: "p", properties: { status: "done", owner: "jo" } }), /Properties updated \(status, owner\): p.md/);
    assert.equal(files.get("p.md"), "---\nstatus: done\nowner: jo\n---\nBody");
});
