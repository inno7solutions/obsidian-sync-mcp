import { FastMCP } from "fastmcp";
import { join } from "path";
import { readFileSync, statSync, createWriteStream, chmodSync } from "fs";
import { setGlobalLogFunction, LEVEL_INFO } from "octagonal-wheels/common/logger";
import { makeAuditLogger, type AuditSink } from "./audit.js";
import { Couch } from "./registry/couch.js";
import { RegistryStore } from "./registry/store.js";
import type { Snapshot } from "./registry/model.js";

// Suppress livesync-commonlib logs that expose vault file paths in production.
// Set LOG_LEVEL=debug to see all library logs during development.
const debugLogging = process.env.LOG_LEVEL === "debug";
setGlobalLogFunction((message, level = LEVEL_INFO) => {
    if (level < LEVEL_INFO) return;
    if (!debugLogging && typeof message === "string") {
        if (/^(GET|PUT|DELETE|WATCH|FOLLOW|Sensible merge|Object merge):/.test(message)) return;
        if (message.includes("replicator") || message.includes("Replicator") || message.includes("ReplicatorService")) return;
    }
    console.log(message);
});

// Prevent unhandled rejections from crashing the server (e.g. decryption failures in watcher)
process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
});

function required(name: string): string {
    const v = process.env[name]?.trim();
    if (!v) {
        console.error(`${name} is required.`);
        process.exit(1);
    }
    return v;
}

// --- Configuration shared by both roles ---
const ROLE = process.env.ROLE ?? "mcp";
const COUCHDB_URL = required("COUCHDB_URL");
const REGISTRY_DB = process.env.REGISTRY_DB?.trim() || "mcp_registry";
const REGISTRY_KEY = required("REGISTRY_KEY");
const SERVICE_USER = process.env.MCP_SERVICE_USER?.trim() || "mcp-service";
const SERVICE_PASSWORD = required("MCP_SERVICE_PASSWORD");
const HOST = process.env.HOST ?? (ROLE === "admin" ? "127.0.0.1" : "0.0.0.0");
const PORT = parseInt(process.env.PORT ?? (ROLE === "admin" ? "8788" : "8787"));

if (REGISTRY_KEY.length < 16) {
    console.error("REGISTRY_KEY must be a long random secret (>= 16 chars); it encrypts vault E2E passphrases.");
    process.exit(1);
}

// --- Audit logging ---
// One JSON line per tool call / admin action. On by default; AUDIT_LOG=off
// disables. Stdout always; AUDIT_LOG_FILE additionally appends to a 0600 file.
const auditEnabled = (process.env.AUDIT_LOG ?? "on").toLowerCase() !== "off";
const auditFile = process.env.AUDIT_LOG_FILE?.trim() || undefined;
let auditSink: AuditSink | undefined;
if (auditEnabled && auditFile) {
    const stream = createWriteStream(auditFile, { flags: "a", mode: 0o600 });
    try {
        chmodSync(auditFile, 0o600);
    } catch {
        // Best effort: the file may live on a filesystem that ignores chmod.
    }
    auditSink = (line: string) => {
        console.log(line); // still to stdout, so both places have it
        stream.write(line + "\n");
    };
}
const audit = makeAuditLogger({ enabled: auditEnabled, sink: auditSink });
console.log(auditEnabled ? `Audit logging enabled${auditFile ? ` (stdout + ${auditFile})` : " (stdout)"}.` : "Audit logging disabled (AUDIT_LOG=off).");

if (ROLE === "admin") await startAdmin();
else if (ROLE === "mcp") await startMcp();
else {
    console.error(`Unknown ROLE '${ROLE}': use 'mcp' or 'admin'.`);
    process.exit(1);
}

