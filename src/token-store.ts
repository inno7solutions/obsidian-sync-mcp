/**
 * File-backed OAuth token storage for IdP auth mode.
 *
 * fastmcp's OAuthProxy defaults to an in-memory store, which logs the whole
 * team out on every restart or deploy. This implements the same TokenStorage
 * contract (get/save/delete/cleanup, TTL in seconds) against a JSON file, so
 * sessions survive restarts the way password mode's token file already does.
 *
 * The proxy wraps whatever storage it is given in its own AES-256-GCM layer
 * unless encryptionKey is false, so values written here are normally already
 * ciphertext. The file is still written 0600 and its contents are never logged.
 *
 * Semantics mirror fastmcp's MemoryTokenStorage exactly: a missing ttl means
 * "never expires", and reads lazily drop expired entries.
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";

interface Entry {
    expiresAt: number;
    value: unknown;
}

export class FileTokenStorage {
    private readonly path: string;
    private store = new Map<string, Entry>();
    private saving = false;
    private resave = false;

    constructor(path: string) {
        this.path = path;
    }

    /** Load persisted entries, dropping any that already expired. Returns false if there was nothing usable to load. */
    async load(): Promise<boolean> {
        try {
            const raw = await readFile(this.path, "utf-8");
            const parsed = JSON.parse(raw) as Record<string, Entry>;
            const now = Date.now();
            let loaded = 0;
            for (const [key, entry] of Object.entries(parsed)) {
                if (typeof entry?.expiresAt !== "number") continue;
                if (entry.expiresAt < now) continue;
                this.store.set(key, entry);
                loaded++;
            }
            return loaded > 0;
        } catch {
            // Missing or corrupt file: start empty. Users re-authenticate, nothing worse.
            return false;
        }
    }

    async get(key: string): Promise<null | unknown> {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (entry.expiresAt < Date.now()) {
            this.store.delete(key);
            void this.persist();
            return null;
        }
        return entry.value;
    }

    async save(key: string, value: unknown, ttl?: number): Promise<void> {
        const expiresAt = ttl ? Date.now() + ttl * 1000 : Number.MAX_SAFE_INTEGER;
        this.store.set(key, { expiresAt, value });
        await this.persist();
    }

    async delete(key: string): Promise<void> {
        if (this.store.delete(key)) await this.persist();
    }

    async cleanup(): Promise<void> {
        const now = Date.now();
        let removed = 0;
        for (const [key, entry] of this.store) {
            if (entry.expiresAt < now) {
                this.store.delete(key);
                removed++;
            }
        }
        if (removed > 0) await this.persist();
    }

    /** Write pending state to disk. Call on shutdown. */
    async flush(): Promise<void> {
        await this.persist();
    }

    get size(): number {
        return this.store.size;
    }

    /**
     * Write the whole map to disk. Concurrent calls coalesce: a save that
     * arrives mid-write sets a flag and is picked up by one follow-up write,
     * so we never interleave two writers on the same file.
     */
    private async persist(): Promise<void> {
        if (this.saving) {
            this.resave = true;
            return;
        }
        this.saving = true;
        try {
            do {
                this.resave = false;
                const data = JSON.stringify(Object.fromEntries(this.store));
                await mkdir(dirname(this.path), { recursive: true });
                await writeFile(this.path, data, { encoding: "utf-8", mode: 0o600 });
                await chmod(this.path, 0o600);
            } while (this.resave);
        } catch (err) {
            console.error("Failed to persist OAuth token store:", (err as Error).message);
        } finally {
            this.saving = false;
        }
    }
}
