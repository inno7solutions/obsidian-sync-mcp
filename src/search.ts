/**
 * Index for vault notes.
 *
 * Tracks paths, mtimes, tags, links, backlinks, and note text for full-text search.
 * Persists to disk (encrypted if passphrase is set).
 */

import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { dirname } from "path";
import { parseFrontmatterAndLinks } from "./parse.js";
import { seal as encrypt, open as decrypt } from "./secret-box.js";

/** Bump when the persisted shape changes; an older file is ignored and the index rebuilds from CouchDB. */
const FORMAT_VERSION = 2;

export interface SearchHit {
    path: string;
    mtime: number;
    matches: number;
    snippet: string;
}

export class SearchIndex {
    private contents = new Map<string, string>();
    private mtimes = new Map<string, number>();
    private tags = new Map<string, string[]>();
    private links = new Map<string, string[]>();
    private backlinks = new Map<string, Set<string>>();
    private knownPaths = new Set<string>();
    private saving = false;
    private _since: string = "";
    private persistPath: string | null;
    private passphrase: string | null;

    constructor(persistPath?: string, passphrase?: string) {
        this.persistPath = persistPath ?? null;
        this.passphrase = passphrase ?? null;
    }

    /** Load metadata from disk. */
    async loadFromDisk(): Promise<boolean> {
        if (!this.persistPath) return false;
        try {
            let raw = await readFile(this.persistPath, "utf-8");
            if (this.passphrase) {
                raw = decrypt(raw, this.passphrase);
            }
            const data = JSON.parse(raw);
            if (data.version !== FORMAT_VERSION) return false;
            for (const [path, c] of Object.entries(data.contents ?? {})) {
                this.contents.set(path, c as string);
            }
            for (const [path, mtime] of Object.entries(data.mtimes ?? {})) {
                this.mtimes.set(path, mtime as number);
                this.knownPaths.add(path);
            }
            for (const [path, t] of Object.entries(data.tags ?? {})) {
                this.tags.set(path, t as string[]);
            }
            for (const [path, l] of Object.entries(data.links ?? {})) {
                const targets = l as string[];
                this.links.set(path, targets);
                for (const target of targets) {
                    const key = target.toLowerCase();
                    if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                    this.backlinks.get(key)!.add(path);
                }
            }
            if (data.since) this._since = data.since;
            console.log(`Search metadata loaded from disk (${this.knownPaths.size} notes, since: ${this._since ? "yes" : "none"}).`);
            return this.knownPaths.size > 0;
        } catch {
            return false;
        }
    }

    /** Save metadata to disk. Encrypted if passphrase is set. */
    async saveToDisk(): Promise<void> {
        if (!this.persistPath || this.saving) return;
        this.saving = true;
        try {
            await mkdir(dirname(this.persistPath), { recursive: true });
            let data = JSON.stringify({
                version: FORMAT_VERSION,
                contents: Object.fromEntries(this.contents),
                mtimes: Object.fromEntries(this.mtimes),
                tags: Object.fromEntries(this.tags),
                links: Object.fromEntries(this.links),
                since: this._since,
            });
            if (this.passphrase) {
                data = encrypt(data, this.passphrase);
            }
            await writeFile(this.persistPath, data, { encoding: "utf-8", mode: 0o600 });
            await chmod(this.persistPath, 0o600);
            console.log(`Search index saved to disk (${this.knownPaths.size} notes${this.passphrase ? ", encrypted" : ""}).`);
        } catch (err) {
            console.error("Failed to save search index:", err);
        } finally {
            this.saving = false;
        }
    }

    /** Add or update a note in the index. */
    update(path: string, content: string, mtime?: number): void {
        if (this.knownPaths.has(path)) {
            this.clearBacklinks(path);
        }
        this.knownPaths.add(path);
        this.contents.set(path, content);
        if (mtime !== undefined) this.mtimes.set(path, mtime);
        const parsed = parseFrontmatterAndLinks(content);
        if (parsed.tags.length > 0) {
            this.tags.set(path, parsed.tags);
        } else {
            this.tags.delete(path);
        }
        if (parsed.links.length > 0) {
            this.links.set(path, parsed.links);
            for (const target of parsed.links) {
                const key = target.toLowerCase();
                if (!this.backlinks.has(key)) this.backlinks.set(key, new Set());
                this.backlinks.get(key)!.add(path);
            }
        } else {
            this.links.delete(path);
        }
    }

    /** Remove a note from the index. */
    remove(path: string): void {
        if (this.knownPaths.has(path)) {
            this.knownPaths.delete(path);
            this.contents.delete(path);
            this.mtimes.delete(path);
            this.tags.delete(path);
            this.clearBacklinks(path);
        }
    }

