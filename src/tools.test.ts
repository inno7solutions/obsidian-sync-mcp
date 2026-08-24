import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "./tools.js";
import { makeAccessResolver, parsePolicy } from "./policy.js";

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

/** A vault stub that records writes and serves one existing note. */
function stubVault() {
    const calls: Array<[string, string]> = [];
    return {
        calls,
        async readNote(path: string) {
            return path === "Inbox/existing.md" ? "old" : null;
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
    getTags: () => [],
    listAllTags: () => [],
    getBacklinks: () => [],
} as any;

function register(resolveAccess: any, policyActive = true) {
    const server = stubServer();
    const vault = stubVault();
    registerTools(server as any, vault as any, searchIndex, "MyVault", { resolveAccess, policyActive });
    return { server, vault };
}

const WRITE_TOOLS = ["write_note", "edit_note", "delete_note", "move_note"];
const editorSession = { authenticated: true, identity: { sub: "u1", groups: ["editors"] } };
const readerSession = { authenticated: true, identity: { sub: "u2", groups: ["readers"] } };

const POLICY = parsePolicy(JSON.stringify([
    { group: "editors", writeFolders: ["Inbox"] },
    { group: "*", readOnly: true },
]));

test("read tools are always registered", () => {
    const { server } = register(makeAccessResolver(POLICY, { readOnly: false, writeFolders: null }));
    for (const t of ["read_note", "list_notes", "list_folders", "list_tags", "get_note_metadata"]) {
        assert.ok(server.tools.has(t), `${t} should be registered`);
    }
});

test("write tools are registered but gated by canAccess", () => {
    const { server } = register(makeAccessResolver(POLICY, { readOnly: false, writeFolders: null }));
    for (const t of WRITE_TOOLS) {
        const tool = server.tools.get(t);
        assert.ok(tool, `${t} should be registered`);
        assert.equal(typeof tool.canAccess, "function", `${t} should have canAccess`);
        assert.equal(tool.canAccess(editorSession), true, `editor can access ${t}`);
        assert.equal(tool.canAccess(readerSession), false, `reader cannot access ${t}`);
    }
});

test("write_note enforces the caller's folder scope at call time", async () => {
    const { server, vault } = register(makeAccessResolver(POLICY, { readOnly: false, writeFolders: null }));
    const writeNote = server.tools.get("write_note");

    const denied = await writeNote.execute({ path: "Projects/x.md", content: "hi" }, { session: editorSession });
    assert.match(denied, /Write access denied/);
    assert.match(denied, /Inbox\//); // the message names the caller's actual scope
    assert.equal(vault.calls.length, 0, "denied write must not reach the vault");

    const ok = await writeNote.execute({ path: "Inbox/x.md", content: "hi" }, { session: editorSession });
    assert.match(ok, /Note saved/);
    assert.deepEqual(vault.calls, [["Inbox/x.md", "hi"]]);
});

test("move_note requires both ends to be writable", async () => {
    const { server } = register(makeAccessResolver(POLICY, { readOnly: false, writeFolders: null }));
    const moveNote = server.tools.get("move_note");
    // Source in scope, destination out of scope → denied.
    const denied = await moveNote.execute({ from: "Inbox/a.md", to: "Projects/a.md" }, { session: editorSession });
    assert.match(denied, /Write access denied/);
    assert.match(denied, /Projects/); // names the offending path
});

test("the process ceiling overrides a permissive policy", () => {
    // Policy says editors write Inbox, but the container is read-only.
    const { server } = register(makeAccessResolver(POLICY, { readOnly: true, writeFolders: null }));
    for (const t of WRITE_TOOLS) {
        assert.equal(server.tools.get(t).canAccess(editorSession), false, `${t} hidden under read-only ceiling`);
    }
});

test("no policy: canAccess follows the ceiling for everyone", () => {
    const openResolver = makeAccessResolver(null, { readOnly: false, writeFolders: null });
    const { server: open } = register(openResolver, false);
    assert.equal(open.tools.get("write_note").canAccess(readerSession), true);

    const roResolver = makeAccessResolver(null, { readOnly: true, writeFolders: null });
    const { server: ro } = register(roResolver, false);
    assert.equal(ro.tools.get("write_note").canAccess(readerSession), false);
});