async function startAdmin() {
    const { serve } = await import("@hono/node-server");
    const { Provisioner } = await import("./registry/provision.js");
    const { createAdminApp } = await import("./admin/ui.js");

    // Admin-only: the MCP role never holds it, so an MCP compromise can't recover users' CouchDB passwords.
    const credentialsKey = required("CREDENTIALS_KEY");
    if (credentialsKey.length < 16 || credentialsKey === REGISTRY_KEY) {
        console.error("CREDENTIALS_KEY must be a long random secret (>= 16 chars), different from REGISTRY_KEY.");
        process.exit(1);
    }
    const couch = new Couch(COUCHDB_URL, required("COUCHDB_ADMIN_USER"), required("COUCHDB_ADMIN_PASSWORD"));
    const store = new RegistryStore(couch, REGISTRY_DB);
    const provisioner = new Provisioner({
        couch,
        store,
        registryKey: REGISTRY_KEY,
        credentialsKey,
        serviceUser: SERVICE_USER,
        servicePassword: SERVICE_PASSWORD,
        publicCouchUrl: process.env.PUBLIC_COUCHDB_URL?.trim() || COUCHDB_URL,
    });
    await retry("CouchDB bootstrap", () => provisioner.bootstrap());

    const adminToken = required("ADMIN_TOKEN");
    if (adminToken.length < 16) {
        console.error("ADMIN_TOKEN must be a long random secret (>= 16 chars).");
        process.exit(1);
    }
    const app = createAdminApp({
        adminToken,
        provisioner,
        store,
        audit,
        serviceUser: SERVICE_USER,
        publicMcpUrl: process.env.PUBLIC_MCP_URL?.trim() || "http://localhost:8787/mcp",
    });
    serve({ fetch: app.fetch, port: PORT, hostname: HOST });
    console.log(`Admin UI listening on http://${HOST}:${PORT}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
        console.warn("WARNING: the admin UI holds CouchDB admin credentials; expose it only on a private network.");
    }
}

async function startMcp() {
    const { VaultManager } = await import("./vault-manager.js");
    const { registerTools } = await import("./tools.js");
    const { makeAuthenticate, makeResolver } = await import("./mcp-access.js");

    const couch = new Couch(COUCHDB_URL, SERVICE_USER, SERVICE_PASSWORD);
    const store = new RegistryStore(couch, REGISTRY_DB);
    const baseDataDir = process.env.DATA_DIR ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "/tmp", ".obsidian-mcp");
    const manager = new VaultManager({ couchdbUrl: COUCHDB_URL, user: SERVICE_USER, password: SERVICE_PASSWORD, registryKey: REGISTRY_KEY, dataDir: baseDataDir });

    // The admin role creates the registry; wait for it rather than failing.

    let snapshot: Snapshot = await retry("Registry load", () => store.load());
    manager.sync(snapshot);
    store.watch((s) => {
        snapshot = s;
        manager.sync(s);
    });
    console.log(`Registry loaded: ${snapshot.vaults.size} vaults, ${snapshot.users.size} users.`);

    const server = new FastMCP({
        name: "obsidian-sync-mcp",
        version: (process.env.npm_package_version ?? "0.0.0") as `${number}.${number}.${number}`,
        instructions: instructions(),
        authenticate: makeAuthenticate(() => snapshot),
    });
    registerTools(server, makeResolver(() => snapshot, (slug) => manager.get(slug)), audit);

    const shutdown = async () => {
        console.log("Shutting down...");
        await manager.saveAll();
        await manager.closeAll();
        process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    setInterval(() => manager.saveAll(), 5 * 60 * 1000).unref();

    server.start({ transportType: "httpStream", httpStream: { port: PORT, endpoint: "/mcp", host: HOST } });
    console.log(`obsidian-sync-mcp v${process.env.npm_package_version ?? "unknown"} listening on ${HOST}:${PORT}/mcp`);
}

/** Base instructions plus MCP_INSTRUCTIONS_FILE (wins) or MCP_INSTRUCTIONS. A missing or oversized file is fatal. */
function instructions(): string {
    const base =
        "Access and manage Obsidian vaults. Call list_vaults first if you do not know which vault to use, and pass its id as the 'vault' argument. " +
        "You can read, write, list, search, move, and delete markdown notes. Every tool response includes an Obsidian deep link. Always show this link to the user using the format [obsidian://open?vault=...&file=...](obsidian://open?vault=...&file=...) so it is both clickable and visible as a URL.";
    const file = process.env.MCP_INSTRUCTIONS_FILE?.trim();
    const MAX_BYTES = 32 * 1024;
    let extra = process.env.MCP_INSTRUCTIONS?.trim() || undefined;
    if (file) {
        try {
            const size = statSync(file).size;
            if (size > MAX_BYTES) throw new Error(`file is ${size} bytes, exceeds ${MAX_BYTES} byte cap`);
            extra = readFileSync(file, "utf8").trim() || undefined;
        } catch (err) {
            console.error(`Failed to read MCP_INSTRUCTIONS_FILE (${file}): ${(err as Error).message}`);
            process.exit(1);
        }
    }
    return extra ? `${base}\n\n${extra}` : base;
}

async function retry<T>(what: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= 30) throw err;
            console.warn(`${what} failed (${(err as Error).message}); retrying in 2s...`);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
}