    /** Remove all backlink entries where path is the source. */
    private clearBacklinks(path: string): void {
        const oldLinks = this.links.get(path);
        if (oldLinks) {
            for (const target of oldLinks) {
                const key = target.toLowerCase();
                this.backlinks.get(key)?.delete(path);
                if (this.backlinks.get(key)?.size === 0) this.backlinks.delete(key);
            }
        }
        this.links.delete(path);
    }

    /** List all indexed paths, optionally filtered by folder prefix. */
    listPaths(folder?: string): string[] {
        return this.listWithMtime(folder).map((n) => n.path);
    }

    /** List all indexed paths with mtimes, optionally filtered by folder prefix. */
    listWithMtime(folder?: string): Array<{ path: string; mtime: number }> {
        const prefix = folder && !folder.endsWith("/") ? folder + "/" : folder;
        const entries = [...this.knownPaths]
            .filter((p) => p.endsWith(".md"))
            .filter((p) => !prefix || p.startsWith(prefix))
            .map((p) => ({ path: p, mtime: this.mtimes.get(p) ?? 0 }));
        return entries.sort((a, b) => a.path.localeCompare(b.path));
    }

    /**
     * Case-insensitive full-text search over note paths and bodies. Every
     * whitespace-separated term must appear. Ranked by body matches (a path hit
     * counts extra), then most recently modified.
     * ponytail: linear scan over all notes per query; fine for team vaults, add an inverted index if searches get slow.
     */
    search(query: string, folder?: string, limit = 20): { hits: SearchHit[]; total: number } {
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        if (terms.length === 0) return { hits: [], total: 0 };
        const hits: SearchHit[] = [];
        for (const { path, mtime } of this.listWithMtime(folder)) {
            const body = this.contents.get(path) ?? "";
            const lowerBody = body.toLowerCase();
            const lowerPath = path.toLowerCase();
            let matches = 0;
            let first = -1;
            let allFound = true;
            for (const term of terms) {
                const inPath = lowerPath.includes(term);
                let n = 0;
                for (let i = lowerBody.indexOf(term); i !== -1; i = lowerBody.indexOf(term, i + term.length)) {
                    if (first === -1 || i < first) first = i;
                    n++;
                }
                if (!inPath && n === 0) {
                    allFound = false;
                    break;
                }
                matches += n + (inPath ? 5 : 0);
            }
            if (!allFound) continue;
            hits.push({ path, mtime, matches, snippet: first === -1 ? "" : snippetAt(body, first) });
        }
        hits.sort((a, b) => b.matches - a.matches || b.mtime - a.mtime);
        return { hits: hits.slice(0, limit), total: hits.length };
    }

    /** Get mtime for a path. */
    getMtime(path: string): number {
        return this.mtimes.get(path) ?? 0;
    }

    /** Get tags for a path. */
    getTags(path: string): string[] {
        return this.tags.get(path) ?? [];
    }

    /** Get outgoing links for a path. */
    getLinks(path: string): string[] {
        return this.links.get(path) ?? [];
    }

    /** Get backlinks for a path (notes that link to it). Case-insensitive, matches by full path or filename. */
    getBacklinks(path: string): string[] {
        const results = new Set<string>();
        const withMd = (path.endsWith(".md") ? path : path + ".md").toLowerCase();
        const withoutMd = (path.endsWith(".md") ? path.slice(0, -3) : path).toLowerCase();
        const nameOnly = withoutMd.includes("/") ? withoutMd.slice(withoutMd.lastIndexOf("/") + 1) : withoutMd;

        for (const target of [withMd, withoutMd, nameOnly]) {
            const sources = this.backlinks.get(target);
            if (sources) {
                for (const s of sources) results.add(s);
            }
        }
        return [...results].sort();
    }

    /** List all tags across the vault with counts. */
    listAllTags(): Array<{ tag: string; count: number }> {
        const counts = new Map<string, number>();
        for (const tags of this.tags.values()) {
            for (const t of tags) {
                counts.set(t, (counts.get(t) ?? 0) + 1);
            }
        }
        return [...counts.entries()]
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count);
    }

    /** Clear all index data (for full rebuild after DB nuke). */
    clear(): void {
        const paths = Array.from(this.knownPaths);
        for (const p of paths) this.remove(p);
        this._since = "";
    }

    get since(): string {
        return this._since;
    }

    set since(value: string) {
        this._since = value;
    }

    get size(): number {
        return this.knownPaths.size;
    }
}

/** ~160 chars of context around `at`, on one line. */
function snippetAt(body: string, at: number): string {
    const start = Math.max(0, at - 60);
    const end = Math.min(body.length, at + 100);
    return (start > 0 ? "…" : "") + body.slice(start, end).replace(/\s+/g, " ").trim() + (end < body.length ? "…" : "");
}
