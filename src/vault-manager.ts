/**
 * Keeps one open Vault + SearchIndex per active registry vault. Vaults open in
 * the background when they appear in the registry and close when archived or
 * removed; a tool call awaits the open promise, so the first call to a fresh
 * vault waits for init but never for the index catch-up.
 */

import { join } from "path";
import { Vault } from "./vault.js";
import { SearchIndex } from "./search.js";
import { applyIndexChange } from "./index-sync.js";
import { open } from "./secret-box.js";
import type { Snapshot, VaultRecord } from "./registry/model.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

export interface OpenVault {
    vault: Vault;
    index: SearchIndex;
}

interface Entry {
    /** Changes when anything that needs a reopen changes. */
    key: string;
    ready: Promise<OpenVault>;
}

export interface VaultManagerConfig {
    couchdbUrl: string;
    user: string;
    password: string;
    registryKey: string;
    dataDir: string;
}

export class VaultManager {
    private entries = new Map<string, Entry>();

    constructor(private readonly cfg: VaultManagerConfig) {}

    /** Reconcile open vaults with the registry. Safe to call on every registry change. */
    sync(s: Snapshot): void {
        const wanted = new Map<string, VaultRecord>();
        for (const v of s.vaults.values()) if (!v.archived) wanted.set(v.slug, v);
        for (const [slug, entry] of this.entries) {
            const v = wanted.get(slug);
            if (!v || keyOf(v) !== entry.key) this.close(slug);
        }
        for (const [slug, v] of wanted) {
            if (this.entries.has(slug)) continue;
            const ready = this.open(v);
            // Keep a failed open from crashing the process; the next tool call reports it.
            ready.catch((err) => console.error(`Vault '${slug}' failed to open: ${(err as Error).message}`));
            this.entries.set(slug, { key: keyOf(v), ready });
        }
    }

    get(slug: string): Promise<OpenVault> {
        const entry = this.entries.get(slug);
        if (!entry) return Promise.reject(new Error(`Vault '${slug}' is not open.`));
        return entry.ready;
    }

    private close(slug: string): Promise<void> {
        const entry = this.entries.get(slug);
        this.entries.delete(slug);
        return Promise.resolve(entry?.ready)
            .then(async (opened) => {
                if (!opened) return;
                const { vault, index } = opened;
                await index.saveToDisk();
                await vault.close();
                console.log(`Vault '${slug}' closed.`);
            })
            .catch(() => {});
    }

    private async open(v: VaultRecord): Promise<OpenVault> {
        const passphrase = v.passphraseEnc ? open(v.passphraseEnc, this.cfg.registryKey) : undefined;
        const vault = new Vault({
            couchdbUrl: this.cfg.couchdbUrl,
            couchdbUser: this.cfg.user,
            couchdbPassword: this.cfg.password,
            database: v.db,
            passphrase,
            obfuscatePaths: !!passphrase,
        });
        await vault.init();
        const index = new SearchIndex(join(this.cfg.dataDir, v.slug, "search-index.json"), passphrase);
        await index.loadFromDisk();
        catchUpIndex(v.slug, vault, index).catch((err) => console.error(`Index rebuild for '${v.slug}' failed:`, err));
        vault.watchChanges((path, content, mtime, seq) => {
            if (debugLogging) console.log(`[debug] ${v.slug}: ${content === null ? "delete" : "change"} ${path}`);
            // content === "" is an empty-but-present note: index it, don't drop it.
            applyIndexChange(index, path, content, mtime);
            if (seq) index.since = String(seq);
        });
        console.log(`Vault '${v.slug}' ready (db ${v.db}${passphrase ? ", E2EE" : ""}).`);
        return { vault, index };
    }

    async saveAll(): Promise<void> {
        for (const entry of this.entries.values()) {
            await entry.ready.then(({ index }) => index.saveToDisk()).catch(() => {});
        }
    }

    async closeAll(): Promise<void> {
        await Promise.all([...this.entries.keys()].map((slug) => this.close(slug)));
    }
}

function keyOf(v: VaultRecord): string {
    return `${v.db}|${v.passphraseEnc ?? ""}`;
}

/** Bring the index up to date from the persisted `since`, falling back to a full rebuild. */
async function catchUpIndex(slug: string, vault: Vault, index: SearchIndex): Promise<void> {
    const start = performance.now();
    let changes = 0;
    const onChange = (path: string, content: string | null, mtime?: number) => {
        changes++;
        applyIndexChange(index, path, content, mtime);
    };
    const onBatch = async (batchSince: string, processed: number) => {
        index.since = batchSince;
        await index.saveToDisk();
        if (debugLogging) console.log(`[debug] ${slug}: checkpoint ${processed} changes, ${index.size} notes.`);
    };
    try {
        index.since = await vault.catchUp(index.since || "0", onChange, onBatch);
    } catch (err) {
        console.warn(`${slug}: catch-up failed (${err}), rebuilding index from scratch...`);
        index.clear();
        changes = 0;
        index.since = await vault.catchUp("0", onChange, onBatch);
    }
    console.log(`${slug}: search index ${changes > 0 ? `synced ${changes} changes in ${((performance.now() - start) / 1000).toFixed(1)}s` : "up to date"} (${index.size} notes).`);
    await index.saveToDisk();
}
