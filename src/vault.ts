/**
 * Vault access layer — wraps DirectFileManipulator from livesync-commonlib.
 */

import { DirectFileManipulator } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../lib/livesync-commonlib/src/API/DirectFileManipulator.ts";
import { createBinaryBlob, createTextBlob, isTextDocument, readContent } from "../lib/livesync-commonlib/src/common/utils.ts";
import type { FilePathWithPrefix } from "../lib/livesync-commonlib/src/common/types.ts";
import type { MetaEntry } from "../lib/livesync-commonlib/src/API/DirectFileManipulatorV2.ts";
import { isPathProbablyObfuscated, decrypt } from "octagonal-wheels/encryption/encryption";
import { clearHandlers } from "../lib/livesync-commonlib/src/replication/SyncParamsHandler.ts";
import { parseFrontmatterAndLinks } from "./parse.js";
import type { VaultBackend, NoteInfo, NoteListing, FileListener } from "./vault-backend.js";
import { deriveContent } from "./index-sync.js";
import { classifyIds, type IdFormat } from "./id-format.js";

export interface VaultConfig {
    couchdbUrl: string;
    couchdbUser: string;
    couchdbPassword: string;
    database: string;
    passphrase?: string;
    obfuscatePaths?: boolean;
}

export class Vault implements VaultBackend {
    private manipulator: DirectFileManipulator;
    private passphrase: string | undefined;
    private config: VaultConfig;

