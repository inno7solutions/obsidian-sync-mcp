/**
 * End-to-end acceptance test for IdP auth mode (Phases 1–3) against a real
 * OIDC provider — a local stub standing in for Keycloak / Authentik / Okta.
 *
 * This closes the "pending a live-IdP acceptance run" gap for the generic
 * provider: it drives the entire OAuth 2.1 + PKCE dance through fastmcp's proxy
 * (DCR → authorize → consent → upstream login → callback → token) exactly as a
 * real MCP client would, then exercises identity, the group gate, per-caller
 * POLICY, and the audit log over the wire.
 *
 * Run: npm run test:idp   (builds, then spawns dist/main.js against the stub)
 * No external services or network — the stub and the server are both local.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHmac, createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const STUB_PORT = Number(process.env.STUB_PORT ?? 8821);
const MCP_PORT = Number(process.env.MCP_PORT ?? 8822);
const STUB = `http://127.0.0.1:${STUB_PORT}`;
const BASE = `http://127.0.0.1:${MCP_PORT}`;
const CALLBACK = "http://localhost:9999/cb"; // the "client" redirect URI

// --- tiny JWT + PKCE helpers ---
const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");
function idToken(claims: Record<string, unknown>): string {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(JSON.stringify({ iss: STUB, aud: "vault-mcp", iat: now, exp: now + 3600, ...claims }));
    const sig = createHmac("sha256", "stub-secret").update(`${header}.${payload}`).digest("base64url");
    return `${header}.${payload}.${sig}`;
}
const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
};

// --- OIDC provider stub ---
// The "logged-in user" for the next login. Tests set this before driving OAuth.
let currentClaims: Record<string, unknown> = {};
let stub: Server;
let mcp: ChildProcess;
let dataDir: string;
let auditFile: string;

function startStub(): Promise<void> {
    stub = createServer((req, res) => {
        const url = new URL(req.url ?? "/", STUB);
        if (url.pathname === "/authorize") {
            // Auto-approve: bounce straight back to the proxy callback with a code.
            const redirectUri = url.searchParams.get("redirect_uri")!;
            const state = url.searchParams.get("state") ?? "";
            const to = new URL(redirectUri);
            to.searchParams.set("code", "stub-code-" + randomBytes(6).toString("hex"));
            to.searchParams.set("state", state);
            res.writeHead(302, { Location: to.toString() }).end();
            return;
        }
        if (url.pathname === "/token" && req.method === "POST") {
            const body = JSON.stringify({
                access_token: "stub-access",
                token_type: "Bearer",
                expires_in: 3600,
                refresh_token: "stub-refresh",
                scope: "openid profile email",
                id_token: idToken(currentClaims),
            });
            res.writeHead(200, { "Content-Type": "application/json" }).end(body);
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise((resolve) => stub.listen(STUB_PORT, "127.0.0.1", () => resolve()));
}

async function waitForHealth(): Promise<void> {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await fetch(`${BASE}/health`);
            if (r.ok) return;
        } catch {
            /* not up yet */
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("MCP server did not become healthy");
}

before(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "idp-e2e-"));
    const vaultDir = join(dataDir, "vault");
    await mkdtemp(vaultDir).catch(() => {});
    await rm(vaultDir, { recursive: true, force: true }).catch(() => {});
    const fs = await import("node:fs/promises");
    await fs.mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, "seed.md"), "# seed\n");
    auditFile = join(dataDir, "audit.jsonl");

    await startStub();

    mcp = spawn("node", ["dist/main.js"], {
        env: {
            ...process.env,
            IDP_PROVIDER: "generic",
            IDP_CLIENT_ID: "vault-mcp",
            IDP_CLIENT_SECRET: "vault-mcp-secret",
            IDP_AUTHORIZATION_ENDPOINT: `${STUB}/authorize`,
            IDP_TOKEN_ENDPOINT: `${STUB}/token`,
            IDP_REQUIRED_GROUPS: "vault-team",
            IDP_GROUPS_CLAIM: "groups",
            IDP_ALLOWED_REDIRECT_URIS: "http://localhost:*",
            POLICY: JSON.stringify([
                { group: "vault-editors", writeFolders: ["Inbox"] },
                { group: "*", readOnly: true },
            ]),
            VAULT_PATH: vaultDir,
            DATA_DIR: join(dataDir, "data"),
            AUDIT_LOG_FILE: auditFile,
            BASE_URL: BASE,
            HOST: "127.0.0.1",
            PORT: String(MCP_PORT),
        },
        stdio: ["ignore", "inherit", "inherit"],
    });
    await waitForHealth();
});

after(async () => {
    mcp?.kill("SIGTERM");
    await new Promise((r) => stub?.close(() => r(null)));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
});

