import { test } from "node:test";
import assert from "node:assert/strict";
import { readFrontmatter, setProperties } from "./frontmatter.js";
import { closestPaths } from "./suggest.js";

test("readFrontmatter keeps nested values and lists; CRLF and broken YAML are handled", () => {
    assert.deepEqual(readFrontmatter("---\naliases:\n  - A\n  - B\nmeta:\n  owner: jo\ncount: 3\n---\nbody"), { aliases: ["A", "B"], meta: { owner: "jo" }, count: 3 });
    assert.deepEqual(readFrontmatter("---\r\ntitle: x\r\n---\r\nbody"), { title: "x" });
    assert.deepEqual(readFrontmatter("---\n: : bad\n---\n"), {});
    assert.deepEqual(readFrontmatter("no frontmatter"), {});
});

test("setProperties edits in place, keeps comments and body, removes with null", () => {
    const note = "---\n# owner comment\nstatus: draft\ntags: [a]\n---\nBody text\n";
    const out = setProperties(note, { status: "done", due: "2026-10-31", tags: ["a", "b"], draft: null });
    assert.match(out, /# owner comment/);
    assert.match(out, /status: done/);
    assert.match(out, /due: 2026-10-31/);
    assert.deepEqual(readFrontmatter(out).tags, ["a", "b"]);
    assert.ok(out.endsWith("---\nBody text\n"));
    assert.equal(setProperties("Body", { status: "new" }), "---\nstatus: new\n---\nBody");
    assert.equal(setProperties("---\nstatus: x\n---\nBody", { status: null }), "Body", "last property removed → no empty block");
    assert.throws(() => setProperties("---\nkey: [unclosed\n---\n", { a: "b" }), /not valid YAML/);
});

test("closestPaths: same file name first, then near misses, nothing far away", () => {
    const paths = ["Projects/Plan.md", "Archive/plan.md", "Daily/2026-10-01.md", "Notes/Meeting.md"];
    assert.deepEqual(closestPaths("plan.md", paths), ["Archive/plan.md", "Projects/Plan.md"]);
    assert.deepEqual(closestPaths("notes/meetng.md", paths), ["Notes/Meeting.md"]);
    assert.deepEqual(closestPaths("notes/Meetng", paths), ["Notes/Meeting.md"], "missing .md is not a typo");
    assert.deepEqual(closestPaths("totally/unrelated.md", paths), []);
});