    constructor(config: VaultConfig) {
        this.config = config;
        this.passphrase = config.passphrase;
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(config, !!config.obfuscatePaths));
    }

    private static buildOptions(config: VaultConfig, obfuscatePaths: boolean): DirectFileManipulatorOptions {
        return {
            url: config.couchdbUrl,
            username: config.couchdbUser,
            password: config.couchdbPassword,
            database: config.database,
            passphrase: config.passphrase,
            obfuscatePassphrase: obfuscatePaths ? config.passphrase : undefined,
            useEden: false,
            enableCompression: false,
            handleFilenameCaseSensitive: false,
            doNotUseFixedRevisionForChunks: false,
        };
    }

    async init(): Promise<void> {
        await this.manipulator.ready.promise;
        await this.reconcileObfuscation();
    }

    /**
     * Detect whether the vault's document IDs are obfuscated and, if the
     * configured obfuscation setting doesn't match, correct it.
     * A mismatched setting can never work: path→id resolution misses every
     * existing note on read, and writes produce docs LiveSync clients ignore
     * (issues #4, #10). The database is the ground truth.
     */
    private async reconcileObfuscation(): Promise<void> {
        const configured = !!this.config.obfuscatePaths;
        const format = await this.detectIdFormat();
        if (format === "empty") return;
        if (format === "mixed") {
            console.warn(
                "Warning: vault contains both obfuscated and plaintext document IDs. " +
                `Keeping path obfuscation ${configured ? "on" : "off"}. ` +
                "This usually means \"Obfuscate properties\" was toggled without rebuilding the database — consider rebuilding it from LiveSync.",
            );
            return;
        }
        const actual = format === "obfuscated";
        if (actual === configured) return;
        if (actual && !this.passphrase) {
            throw new Error(
                "Vault uses obfuscated document IDs (LiveSync \"Obfuscate properties\"), which requires the E2E passphrase. " +
                "Register the vault in the admin UI with its E2E passphrase.",
            );
        }
        console.warn(
            actual
                ? "Warning: vault uses obfuscated document IDs; enabling path obfuscation automatically."
                : "Warning: vault uses plaintext document IDs although it has an E2E passphrase; disabling path obfuscation automatically.",
        );
        await this.manipulator.close();
        this.manipulator = new DirectFileManipulator(Vault.buildOptions(this.config, actual));
        await this.manipulator.ready.promise;
    }

    /** Sample file-entry docs from the changes feed and classify their IDs. */
    private async detectIdFormat(): Promise<IdFormat> {
        const SAMPLE_TARGET = 20;
        const BATCH_SIZE = 100;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        const ids: string[] = [];
        let since: string | number = 0;

        while (ids.length < SAMPLE_TARGET) {
            const result = await db.changes({
                since,
                limit: BATCH_SIZE,
                // Only real file entries — excludes chunks, versioninfo, milestones, sync params.
                selector: { type: { $in: ["plain", "newnote"] } },
                live: false,
            });
            for (const change of result.results) {
                if (ids.length >= SAMPLE_TARGET) break;
                ids.push(change.id);
            }
            if (result.results.length < BATCH_SIZE) break;
            since = result.last_seq;
        }
        return classifyIds(ids);
    }

    async close(): Promise<void> {
        this.manipulator.endWatch();
        await this.manipulator.close();
    }

    private static mdFilter(meta: any): boolean {
        return (meta.path ?? "").endsWith(".md");
    }

    /** Report an attachment from its metadata doc alone, so its chunks are never loaded. Skips LiveSync's internal docs. */
    private static reportFile(meta: any, path: string, onFile?: FileListener): void {
        if (!onFile || !path || /^(h|i|ix|ps):/.test(meta._id ?? "")) return;
        onFile(path, meta.deleted || meta._deleted ? null : { mtime: meta.mtime ?? 0, size: meta.size ?? 0 });
    }

    private static docToChange(doc: any, callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, seq?: string | number) {
        const path = doc.path ?? "";
        if (!path.endsWith(".md")) return;
        // null => deleted (remove); "" => existing empty note (index it, don't drop)
        const content = deriveContent(doc);
        callback(path, content, content === null ? undefined : doc.mtime, seq);
    }

    async catchUp(
        since: string,
        callback: (path: string, content: string | null, mtime?: number) => void,
        onBatch?: (since: string, processed: number) => Promise<void>,
        onFile?: FileListener,
    ): Promise<string> {
        // Paginate _changes in batches to limit memory usage.
        const BATCH_SIZE = 50;
        const db = this.manipulator.liveSyncLocalDB.localDatabase;
        let currentSince = since;
        let totalProcessed = 0;

        while (true) {
            const result = await db.changes({
                include_docs: true,
                since: currentSince,
                selector: { type: { $ne: "leaf" } },
                live: false,
                limit: BATCH_SIZE,
            });

            for (const change of result.results) {
                if (!change.doc) continue;
                const meta = change.doc as any;
                // Skip chunks and system docs
                if (meta.type === "leaf" || meta.type === "versioninfo") continue;
                if (meta._id?.startsWith("h:") || meta._id?.startsWith("_")) continue;
                // Decrypt path to check .md BEFORE fetching chunks (avoids loading large attachments)
                let path = meta.path ?? "";
                if (isPathProbablyObfuscated(path) && this.passphrase) {
                    try { path = await decrypt(path, this.passphrase, false); } catch { continue; }
                }
                if (!path.endsWith(".md")) {
                    Vault.reportFile(meta, path, onFile);
                    continue;
                }
                const doc = await this.manipulator.getByMeta(meta).catch(() => null);
                if (doc) Vault.docToChange(doc, callback);
            }

            totalProcessed += result.results.length;
            currentSince = String(result.last_seq);

            // Release chunk cache between batches to prevent memory growth
            this.manipulator.liveSyncLocalDB.clearCaches();

            // Save checkpoint after each batch so crashes don't restart from zero
            if (onBatch && result.results.length > 0) {
                await onBatch(currentSince, totalProcessed);
            }

            // No more changes
            if (result.results.length < BATCH_SIZE) break;
        }

        this.manipulator.since = currentSince;
        return currentSince;
    }

    watchChanges(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, onFile?: FileListener): void {
        // catchUp already set this.manipulator.since to the right point.
        // The filter sees the (decrypted) metadata doc before chunks load: attachments are recorded there and skipped.
        this.manipulator.beginWatch(
            (doc, seq) => Vault.docToChange(doc, callback, seq),
            (meta) => {
                if (Vault.mdFilter(meta)) return true;
                Vault.reportFile(meta, meta.path ?? "", onFile);
                return false;
            },
        );
    }

    private validatePath(path: string): void {
        if (!path || path.startsWith("/") || path.includes("\0") || path.includes("..") || path.length > 1000) {
            throw new Error("Invalid path");
        }
    }

    async readNote(path: string): Promise<string | null> {
        this.validatePath(path);
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        // Joining a binary file's chunks would hand back base64 noise (and a move would corrupt it).
        if (!isTextDocument(entry as any)) {
            throw new Error(`Not a text file: ${path}. Notes, text files and images (png, jpg, gif, webp) can be read.`);
        }
        if ("data" in entry && Array.isArray(entry.data)) {
            return entry.data.join("");
        }
        return null;
    }

    async readBinary(path: string, maxBytes: number): Promise<{ size: number; bytes?: Uint8Array } | null> {
        this.validatePath(path);
        // Check the size from metadata first so an oversized file's chunks are never loaded.
        const meta = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (!meta || (meta as any).deleted) return null;
        const size = (meta as any).size ?? 0;
        if (size > maxBytes) return { size };
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        const content = readContent(entry as any);
        return { size, bytes: typeof content === "string" ? new TextEncoder().encode(content) : new Uint8Array(content) };
    }

    async getMtime(path: string): Promise<number | null> {
        this.validatePath(path);
        const meta = await this.manipulator.get(path as FilePathWithPrefix, true);
        return meta && !(meta as any).deleted ? meta.mtime : null;
    }

    async findByName(name: string): Promise<string[]> {
        const wanted = name.toLowerCase();
        const hits: string[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const p = entry.path ?? "";
            if (p.slice(p.lastIndexOf("/") + 1).toLowerCase() === wanted) hits.push(p);
        }
        return hits.sort((a, b) => a.length - b.length || a.localeCompare(b));
    }

    async writeNote(path: string, content: string): Promise<boolean> {
        this.validatePath(path);
        // Clear cached PBKDF2 salt so we re-fetch from CouchDB before encrypting.
        // Prevents stale salt after Obsidian "Overwrite remote" rebuilds (issue #686).
        clearHandlers();

        // Preserve ctime if note already exists
        let ctime = Date.now();
        const existing = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (existing && "ctime" in existing) {
            ctime = existing.ctime;
        }

        const blob = createTextBlob(content);
        return await this.manipulator.put(path, blob, {
            ctime,
            mtime: Date.now(),
            size: new TextEncoder().encode(content).byteLength,
        });
    }

    async deleteNote(path: string): Promise<boolean> {
        this.validatePath(path);
        clearHandlers();
        return await this.manipulator.delete(path);
    }

    async moveNote(from: string, to: string): Promise<boolean> {
        this.validatePath(from);
        this.validatePath(to);
        const meta = await this.manipulator.get(from as FilePathWithPrefix, true);
        if (!meta) return false;
        if (!isTextDocument(meta as any)) {
            const file = await this.readBinary(from, Infinity);
            if (!file?.bytes) return false;
            clearHandlers();
            const wrote = await this.manipulator.put(to, createBinaryBlob(new Uint8Array(file.bytes)), { ctime: meta.ctime, mtime: Date.now(), size: file.size }, "newnote");
            return wrote ? await this.deleteNote(from) : false;
        }
        const content = await this.readNote(from);
        if (content === null) return false;
        const wrote = await this.writeNote(to, content);
        if (!wrote) return false;
        return await this.deleteNote(from);
    }

    async getMetadata(path: string): Promise<NoteInfo | null> {
        this.validatePath(path);
        // Attachments: answer from metadata alone, without loading (possibly large) chunks.
        const meta = await this.manipulator.get(path as FilePathWithPrefix, true);
        if (meta && !isTextDocument(meta as any)) {
            return { path, size: meta.size, ctime: meta.ctime, mtime: meta.mtime, frontmatter: {}, tags: [], links: [] };
        }
        const entry = await this.manipulator.get(path as FilePathWithPrefix);
        if (!entry) return null;
        const content = "data" in entry && Array.isArray(entry.data) ? entry.data.join("") : "";
        return {
            path,
            size: entry.size,
            ctime: entry.ctime,
            mtime: entry.mtime,
            ...parseFrontmatterAndLinks(content),
        };
    }

    async listNotes(folder?: string): Promise<string[]> {
        const notes = await this.listNotesWithMtime(folder);
        return notes.map((n) => n.path);
    }

    async listNotesWithMtime(folder?: string): Promise<NoteListing[]> {
        if (folder && !folder.endsWith("/")) folder += "/";
        const results: NoteListing[] = [];
        for await (const doc of this.manipulator.enumerateAllNormalDocs({ metaOnly: true })) {
            const entry = doc as MetaEntry;
            if (entry.deleted) continue;
            const notePath = entry.path ?? "";
            if (!notePath.endsWith(".md")) continue;
            if (folder && !notePath.startsWith(folder)) continue;
            results.push({ path: notePath, mtime: entry.mtime ?? 0 });
        }
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

}