/** Drive the whole OAuth flow as an MCP client and return a proxy access token. */
async function login(claims: Record<string, unknown>): Promise<string> {
    currentClaims = claims;

    // 1. Dynamic client registration.
    const reg = await fetch(`${BASE}/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: [CALLBACK], client_name: "test-client" }),
    }).then((r) => r.json());
    const clientId = reg.client_id as string;

    // 2. Authorize → consent screen.
    const { verifier, challenge } = pkce();
    const authUrl = new URL(`${BASE}/oauth/authorize`);
    authUrl.search = new URLSearchParams({
        response_type: "code",
        client_id: clientId,
        redirect_uri: CALLBACK,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "client-state",
        scope: "openid profile email",
    }).toString();
    const consentHtml = await fetch(authUrl, { redirect: "manual" }).then((r) => r.text());
    const txn = consentHtml.match(/name="transaction_id" value="([^"]+)"/)?.[1];
    assert.ok(txn, "consent screen should carry a transaction_id");

    // 3. Approve consent → 302 to the upstream (stub) authorize endpoint.
    const afterConsent = await fetch(`${BASE}/oauth/consent`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ transaction_id: txn!, action: "approve" }),
        redirect: "manual",
    });
    const upstreamUrl = afterConsent.headers.get("location")!;
    assert.ok(upstreamUrl.startsWith(`${STUB}/authorize`), "consent should redirect to the upstream IdP");

    // 4. Upstream auto-approves → 302 back to the proxy callback.
    const toCallback = await fetch(upstreamUrl, { redirect: "manual" });
    const callbackUrl = toCallback.headers.get("location")!;
    assert.ok(callbackUrl.startsWith(`${BASE}/oauth/callback`), "IdP should redirect to the proxy callback");

    // 5. Proxy callback exchanges the code upstream (server-side) → 302 to the client redirect.
    const toClient = await fetch(callbackUrl, { redirect: "manual" });
    const clientRedirect = toClient.headers.get("location")!;
    assert.ok(clientRedirect.startsWith(CALLBACK), "proxy should redirect back to the client");
    const code = new URL(clientRedirect).searchParams.get("code");
    assert.ok(code, "client should receive an authorization code");

    // 6. Exchange the code for the proxy's access token.
    const token = await fetch(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code!,
            redirect_uri: CALLBACK,
            client_id: clientId,
            code_verifier: verifier,
        }),
    }).then((r) => r.json());
    assert.ok(token.access_token, `token exchange should succeed: ${JSON.stringify(token)}`);
    return token.access_token as string;
}

/** Minimal MCP client: initialize, then one request. Returns the parsed JSON-RPC result. */
async function mcpCall(bearer: string, method: string, params?: unknown): Promise<any> {
    const headers = (sid?: string) => ({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
        ...(sid ? { "mcp-session-id": sid } : {}),
    });
    const initRes = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        }),
    });
    if (initRes.status === 401 || initRes.status === 403) return { httpStatus: initRes.status };
    const sid = initRes.headers.get("mcp-session-id")!;
    await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: headers(sid),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    const res = await fetch(`${BASE}/mcp`, {
        method: "POST",
        headers: headers(sid),
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
    });
    const text = await res.text();
    const line = text.split("\n").find((l) => l.startsWith("data: ")) ?? text;
    return JSON.parse(line.replace(/^data: /, "")).result;
}

const EDITOR = { sub: "u-editor", email: "editor@inno7.com", name: "Ed", groups: ["vault-team", "vault-editors"] };
const READER = { sub: "u-reader", email: "reader@inno7.com", groups: ["vault-team"] };
const OUTSIDER = { sub: "u-out", email: "out@evil.com", groups: ["random"] };

test("editor: signs in, sees write tools, and writes only inside their folder", async () => {
    const token = await login(EDITOR);

    const list = await mcpCall(token, "tools/list");
    const names = list.tools.map((t: any) => t.name).sort();
    assert.ok(names.includes("write_note"), "editor should see write_note");

    const ok = await mcpCall(token, "tools/call", { name: "write_note", arguments: { path: "Inbox/hello.md", content: "hi" } });
    assert.match(ok.content[0].text, /Note saved/, "write inside Inbox should succeed");

    const denied = await mcpCall(token, "tools/call", { name: "write_note", arguments: { path: "Projects/x.md", content: "no" } });
    assert.match(denied.content[0].text, /Write access denied/, "write outside Inbox should be denied");
});

test("reader: signs in but the write tools are hidden entirely", async () => {
    const token = await login(READER);
    const list = await mcpCall(token, "tools/list");
    const names = list.tools.map((t: any) => t.name);
    assert.ok(!names.includes("write_note"), "reader should not see write_note");
    assert.ok(names.includes("read_note"), "reader should still see read_note");
});

test("outsider: not in the required group, so cannot reach the tools at all", async () => {
    const token = await login(OUTSIDER);
    const res = await mcpCall(token, "tools/list");
    assert.equal(res.httpStatus, 403, "a caller outside vault-team should be forbidden");
});

test("audit log names the real actor and never records note bodies", async () => {
    const lines = (await readFile(auditFile, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
    const write = lines.find((e) => e.tool === "write_note" && e.outcome === "ok");
    assert.ok(write, "the successful write should be audited");
    assert.equal(write.actor, "editor@inno7.com", "actor is the real identity, not anonymous");
    assert.equal(write.sub, "u-editor");
    assert.equal(write.params.content_len, 2);
    assert.ok(!JSON.stringify(lines).includes('"hi"'), "note body must not appear in the audit log");

    const denied = lines.find((e) => e.tool === "write_note" && e.outcome === "denied");
    assert.ok(denied, "the denied write should be audited too");
});
