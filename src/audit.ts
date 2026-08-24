/**
 * Audit logging (Phase 3): one structured line per tool call, carrying who did
 * it. fastmcp's own `onToolCall` hook sees only {toolName, arguments} — no
 * identity — so audit is emitted from the `addTool` wrapper in tools.ts, which
 * has `ctx.session` (and therefore the Phase 1 identity), timing, and the
 * result.
 *
 * Redaction is by allowlist, not blocklist: only known-safe argument keys are
 * logged, so note bodies (`content`, `old_text`) can never leak through a new
 * tool parameter. Their sizes are logged instead. Note that paths are still
 * sensitive in an E2E vault — the log reveals vault structure even though it
 * holds no note content — so treat the audit stream as confidential.
 *
 * The formatting and redaction are pure functions, tested without a server.
 */

/** Argument keys that are safe to record verbatim. Everything else is dropped. */
const ALLOWED_ARG_KEYS = [
    "path",
    "from",
    "to",
    "folder",
    "tag",
    "operation",
    "name",
    "sort_by",
    "modified_after",
    "limit",
] as const;

/** Tools whose effect is hard to reverse — flagged for easy alerting. */
const DESTRUCTIVE_TOOLS = new Set(["delete_note", "move_note"]);

export type AuditOutcome = "ok" | "denied" | "error";

export interface AuditEvent {
    ts: string;
    evt: "tool_call";
    vault: string;
    actor: string;
    sub?: string;
    tool: string;
    outcome: AuditOutcome;
    ms: number;
    destructive?: true;
    params: Record<string, unknown>;
    error?: string;
    sessionId?: string;
    requestId?: string;
}

/** Minimal shape we read off a session; identity is present only in IdP mode. */
interface SessionLike {
    identity?: { sub?: string; email?: string };
}

/** Resolve a human-facing actor and the stable subject id from a session. */
export function actorFromSession(session: unknown): { actor: string; sub?: string } {
    if (session && typeof session === "object" && "identity" in session) {
        const id = (session as SessionLike).identity;
        if (id && typeof id === "object") {
            const sub = typeof id.sub === "string" ? id.sub : undefined;
            const email = typeof id.email === "string" ? id.email : undefined;
            if (email || sub) return { actor: email ?? sub!, sub };
        }
    }
    // Password or no-auth mode: no per-caller identity exists.
    return { actor: "anonymous" };
}

/**
 * Reduce raw tool arguments to an allowlisted, size-bounded record.
 * Note bodies are never included; their byte lengths are, as `content_len` /
 * `old_text_len`, so volume is auditable without exposing text.
 */
export function redactArgs(args: unknown): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!args || typeof args !== "object") return out;
    const a = args as Record<string, unknown>;
    for (const key of ALLOWED_ARG_KEYS) {
        if (a[key] !== undefined) out[key] = a[key];
    }
    if (typeof a.content === "string") out.content_len = Buffer.byteLength(a.content);
    if (typeof a.old_text === "string") out.old_text_len = Buffer.byteLength(a.old_text);
    return out;
}

/** Build an audit event. `now` and timing are injected so the function stays pure. */
export function buildAuditEvent(input: {
    vault: string;
    tool: string;
    args: unknown;
    session: unknown;
    outcome: AuditOutcome;
    ms: number;
    error?: string;
    sessionId?: string;
    requestId?: string;
    now: string;
}): AuditEvent {
    const { actor, sub } = actorFromSession(input.session);
    const event: AuditEvent = {
        ts: input.now,
        evt: "tool_call",
        vault: input.vault,
        actor,
        tool: input.tool,
        outcome: input.outcome,
        ms: Math.round(input.ms),
        params: redactArgs(input.args),
    };
    if (sub) event.sub = sub;
    if (DESTRUCTIVE_TOOLS.has(input.tool)) event.destructive = true;
    if (input.error) event.error = input.error.slice(0, 300);
    if (input.sessionId) event.sessionId = input.sessionId;
    if (input.requestId) event.requestId = input.requestId;
    return event;
}

/** One JSON line, suitable for a container log pipeline. */
export function formatAuditLine(event: AuditEvent): string {
    return JSON.stringify(event);
}

export type AuditSink = (line: string) => void;

export interface AuditLogger {
    enabled: boolean;
    record(input: {
        tool: string;
        args: unknown;
        session: unknown;
        outcome: AuditOutcome;
        ms: number;
        error?: string;
        sessionId?: string;
        requestId?: string;
    }): void;
}

/**
 * Build the audit logger. Disabled loggers are a cheap no-op so the wrapper can
 * call `record` unconditionally. The default sink is stdout as one JSON line per
 * event; a deployment ships those wherever its logs go.
 */
export function makeAuditLogger(opts: { vault: string; enabled: boolean; sink?: AuditSink }): AuditLogger {
    if (!opts.enabled) {
        return { enabled: false, record() {} };
    }
    const sink: AuditSink = opts.sink ?? ((line) => console.log(line));
    return {
        enabled: true,
        record(input) {
            try {
                const event = buildAuditEvent({ ...input, vault: opts.vault, now: new Date().toISOString() });
                sink(formatAuditLine(event));
            } catch (err) {
                // Auditing must never break a tool call.
                console.error("Audit logging failed:", (err as Error).message);
            }
        },
    };
}
