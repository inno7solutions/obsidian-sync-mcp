import { test } from "node:test";
import assert from "node:assert/strict";
import { isWritable, describeAccess } from "./policy.js";

const READ_ONLY = { readOnly: true, writeFolders: [] };

test("isWritable: enforces folder scope and denies when read-only", () => {
    const scoped = { readOnly: false, writeFolders: ["Inbox"] };
    assert.equal(isWritable(scoped, "Inbox/note.md"), true);
    assert.equal(isWritable(scoped, "Projects/note.md"), false);
    assert.equal(isWritable({ readOnly: false, writeFolders: null }, "anywhere.md"), true);
    assert.equal(isWritable(READ_ONLY, "Inbox/note.md"), false);
});

test("isWritable: blocks traversal even inside a writable folder", () => {
    assert.equal(isWritable({ readOnly: false, writeFolders: ["Inbox"] }, "Inbox/../secret.md"), false);
});

test("describeAccess: readable summaries for denial messages", () => {
    assert.equal(describeAccess(READ_ONLY), "read-only");
    assert.equal(describeAccess({ readOnly: false, writeFolders: [] }), "read-only");
    assert.equal(describeAccess({ readOnly: false, writeFolders: null }), "the whole vault");
    assert.equal(describeAccess({ readOnly: false, writeFolders: ["Inbox", "Projects"] }), "Inbox/, Projects/");
});
