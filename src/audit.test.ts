import { test } from "node:test";
import assert from "node:assert/strict";
import {
    actorFromSession,
    redactArgs,
    buildAuditEvent,
    formatAuditLine,
    makeAuditLogger,
} from "./audit.js";

// --- actorFromSession ---

test("actorFromSession: prefers email, keeps sub", () => {
    assert.deepEqual(actorFromSession({ identity: { sub: "u1", email: "jane@inno7.com" } }), {
        actor: "jane@inno7.com",
        sub: "u1",
    });
});

test("actorFromSession: falls back to sub when no email", () => {
    assert.deepEqual(actorFromSession({ identity: { sub: "u1" } }), { actor: "u1", sub: "u1" });
});

test("actorFromSession: anonymous with no identity (password / no-auth mode)", () => {
    assert.deepEqual(actorFromSession({ authenticated: true }), { actor: "anonymous" });
    assert.deepEqual(actorFromSession(undefined), { actor: "anonymous" });
});

// --- redactArgs ---

test("redactArgs: keeps allowlisted keys only", () => {
    const out = redactArgs({ path: "Inbox/x.md", folder: "Inbox", operation: "append", limit: 10, mystery: "drop me" });
    assert.deepEqual(out, { path: "Inbox/x.md", folder: "Inbox", operation: "append", limit: 10 });
});

test("redactArgs: never logs note bodies, only their sizes", () => {
    const out = redactArgs({ path: "x.md", content: "secret body", old_text: "was here" });
    assert.equal(out.content, undefined);
    assert.equal(out.old_text, undefined);
    assert.equal(out.content_len, Buffer.byteLength("secret body"));
    assert.equal(out.old_text_len, Buffer.byteLength("was here"));
    assert.equal(out.path, "x.md");
});

test("redactArgs: content_len counts bytes, not code units", () => {
    // A 4-byte emoji is one JS code unit pair but 4 UTF-8 bytes.
    assert.equal(redactArgs({ content: "😀" }).content_len, 4);
});

test("redactArgs: tolerates non-object args", () => {
    assert.deepEqual(redactArgs(undefined), {});
    assert.deepEqual(redactArgs("nope"), {});
});

// --- buildAuditEvent ---

const NOW = "2026-08-24T12:00:00.000Z";

test("buildAuditEvent: records actor, tool, outcome, redacted params", () => {
    const e = buildAuditEvent({
        vault: "Team",
        tool: "write_note",
        args: { path: "Inbox/x.md", content: "hello" },
        session: { identity: { sub: "u1", email: "jane@inno7.com" } },
        outcome: "ok",
        ms: 12.7,
        now: NOW,
    });
    assert.equal(e.ts, NOW);
    assert.equal(e.evt, "tool_call");
    assert.equal(e.vault, "Team");
    assert.equal(e.actor, "jane@inno7.com");
    assert.equal(e.sub, "u1");
    assert.equal(e.tool, "write_note");
    assert.equal(e.outcome, "ok");
    assert.equal(e.ms, 13); // rounded
    assert.deepEqual(e.params, { path: "Inbox/x.md", content_len: 5 });
    assert.equal(e.destructive, undefined);
});

test("buildAuditEvent: flags destructive tools", () => {
    for (const tool of ["delete_note", "move_note"]) {
        const e = buildAuditEvent({ vault: "V", tool, args: {}, session: {}, outcome: "ok", ms: 1, now: NOW });
        assert.equal(e.destructive, true, `${tool} should be flagged destructive`);
    }
    const read = buildAuditEvent({ vault: "V", tool: "read_note", args: {}, session: {}, outcome: "ok", ms: 1, now: NOW });
    assert.equal(read.destructive, undefined);
});

test("buildAuditEvent: records denials and errors", () => {
    const denied = buildAuditEvent({ vault: "V", tool: "write_note", args: {}, session: {}, outcome: "denied", ms: 1, now: NOW });
    assert.equal(denied.outcome, "denied");

    const errored = buildAuditEvent({
        vault: "V",
        tool: "write_note",
        args: {},
        session: {},
        outcome: "error",
        ms: 1,
        error: "x".repeat(500),
        now: NOW,
    });
    assert.equal(errored.outcome, "error");
    assert.equal(errored.error!.length, 300, "error message is truncated");
});

test("buildAuditEvent: carries session and request ids when present", () => {
    const e = buildAuditEvent({
        vault: "V",
        tool: "read_note",
        args: {},
        session: {},
        outcome: "ok",
        ms: 1,
        sessionId: "s1",
        requestId: "r1",
        now: NOW,
    });
    assert.equal(e.sessionId, "s1");
    assert.equal(e.requestId, "r1");
});

// --- formatAuditLine ---

test("formatAuditLine: single-line JSON with no embedded newline", () => {
    const line = formatAuditLine(
        buildAuditEvent({ vault: "V", tool: "read_note", args: { path: "a.md" }, session: {}, outcome: "ok", ms: 1, now: NOW }),
    );
    assert.ok(!line.includes("\n"));
    assert.deepEqual(JSON.parse(line).params, { path: "a.md" });
});

test("formatAuditLine: a note body never appears in the serialized line", () => {
    const line = formatAuditLine(
        buildAuditEvent({
            vault: "V",
            tool: "write_note",
            args: { path: "a.md", content: "TOP SECRET", old_text: "ALSO SECRET" },
            session: {},
            outcome: "ok",
            ms: 1,
            now: NOW,
        }),
    );
    assert.ok(!line.includes("TOP SECRET"));
    assert.ok(!line.includes("ALSO SECRET"));
});

// --- makeAuditLogger ---

test("makeAuditLogger: disabled logger is a no-op", () => {
    let calls = 0;
    const logger = makeAuditLogger({ vault: "V", enabled: false, sink: () => calls++ });
    assert.equal(logger.enabled, false);
    logger.record({ tool: "read_note", args: {}, session: {}, outcome: "ok", ms: 1 });
    assert.equal(calls, 0);
});

test("makeAuditLogger: enabled logger emits one line per call to the sink", () => {
    const lines: string[] = [];
    const logger = makeAuditLogger({ vault: "V", enabled: true, sink: (l) => lines.push(l) });
    logger.record({
        tool: "delete_note",
        args: { path: "a.md" },
        session: { identity: { sub: "u1", email: "j@x.com" } },
        outcome: "ok",
        ms: 3,
    });
    assert.equal(lines.length, 1);
    const e = JSON.parse(lines[0]);
    assert.equal(e.actor, "j@x.com");
    assert.equal(e.tool, "delete_note");
    assert.equal(e.destructive, true);
});

test("makeAuditLogger: a throwing sink never propagates to the caller", () => {
    const logger = makeAuditLogger({
        vault: "V",
        enabled: true,
        sink: () => {
            throw new Error("disk full");
        },
    });
    // Must not throw — auditing cannot break a tool call.
    assert.doesNotThrow(() => logger.record({ tool: "read_note", args: {}, session: {}, outcome: "ok", ms: 1 }));
});
