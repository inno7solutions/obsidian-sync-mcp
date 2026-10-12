import { imageContent, UserError, type FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import { isHidden, TRASH, type SearchIndex } from "./search.js";
import { type Access, isWritable, describeAccess } from "./policy.js";
import type { AuditLogger } from "./audit.js";
import { rewriteLinks } from "./link-rewrite.js";
import { closestPaths } from "./suggest.js";
import { setProperties } from "./frontmatter.js";

const debugLogging = process.env.LOG_LEVEL === "debug";

/** Which vault a call targets and what the caller may do there. */
export interface PickedVault {
    slug: string;
    displayName: string;
    obsidianName: string;
    access: Access;
}

/**
 * Bridge from a session to vaults, so tools stay independent of the registry.
 * `pick` is synchronous (pure lookup) so the audit wrapper can name the vault
 * even for calls that fail before the vault opens.
 */
export interface VaultResolver {
    list(session: unknown): PickedVault[];
    pick(session: unknown, requested?: string): PickedVault | { error: string };
    open(slug: string): Promise<{ vault: VaultBackend; index: SearchIndex }>;
}

type Target = PickedVault & { vault: VaultBackend; index: SearchIndex };

/** Image types Claude and most MCP clients accept as image content. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
/** Base64 adds a third, so this keeps a returned image under the common 5 MB limit. */
const MAX_IMAGE_BYTES = 3_750_000;

const kb = (bytes: number) => (bytes < 1e3 ? `${bytes} B` : bytes < 1e6 ? `${Math.round(bytes / 1e3)} KB` : `${(bytes / 1e6).toFixed(1)} MB`);
const iso = (ms: number) => new Date(ms).toISOString();
const hasExt = (p: string) => /\.[A-Za-z0-9]{1,8}$/.test(p);
/** A note path as Obsidian stores it: no leading slash, `.md` added when there is no extension. */
const notePath = (p: string) => {
    const clean = p.trim().replace(/^\/+/, "");
    return hasExt(clean) ? clean : `${clean}.md`;
};
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();

/** Errors reach the client as `isError` results (FastMCP turns a UserError into one). */
const fail = (message: string): never => {
    throw new UserError(message);
};

const vaultParam = z
    .string()
    .optional()
    .describe("Vault id from list_vaults. Required when you have access to more than one vault.");
const expectedModifiedParam = z
    .union([z.string(), z.number()])
    .optional()
    .describe("Optional safety check: the 'modified' time you got from read_note. The write fails if the note changed since, instead of overwriting someone else's edit.");

export function registerTools(server: FastMCP, resolver: VaultResolver, audit?: AuditLogger) {
    const target = async (args: { vault?: string }, ctx: { session?: unknown }): Promise<Target> => {
        const picked = resolver.pick(ctx.session, args.vault);
        if ("error" in picked) return fail(picked.error);
        return { ...picked, ...(await resolver.open(picked.slug)) };
    };
    const writable = (t: Target, path: string) => isWritable(t.access, path);
    const requireWritable = (t: Target, path: string) => {
        if (!writable(t, path)) fail(`Write access denied: '${path}' is outside your writable scope in vault '${t.slug}' (${describeAccess(t.access)}).`);
    };
    const link = (t: Target, path: string) => makeDeepLink(t.obsidianName, path);
    const notFound = (t: Target, path: string): never => {
        const near = closestPaths(path, t.index.allPaths());
        return fail(`Note not found: ${path}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`);
    };
    const indexNote = (t: Target) => (t.index.building ? `\n(Search index still building: ${t.index.size} notes so far, so results may be incomplete.)` : "");
    /** Obsidian links and embeds often name only the file (`![[diagram.png]]`, `[[Note]]`); resolve it the way Obsidian does. */
    const resolveName = async (t: Target, path: string): Promise<string | undefined> => {
        if (path.includes("/")) return undefined;
        return (await t.vault.findByName(path))[0];
    };
    /** Fails when `expected` is given and the note was modified since (or deleted). */
    const checkUnchanged = async (t: Target, path: string, expected: string | number | undefined) => {
        if (expected === undefined) return;
        const want = typeof expected === "number" || /^\d+$/.test(expected) ? Number(expected) : Date.parse(expected);
        if (isNaN(want)) fail(`expected_modified is not a valid time: ${expected}.`);
        const now = await t.vault.getMtime(path);
        if (now === null) fail(`'${path}' no longer exists.`);
        if (now !== want) fail(`'${path}' changed since you read it (now modified ${iso(now!)}). Read it again, then retry.`);
    };
    const modified = async (t: Target, path: string) => {
        const m = await t.vault.getMtime(path);
        return m ? ` (modified ${iso(m)})` : "";
    };

    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const picked = resolver.pick(ctx?.session, args?.vault);
            const vault = "error" in picked ? (args?.vault ?? "") : picked.slug;
            const record = (outcome: "ok" | "denied" | "error", error?: string) =>
                audit?.record({ vault, tool: tool.name, args, session: ctx?.session, outcome, ms: performance.now() - start, error, sessionId: ctx?.sessionId, requestId: ctx?.requestId });
            try {
                const result = await original(args, ctx);
                record("ok");
                if (debugLogging) console.log(`[tool] ${tool.name} → ${(performance.now() - start).toFixed(0)}ms`);
                return result;
            } catch (err) {
                const message = (err as Error)?.message;
                // Access denials have messages we own: a write outside scope, or a vault the caller can't reach.
                const denied = err instanceof UserError && ("error" in picked || message.startsWith("Write access denied:"));
                record(denied ? "denied" : "error", message);
                throw err;
            }
        };
        return _addTool(tool);
    };

    server.addTool({
        name: "list_vaults",
        description: "List the Obsidian vaults you have access to, with your access level in each. Pass a vault id as the 'vault' argument of the other tools.",
        parameters: z.object({}),
        execute: async (_args, ctx) => {
            const vaults = resolver.list(ctx.session);
            if (vaults.length === 0) return "You have no vault access. Ask an administrator for a grant.";
            return vaults.map((v) => `- ${v.slug} — ${v.displayName} (${describeAccess(v.access) === "the whole vault" ? "read/write" : describeAccess(v.access)})`).join("\n");
        },
    });

    server.addTool({
        name: "read_note",
        description:
            "Read a note, text file or image (png, jpg, gif, webp) from an Obsidian vault. Returns the content — the image itself for images — a deep link, and the note's 'modified' time (pass it as expected_modified when writing to avoid overwriting newer edits). '.md' is optional, and a bare name like 'diagram.png' or 'Meeting' is resolved the way Obsidian resolves links.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            let path = args.path.trim().replace(/^\/+/, "");
            if (IMAGE_EXT.test(path)) {
                let file = await t.vault.readBinary(path, MAX_IMAGE_BYTES);
                const resolved = file ? undefined : await resolveName(t, path);
                if (resolved) file = await t.vault.readBinary((path = resolved), MAX_IMAGE_BYTES);
                if (!file) return notFound(t, args.path);
                if (!file.bytes) {
                    return fail(`Image too large to return: ${path} is ${(file.size / 1e6).toFixed(1)} MB (limit ${MAX_IMAGE_BYTES / 1e6} MB). Open it in Obsidian: ${link(t, path)}`);
                }
                return { content: [{ type: "text" as const, text: `${path}\n[Open in Obsidian](${link(t, path)})` }, await imageContent({ buffer: Buffer.from(file.bytes) })] };
            }
            path = notePath(path);
            let content = await t.vault.readNote(path);
            const resolved = content === null ? await resolveName(t, path) : undefined;
            if (resolved) content = await t.vault.readNote((path = resolved));
            if (content === null) return notFound(t, args.path);
            const note = path === notePath(args.path) ? "" : `Resolved '${args.path}' to '${path}'.\n`;
            return `${note}[Open in Obsidian](${link(t, path)})${await modified(t, path)}\n\n---\n\n${content}`;
        },
    });

    server.addTool({
        name: "read_notes",
        description: "Read several notes in one call (up to 20). Missing notes are reported inline; the rest are still returned.",
        parameters: z.object({
            vault: vaultParam,
            paths: z.array(z.string()).min(1).max(20).describe("Vault-relative note paths"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            // Images stay out of batches so one call can't flood the client's context.
            const read = async (path: string): Promise<string> => {
                if (IMAGE_EXT.test(path)) return "Image: use read_note to view it.";
                try {
                    const content = await t.vault.readNote(path);
                    if (content === null) {
                        const near = closestPaths(path, t.index.allPaths());
                        return `Note not found.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""}`;
                    }
                    return `[Open in Obsidian](${link(t, path)})\n\n${content}`;
                } catch (err) {
                    return (err as Error).message;
                }
            };
            const notes = await Promise.all(
                args.paths.map(async (raw) => {
                    const path = IMAGE_EXT.test(raw) ? raw : notePath(raw);
                    const body = await read(path);
                    return `## ${path}\n${body.startsWith("[") ? "" : "\n"}${body}`;
                }),
            );
            return notes.join("\n\n---\n\n");
        },
    });

    server.addTool({
        name: "search_notes",
        description:
            "Full-text search across note paths and contents (case-insensitive; every word must appear). Attachments match by file name. Returns the best matches with a snippet and a deep link. Use read_note or read_notes to see whole notes.",
        parameters: z.object({
            vault: vaultParam,
            query: z.string().min(1).describe("Words to find, e.g. 'budget review'"),
            folder: z.string().optional().describe("Only search inside this folder, e.g. 'projects'."),
            limit: z.coerce.number().int().min(1).max(100).optional().describe("Max results. Default 20."),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const { hits, total } = t.index.search(args.query, args.folder, args.limit ?? 20);
            if (total === 0) return `No notes match: ${args.query}${indexNote(t)}`;
            const lines = hits.map(
                (h) => `- [${h.path}](${link(t, h.path)})${h.size !== undefined ? ` (attachment, ${kb(h.size)})` : ""}${h.snippet ? `\n  > ${h.snippet}` : ""}`,
            );
            if (total > hits.length) lines.push(`\n... and ${total - hits.length} more. Add words, a folder or a higher limit to narrow results.`);
            return lines.join("\n") + indexNote(t);
        },
    });

    server.addTool({
        name: "write_note",
        description:
            "Write or update a note in an Obsidian vault. Creates the note if it doesn't exist ('.md' is added when the path has no extension). Replaces the entire content if it does — read first if you need to preserve existing content, or use create_only. Write access is per vault; a denied write says what you may write.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
            create_only: z.boolean().optional().describe("Fail instead of overwriting when the note already exists. Default false."),
            expected_modified: expectedModifiedParam,
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const path = notePath(args.path);
            requireWritable(t, path);
            if (args.create_only && (await t.vault.getMtime(path)) !== null) fail(`Note already exists: ${path}. Read it and use edit_note, or pick another name.`);
            await checkUnchanged(t, path, args.expected_modified);
            if (!(await t.vault.writeNote(path, args.content))) fail(`Failed to write note: ${path}`);
            t.index.update(path, args.content, Date.now());
            return `Note saved: ${path}${await modified(t, path)}\n[Open in Obsidian](${link(t, path)})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in a vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes per page; use offset for the next page. Hidden folders (_trash, dot folders) appear only when asked for by name.",
        parameters: z.object({
            vault: vaultParam,
            folder: z
                .string()
                .optional()
                .describe("Folder to filter by, e.g. 'daily' or 'projects'. Omit for all notes."),
            name: z
                .string()
                .optional()
                .describe("Filter by name (case-insensitive substring match on path), e.g. 'meeting' or 'project-x'."),
            tag: z
                .string()
                .optional()
                .describe("Filter by tag, e.g. 'project' or 'daily'. Use list_tags to discover available tags."),
            sort_by: z
                .enum(["name", "modified"])
                .optional()
                .describe("Sort order: 'name' (default) or 'modified' (most recent first)."),
            modified_after: z
                .string()
                .optional()
                .describe("Only include notes modified after this ISO date, e.g. '2026-03-25' or '2026-03-25T10:00'."),
            limit: z.coerce
                .number()
                .optional()
                .describe("Max number of notes to return. Default 100."),
            offset: z.coerce.number().int().min(0).optional().describe("Skip this many results, for paging. Default 0."),
            include_attachments: z
                .boolean()
                .optional()
                .describe("Also list attachments (images, PDFs, …) with their size. Default false. Tag filters never match attachments."),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const { folder, name, tag, sort_by, modified_after, limit, offset, include_attachments } = args;
            // Use search index (works with encrypted vaults), fall back to vault
            let notes: Array<{ path: string; mtime: number; size?: number }> = t.index.listWithMtime(folder);
            if (notes.length === 0) {
                const showHidden = !!folder && isHidden(folder);
                notes = (await t.vault.listNotesWithMtime(folder)).filter((n) => showHidden || !isHidden(n.path));
            }
            if (include_attachments) {
                notes = [...notes, ...t.index.listFiles(folder)].sort((a, b) => a.path.localeCompare(b.path));
            }
            if (notes.length === 0) {
                return (folder ? `No notes in folder: ${folder}.` : "Vault is empty.") + indexNote(t);
            }
            if (name) {
                const lower = name.toLowerCase();
                notes = notes.filter((n) => n.path.toLowerCase().includes(lower));
            }
            if (tag) {
                notes = notes.filter((n) => t.index.getTags(n.path).includes(tag));
            }
            if (modified_after) {
                const cutoff = new Date(modified_after).getTime();
                if (isNaN(cutoff)) return fail(`Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`);
                notes = notes.filter((n) => n.mtime >= cutoff);
            }
            if (notes.length === 0) {
                const used = [name && `name '${name}'`, tag && `tag '${tag}'`, modified_after && `modified after ${modified_after}`].filter(Boolean).join(", ");
                return `No notes match these filters (${used})${folder ? ` in folder ${folder}` : ""}.${indexNote(t)}`;
            }
            if (sort_by === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const skip = offset ?? 0;
            const total = notes.length;
            const page = notes.slice(skip, skip + cap);
            if (page.length === 0) return `No more notes: offset ${skip} is past the ${total} matching notes.`;
            const lines = page.map((n) => {
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${link(t, n.path)})${n.size !== undefined ? ` (attachment, ${kb(n.size)})` : ""}`;
            });
            if (total > skip + cap) {
                lines.push(`\n... ${total - skip - cap} more (${total} total). Use offset=${skip + cap} for the next page.`);
            }
            return lines.join("\n") + indexNote(t);
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in a vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note and attachment counts.",
        parameters: z.object({ vault: vaultParam }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            let paths = t.index.listPaths();
            if (paths.length === 0) {
                paths = (await t.vault.listNotes()).filter((p) => !isHidden(p));
            }
            const folders = new Map<string, { notes: number; files: number }>();
            const count = (p: string, kind: "notes" | "files") => {
                const lastSlash = p.lastIndexOf("/");
                const folder = lastSlash === -1 ? "(root)" : p.slice(0, lastSlash);
                const c = folders.get(folder) ?? { notes: 0, files: 0 };
                c[kind]++;
                folders.set(folder, c);
                // Ensure all parent folders appear in the list
                let parent = folder;
                while (parent.includes("/")) {
                    parent = parent.slice(0, parent.lastIndexOf("/"));
                    if (!folders.has(parent)) folders.set(parent, { notes: 0, files: 0 });
                }
            };
            for (const p of paths) count(p, "notes");
            for (const f of t.index.listFiles()) count(f.path, "files");
            if (folders.size === 0) {
                return "Vault is empty." + indexNote(t);
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, c]) => `- ${f} (${c.notes} notes${c.files ? `, ${c.files} attachments` : ""})`).join("\n") + indexNote(t);
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in a vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({ vault: vaultParam }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const tags = t.index.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault." + indexNote(t);
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });

    server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once. To change frontmatter properties, use set_properties.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-25.md'"),
            content: z.string().describe("Text to append, prepend, or use as replacement for old_text"),
            operation: z
                .enum(["append", "prepend", "replace"])
                .optional()
                .describe("'append' (default): add to end. 'prepend': add after frontmatter. 'replace': swap old_text with content."),
            old_text: z
                .string()
                .optional()
                .describe("Required for replace operation. Exact text to find and replace. Must match exactly once."),
            expected_modified: expectedModifiedParam,
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const path = notePath(args.path);
            const { content: newContent, operation, old_text } = args;
            requireWritable(t, path);
            const existing = await t.vault.readNote(path);
            if (existing === null) return notFound(t, args.path);
            await checkUnchanged(t, path, args.expected_modified);

            let updated: string;
            const op = operation ?? "append";

            if (op === "replace") {
                if (!old_text) return fail("old_text is required for replace operation.");
                const idx = existing.indexOf(old_text);
                if (idx === -1) return fail("old_text not found in note.");
                if (existing.indexOf(old_text, idx + 1) !== -1) return fail("old_text matches multiple times. Provide a longer, unique string.");
                updated = existing.slice(0, idx) + newContent + existing.slice(idx + old_text.length);
            } else if (op === "prepend") {
                // Insert after frontmatter if present
                const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                if (fmMatch) {
                    const afterFm = fmMatch[0].length;
                    updated = existing.slice(0, afterFm) + newContent + "\n" + existing.slice(afterFm);
                } else {
                    updated = newContent + "\n" + existing;
                }
            } else {
                // append
                updated = existing.endsWith("\n") ? existing + newContent : existing + "\n" + newContent;
            }

            if (!(await t.vault.writeNote(path, updated))) fail(`Failed to edit note: ${path}`);
            t.index.update(path, updated, Date.now());
            return `Note edited (${op}): ${path}${await modified(t, path)}\n[Open in Obsidian](${link(t, path)})`;
        },
    });

    server.addTool({
        name: "set_properties",
        description:
            "Set or remove frontmatter properties of a note without touching the rest of it. Other properties, comments and the note body are kept. Pass null to remove a property.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/plan.md'"),
            properties: z
                .record(z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]))
                .describe("Properties to set, e.g. {\"status\": \"done\", \"tags\": [\"project\"], \"draft\": null}"),
            expected_modified: expectedModifiedParam,
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const path = notePath(args.path);
            requireWritable(t, path);
            const existing = await t.vault.readNote(path);
            if (existing === null) return notFound(t, args.path);
            await checkUnchanged(t, path, args.expected_modified);
            let updated: string;
            try {
                updated = setProperties(existing, args.properties);
            } catch (err) {
                return fail((err as Error).message);
            }
            if (!(await t.vault.writeNote(path, updated))) fail(`Failed to update properties: ${path}`);
            t.index.update(path, updated, Date.now());
            return `Properties updated (${Object.keys(args.properties).join(", ")}): ${path}${await modified(t, path)}\n[Open in Obsidian](${link(t, path)})`;
        },
    });

    server.addTool({
        name: "delete_note",
        description: `Delete a note or attachment. By default it moves to the vault's ${TRASH}/ folder like Obsidian does, so it can be restored with move_note; permanent=true deletes it for good. Deleting something already in ${TRASH}/ is permanent.`,
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note to delete"),
            permanent: z.boolean().optional().describe(`Delete for good instead of moving to ${TRASH}/. Default false.`),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const path = notePath(args.path);
            requireWritable(t, path);
            if ((await t.vault.getMtime(path)) === null) return notFound(t, args.path);
            const forget = () => {
                t.index.remove(path);
                t.index.setFile(path, null);
            };
            if (args.permanent || path.startsWith(`${TRASH}/`)) {
                if (!(await t.vault.deleteNote(path))) fail(`Failed to delete: ${path}`);
                forget();
                return `Deleted permanently: ${path}`;
            }
            let dest = `${TRASH}/${path}`;
            if ((await t.vault.getMtime(dest)) !== null) {
                // Keep the earlier trashed copy: suffix the new one with a timestamp.
                const stamp = iso(Date.now()).replace(/[:.]/g, "-");
                dest = hasExt(dest) ? dest.replace(/(\.[A-Za-z0-9]{1,8})$/, ` ${stamp}$1`) : `${dest} ${stamp}`;
            }
            if (!(await t.vault.moveNote(path, dest))) fail(`Failed to move to trash: ${path}`);
            forget();
            return `Moved to trash: ${dest}. Restore it with move_note, or delete it with permanent=true.`;
        },
    });

    const planLinkUpdate = (t: Target, from: string, to: string) => {
        const others = t.index.allPaths().filter((p) => p !== from);
        const stem = from.slice(from.lastIndexOf("/") + 1).replace(/\.md$/i, "");
        return {
            move: {
                from,
                to,
                bareNameWasUnique: !others.some((p) => nameOf(p) === nameOf(from)),
                bareNameStaysUnique: !others.some((p) => nameOf(p) === nameOf(to)),
            },
            // Cheap prefilter on the stored text; rewriteLinks decides what really is a link.
            candidates: t.index.notesContaining([stem, encodeURI(stem)]),
        };
    };
    const applyLinkUpdate = async (t: Target, plan: ReturnType<typeof planLinkUpdate>): Promise<string> => {
        let links = 0;
        const changed: string[] = [];
        const skipped: string[] = [];
        for (const src of plan.candidates) {
            const path = src === plan.move.from ? plan.move.to : src; // a note linking to itself moved too
            const before = await t.vault.readNote(path).catch(() => null);
            if (before === null) continue;
            const { content, count } = rewriteLinks(before, plan.move);
            if (count === 0) continue;
            if (!writable(t, path)) {
                skipped.push(path);
                continue;
            }
            if (!(await t.vault.writeNote(path, content))) {
                skipped.push(path);
                continue;
            }
            t.index.update(path, content, Date.now());
            links += count;
            changed.push(path);
        }
        const lines = [`Updated ${links} link${links === 1 ? "" : "s"} in ${changed.length} note${changed.length === 1 ? "" : "s"}${changed.length ? `: ${changed.join(", ")}` : ""}.`];
        if (skipped.length) lines.push(`Not updated (no write access or write failed): ${skipped.join(", ")}.`);
        return lines.join("\n");
    };

    server.addTool({
        name: "move_note",
        description:
            "Move or rename a note or attachment within a vault. Use this to rename within the same folder, move to a different folder, or both at once — also to restore something from _trash. Creates destination folders automatically. Refuses to overwrite an existing file. With update_links, links to it in other notes are rewritten like Obsidian does.",
        parameters: z.object({
            vault: vaultParam,
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
            update_links: z
                .boolean()
                .optional()
                .describe("Also rewrite [[links]], embeds and markdown links in other notes that point at this file. Only notes you may write are changed; skipped ones are listed. Default false."),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const from = notePath(args.from);
            // A destination without extension keeps the source's (an attachment stays an attachment).
            const rawTo = args.to.trim().replace(/^\/+/, "");
            const to = hasExt(rawTo) ? rawTo : rawTo + (from.match(/\.[A-Za-z0-9]{1,8}$/)?.[0] ?? ".md");
            // Moving out of a folder deletes there; moving in writes there — both ends must be writable.
            requireWritable(t, from);
            requireWritable(t, to);
            if ((await t.vault.getMtime(from)) === null) return notFound(t, args.from);
            // A case-only rename may resolve to the same note, so it is not a collision.
            if (from.toLowerCase() !== to.toLowerCase() && (await t.vault.getMtime(to)) !== null) {
                return fail(`Destination already exists: ${to}. Delete or move it first, or pick another name.`);
            }
            const content = await t.vault.readNote(from).catch(() => null); // null for attachments
            // Taken before the move: which notes may link here, and whether bare [[names]] resolve uniquely.
            const linkPlan = args.update_links ? planLinkUpdate(t, from, to) : undefined;
            if (!(await t.vault.moveNote(from, to))) fail(`Failed to move: ${from} → ${to}`);
            t.index.remove(from);
            t.index.setFile(from, null);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) t.index.update(to, content, Date.now());
            else {
                const meta = await t.vault.getMetadata(to);
                if (meta) t.index.setFile(to, { mtime: meta.mtime, size: meta.size });
            }
            const moved = `Moved: ${from} → ${to}\n[Open in Obsidian](${link(t, to)})`;
            return linkPlan ? `${moved}\n${await applyLinkUpdate(t, linkPlan)}` : moved;
        },
    });

    server.addTool({
        name: "get_note_metadata",
        description:
            "Get metadata about a note without reading its full content. Returns frontmatter, tags, outgoing links, backlinks (notes that link to this one), size, and timestamps. Use this to navigate the knowledge graph.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'projects/my-project.md'"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            const path = notePath(args.path);
            const meta = await t.vault.getMetadata(path);
            if (!meta) return notFound(t, args.path);
            const lines = [`**${path}**`, `Size: ${meta.size} bytes`, `Created: ${iso(meta.ctime)}`, `Modified: ${iso(meta.mtime)}`];
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
                }
            }
            if (meta.tags.length > 0) {
                lines.push(`\nTags: ${meta.tags.map((tag) => `#${tag}`).join(", ")}`);
            }
            if (meta.links.length > 0) {
                lines.push(`\nOutgoing links: ${meta.links.join(", ")}`);
            }
            const backlinks = t.index.getBacklinks(path);
            if (backlinks.length > 0) {
                lines.push(`\nBacklinks: ${backlinks.join(", ")}`);
            }
            lines.push(`\n[Open in Obsidian](${link(t, path)})`);
            return lines.join("\n");
        },
    });
}
