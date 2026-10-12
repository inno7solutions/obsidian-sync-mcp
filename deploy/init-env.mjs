#!/usr/bin/env node
/**
 * Create a deployment's .env from its .env.example: every `<placeholder>` value
 * becomes a fresh random secret, `KEY=value` arguments override any entry, and
 * comments and order are kept. Secrets are never printed.
 *
 *   node deploy/init-env.mjs local-test
 *   node deploy/init-env.mjs team PUBLIC_COUCHDB_URL=https://couch.acme.com PUBLIC_MCP_URL=https://vault.acme.com/mcp
 *
 * An existing .env is never overwritten without --force: new keys would lock you
 * out of the data already in that stack (CouchDB admin password, registry keys).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLACEHOLDER = /^<.*>$/;

/** Fill an .env.example text. Returns the .env text and which keys were generated or overridden. */
export function fillEnv(example, overrides = {}, secret = () => randomBytes(32).toString("hex")) {
    const unknown = new Set(Object.keys(overrides));
    const generated = [];
    const lines = example.split(/\r?\n/).map((line) => {
        const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
        if (!m) return line;
        const [, key, value] = m;
        unknown.delete(key);
        if (key in overrides) return `${key}=${overrides[key]}`;
        if (PLACEHOLDER.test(value.trim())) {
            generated.push(key);
            return `${key}=${secret()}`;
        }
        return line;
    });
    if (unknown.size > 0) throw new Error(`Unknown key(s) not in .env.example: ${[...unknown].join(", ")}`);
    return { text: lines.join("\n"), generated };
}

function main(argv) {
    const args = argv.filter((a) => a !== "--force");
    const force = args.length !== argv.length;
    const target = args.shift();
    if (!target) {
        console.error("Usage: node deploy/init-env.mjs <local-test|team|path/to/dir> [KEY=value ...] [--force]");
        process.exit(1);
    }
    const here = dirname(fileURLToPath(import.meta.url));
    const dir = existsSync(join(here, target)) ? join(here, target) : resolve(target);
    const examplePath = join(dir, ".env.example");
    const envPath = join(dir, ".env");
    if (!existsSync(examplePath)) {
        console.error(`No .env.example in ${dir}.`);
        process.exit(1);
    }
    if (existsSync(envPath) && !force) {
        console.error(`${envPath} already exists. --force replaces it, but new secrets lock you out of data already in that stack (reset it with \`docker compose ... down -v\`).`);
        process.exit(1);
    }
    const overrides = {};
    for (const a of args) {
        const i = a.indexOf("=");
        if (i < 1) {
            console.error(`Expected KEY=value, got '${a}'.`);
            process.exit(1);
        }
        overrides[a.slice(0, i)] = a.slice(i + 1);
    }
    let result;
    try {
        result = fillEnv(readFileSync(examplePath, "utf8"), overrides);
    } catch (err) {
        console.error(err.message);
        process.exit(1);
    }
    writeFileSync(envPath, result.text, { mode: 0o600 });
    try {
        chmodSync(envPath, 0o600);
    } catch {
        // Best effort: Windows ignores POSIX modes.
    }
    console.log(`Wrote ${envPath}`);
    console.log(`Generated: ${result.generated.join(", ") || "nothing"}`);
    if (Object.keys(overrides).length) console.log(`Set from arguments: ${Object.keys(overrides).join(", ")}`);
    const leftover = result.text.split("\n").filter((l) => /^[A-Z0-9_]+=.*example\.com/.test(l));
    if (leftover.length) console.warn(`Still example values, edit before deploying: ${leftover.map((l) => l.split("=")[0]).join(", ")}`);
    console.log("ADMIN_TOKEN (admin UI login) is in the file; keep the file private and back it up.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
