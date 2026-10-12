import { test } from "node:test";
import assert from "node:assert/strict";
import { rewriteLinks, type LinkMove } from "./link-rewrite.js";

const move = (over: Partial<LinkMove> = {}): LinkMove => ({ from: "notes/Old Name.md", to: "archive/New Name.md", bareNameWasUnique: true, bareNameStaysUnique: true, ...over });
const rw = (content: string, over?: Partial<LinkMove>) => rewriteLinks(content, move(over));

test("wikilinks: bare, path, extension, heading, block, alias and embed keep their style", () => {
    const { content, count } = rw(
        "[[Old Name]] [[notes/Old Name]] [[notes/Old Name.md]] [[Old Name#Intro]] [[Old Name^abc]] [[Old Name|shown]] ![[Old Name]] [[old name]]",
    );
    assert.equal(
        content,
        "[[New Name]] [[archive/New Name]] [[archive/New Name.md]] [[New Name#Intro]] [[New Name^abc]] [[New Name|shown]] ![[New Name]] [[New Name]]",
    );
    assert.equal(count, 8);
});

test("bare names: ambiguous before → untouched; ambiguous after → full path", () => {
    assert.deepEqual(rw("[[Old Name]] [[notes/Old Name]]", { bareNameWasUnique: false }), { content: "[[Old Name]] [[archive/New Name]]", count: 1 });
    assert.equal(rw("[[Old Name|x]]", { bareNameStaysUnique: false }).content, "[[archive/New Name|x]]");
});

test("markdown links: plain, encoded, with heading and title; external links untouched", () => {
    const m = { from: "notes/plan.md", to: "archive/q3 plan.md" };
    assert.equal(rw("[a](notes/plan.md)", m).content, "[a](archive/q3%20plan.md)", "a space forces encoding");
    assert.equal(rw("[a](notes/plan.md#goals \"t\")", { ...m, to: "archive/plan.md" }).content, "[a](archive/plan.md#goals \"t\")");
    assert.equal(rw("[a](notes/Old%20Name.md)").content, "[a](archive/New%20Name.md)");
    assert.equal(rw("[a](https://x.com/notes/Old%20Name.md) [b](obsidian://open?file=Old)").count, 0);
});

test("attachments keep their extension; other files and code fences are left alone", () => {
    const att = { from: "img/a.png", to: "media/b.png" };
    assert.equal(rw("![[a.png]] ![](img/a.png) [[a]]", att).content, "![[b.png]] ![](media/b.png) [[a]]");
    assert.equal(rw("[[Other]] [[notes/Old Name 2]]").count, 0);
    assert.deepEqual(rw("```\n[[Old Name]]\n```\n[[Old Name]]"), { content: "```\n[[Old Name]]\n```\n[[New Name]]", count: 1 });
});

test("a move that keeps the file name leaves bare links alone; only real changes count", () => {
    assert.deepEqual(rewriteLinks("![[pic.png]] ![](img/pic.png)", { from: "img/pic.png", to: "media/pic.png", bareNameWasUnique: true, bareNameStaysUnique: true }), {
        content: "![[pic.png]] ![](media/pic.png)",
        count: 1,
    });
});
