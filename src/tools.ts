import { imageContent, type FastMCP } from "fastmcp";
import { z } from "zod";
import { makeDeepLink } from "./deeplink.js";
import type { VaultBackend } from "./vault-backend.js";
import type { SearchIndex } from "./search.js";
import { type Access, isWritable, describeAccess } from "./policy.js";
import type { AuditLogger } from "./audit.js";

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

const vaultParam = z
    .string()
    .optional()
    .describe("Vault id from list_vaults. Required when you have access to more than one vault.");

export function registerTools(server: FastMCP, resolver: VaultResolver, audit?: AuditLogger) {
    const target = async (args: { vault?: string }, ctx: { session?: unknown }): Promise<Target | { error: string }> => {
        const picked = resolver.pick(ctx.session, args.vault);
        if ("error" in picked) return picked;
        return { ...picked, ...(await resolver.open(picked.slug)) };
    };
    const writable = (t: Target, path: string) => isWritable(t.access, path);
    const denyWrite = (t: Target, path: string) =>
        `Write access denied: '${path}' is outside your writable scope in vault '${t.slug}' (${describeAccess(t.access)}).`;
    const link = (t: Target, path: string) => makeDeepLink(t.obsidianName, path);
    /** Obsidian links and embeds often name only the file (`![[diagram.png]]`, `[[Note]]`); resolve it the way Obsidian does. */
    const resolveName = async (t: Target, path: string): Promise<string | undefined> => {
        if (path.includes("/")) return undefined;
        const hits = await t.vault.findByName(path);
        if (hits.length > 0) return hits[0];
        if (!/\.[^.]+$/.test(path)) return (await t.vault.findByName(path + ".md"))[0];
        return undefined;
    };

    const _addTool = server.addTool.bind(server);
    server.addTool = (tool: any) => {
        const original = tool.execute;
        tool.execute = async (args: any, ctx: any) => {
            if (debugLogging) console.log(`[tool] ${tool.name}(${JSON.stringify(args)})`);
            const start = performance.now();
            const picked = resolver.pick(ctx?.session, args?.vault);
            const vault = "error" in picked ? (args?.vault ?? "") : picked.slug;
            try {
                const result = await original(args, ctx);
                // The only outcome we can read from a successful return is a
                // denial, whose message prefix we own (see denyWrite / pick).
                const denied = typeof result === "string" && (result.startsWith("Write access denied:") || "error" in picked);
                audit?.record({
                    vault,
                    tool: tool.name,
                    args,
                    session: ctx?.session,
                    outcome: denied && tool.name !== "list_vaults" ? "denied" : "ok",
                    ms: performance.now() - start,
                    sessionId: ctx?.sessionId,
                    requestId: ctx?.requestId,
                });
                if (debugLogging) console.log(`[tool] ${tool.name} → ${(performance.now() - start).toFixed(0)}ms`);
                return result;
            } catch (err) {
                audit?.record({
                    vault,
                    tool: tool.name,
                    args,
                    session: ctx?.session,
                    outcome: "error",
                    ms: performance.now() - start,
                    error: (err as Error)?.message,
                    sessionId: ctx?.sessionId,
                    requestId: ctx?.requestId,
                });
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
            "Read a note, text file or image (png, jpg, gif, webp) from an Obsidian vault. Returns the content — the image itself for images — and a deep link to open it in Obsidian. A bare file name like 'diagram.png' or 'Meeting' is resolved the way Obsidian resolves links.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            let path = args.path;
            if (IMAGE_EXT.test(path)) {
                let file = await t.vault.readBinary(path, MAX_IMAGE_BYTES);
                const resolved = file ? undefined : await resolveName(t, path);
                if (resolved) file = await t.vault.readBinary((path = resolved), MAX_IMAGE_BYTES);
                if (!file) return `Note not found: ${args.path}`;
                if (!file.bytes) {
                    return `Image too large to return: ${path} is ${(file.size / 1e6).toFixed(1)} MB (limit ${MAX_IMAGE_BYTES / 1e6} MB).\n[Open in Obsidian](${link(t, path)})`;
                }
                return { content: [{ type: "text" as const, text: `${path}\n[Open in Obsidian](${link(t, path)})` }, await imageContent({ buffer: Buffer.from(file.bytes) })] };
            }
            let content = await t.vault.readNote(path);
            const resolved = content === null ? await resolveName(t, path) : undefined;
            if (resolved) content = await t.vault.readNote((path = resolved));
            if (content === null) {
                return `Note not found: ${args.path}`;
            }
            const note = path === args.path ? "" : `Resolved '${args.path}' to '${path}'.\n`;
            return `${note}[Open in Obsidian](${link(t, path)})\n\n---\n\n${content}`;
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
            if ("error" in t) return t.error;
            // Images stay out of batches so one call can't flood the client's context.
            const read = async (path: string): Promise<string> => {
                if (IMAGE_EXT.test(path)) return "Image: use read_note to view it.";
                try {
                    const content = await t.vault.readNote(path);
                    return content === null ? "Note not found." : `[Open in Obsidian](${link(t, path)})\n\n${content}`;
                } catch (err) {
                    return (err as Error).message;
                }
            };
            const notes = await Promise.all(
                args.paths.map(async (path) => {
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
            if ("error" in t) return t.error;
            const { hits, total } = t.index.search(args.query, args.folder, args.limit ?? 20);
            if (total === 0) return `No notes match: ${args.query}`;
            const lines = hits.map(
                (h) => `- [${h.path}](${link(t, h.path)})${h.size !== undefined ? ` (attachment, ${kb(h.size)})` : ""}${h.snippet ? `\n  > ${h.snippet}` : ""}`,
            );
            if (total > hits.length) lines.push(`\n... and ${total - hits.length} more. Add words, a folder or a higher limit to narrow results.`);
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "write_note",
        description:
            "Write or update a note in an Obsidian vault. Creates the note if it doesn't exist. Replaces the entire content if it does — read first if you need to preserve existing content. Write access is per vault; a denied write says what you may write.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note, e.g. 'daily/2026-03-23.md'"),
            content: z.string().describe("Full markdown content for the note"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const { path, content } = args;
            if (!writable(t, path)) return denyWrite(t, path);
            const ok = await t.vault.writeNote(path, content);
            if (!ok) {
                return `Failed to write note: ${path}`;
            }
            t.index.update(path, content, Date.now());
            return `Note saved: ${path}\n[Open in Obsidian](${link(t, path)})`;
        },
    });

    server.addTool({
        name: "list_notes",
        description: "List markdown notes in a vault with modification timestamps. Examples: list_notes(sort_by='modified', limit=10) for 10 most recent notes. list_notes(name='meeting') to find notes by name. list_notes(folder='daily') for a specific folder. list_notes(tag='project') for notes with a specific tag. Returns up to 100 notes by default.",
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
            include_attachments: z
                .boolean()
                .optional()
                .describe("Also list attachments (images, PDFs, …) with their size. Default false. Tag filters never match attachments."),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const { folder, name, tag, sort_by, modified_after, limit, include_attachments } = args;
            // Use search index (works with encrypted vaults), fall back to vault
            let notes: Array<{ path: string; mtime: number; size?: number }> = t.index.listWithMtime(folder);
            if (notes.length === 0) {
                notes = await t.vault.listNotesWithMtime(folder);
            }
            if (include_attachments) {
                notes = [...notes, ...t.index.listFiles(folder)].sort((a, b) => a.path.localeCompare(b.path));
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
                if (isNaN(cutoff)) return `Invalid date format: ${modified_after}. Use ISO format like '2026-03-25'.`;
                notes = notes.filter((n) => n.mtime >= cutoff);
            }
            if (notes.length === 0) {
                return folder ? `No notes found in folder: ${folder}` : "Vault is empty.";
            }
            if (sort_by === "modified") {
                notes.sort((a, b) => b.mtime - a.mtime);
            }
            const cap = limit ?? 100;
            const total = notes.length;
            const capped = notes.slice(0, cap);
            const lines = capped.map((n) => {
                const date = n.mtime ? new Date(n.mtime).toISOString().slice(0, 16) : "";
                return `- ${date} [${n.path}](${link(t, n.path)})${n.size !== undefined ? ` (attachment, ${kb(n.size)})` : ""}`;
            });
            if (total > cap) {
                lines.push(`\n... and ${total - cap} more. Use a folder filter or limit to narrow results.`);
            }
            return lines.join("\n");
        },
    });

    server.addTool({
        name: "list_folders",
        description:
            "List all folders in a vault. Use this to discover folder names before writing or listing notes. Returns the folder tree with note and attachment counts.",
        parameters: z.object({ vault: vaultParam }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            let paths = t.index.listPaths();
            if (paths.length === 0) {
                paths = await t.vault.listNotes();
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
                return "Vault is empty.";
            }
            const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            return sorted.map(([f, c]) => `- ${f} (${c.notes} notes${c.files ? `, ${c.files} attachments` : ""})`).join("\n");
        },
    });

    server.addTool({
        name: "list_tags",
        description:
            "List all tags used in a vault, sorted by frequency. Use this to discover tags before filtering with list_notes.",
        parameters: z.object({ vault: vaultParam }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const tags = t.index.listAllTags();
            if (tags.length === 0) {
                return "No tags found in the vault.";
            }
            return tags.map(({ tag, count }) => `- #${tag} (${count} notes)`).join("\n");
        },
    });

    server.addTool({
        name: "edit_note",
        description:
            "Edit a note without rewriting it. Use 'append' (default) to add content to the end, 'prepend' to add after frontmatter, or 'replace' to swap old_text with new content. For replace, the old_text must match exactly once.",
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
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const { path, content: newContent, operation, old_text } = args;
            if (!writable(t, path)) return denyWrite(t, path);
            const existing = await t.vault.readNote(path);
            if (existing === null) {
                return `Note not found: ${path}`;
            }

            let updated: string;
            const op = operation ?? "append";

            if (op === "replace") {
                if (!old_text) {
                    return "old_text is required for replace operation.";
                }
                const idx = existing.indexOf(old_text);
                if (idx === -1) {
                    return "old_text not found in note.";
                }
                if (existing.indexOf(old_text, idx + 1) !== -1) {
                    return "old_text matches multiple times. Provide a longer, unique string.";
                }
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

            const ok = await t.vault.writeNote(path, updated);
            if (!ok) {
                return `Failed to edit note: ${path}`;
            }
            t.index.update(path, updated, Date.now());
            return `Note edited (${op}): ${path}\n[Open in Obsidian](${link(t, path)})`;
        },
    });

    server.addTool({
        name: "delete_note",
        description: "Delete a note from an Obsidian vault.",
        parameters: z.object({
            vault: vaultParam,
            path: z.string().describe("Vault-relative path to the note to delete"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const { path } = args;
            if (!writable(t, path)) return denyWrite(t, path);
            const ok = await t.vault.deleteNote(path);
            if (ok) t.index.remove(path);
            return ok ? `Deleted: ${path}` : `Failed to delete: ${path}`;
        },
    });

    server.addTool({
        name: "move_note",
        description:
            "Move or rename a note within a vault. Use this to rename a note within the same folder, move it to a different folder, or both at once. Creates destination folders automatically. Refuses to overwrite an existing note.",
        parameters: z.object({
            vault: vaultParam,
            from: z.string().describe("Current path, e.g. 'daily/old-name.md'"),
            to: z.string().describe("New path, e.g. 'projects/new-name.md'"),
        }),
        execute: async (args, ctx) => {
            const t = await target(args, ctx);
            if ("error" in t) return t.error;
            const { from, to } = args;
            // Moving out of a folder deletes there; moving in writes there — both ends must be writable.
            if (!writable(t, from)) return denyWrite(t, from);
            if (!writable(t, to)) return denyWrite(t, to);
            // A case-only rename may resolve to the same note, so it is not a collision.
            if (from.toLowerCase() !== to.toLowerCase() && (await t.vault.readNote(to)) !== null) {
                return `Destination already exists: ${to}. Delete or move it first, or pick another name.`;
            }
            const content = await t.vault.readNote(from);
            const ok = await t.vault.moveNote(from, to);
            if (!ok) {
                return `Failed to move: ${from} → ${to}`;
            }
            t.index.remove(from);
            // content === "" is an empty-but-present note: keep it indexed at the new path.
            if (content !== null) t.index.update(to, content, Date.now());
            return `Moved: ${from} → ${to}\n[Open in Obsidian](${link(t, to)})`;
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
            if ("error" in t) return t.error;
            const { path } = args;
            const meta = await t.vault.getMetadata(path);
            if (!meta) {
                return `Note not found: ${path}`;
            }
            const lines = [
                `**${path}**`,
                `Size: ${meta.size} bytes`,
                `Created: ${new Date(meta.ctime).toISOString()}`,
                `Modified: ${new Date(meta.mtime).toISOString()}`,
            ];
            if (Object.keys(meta.frontmatter).length > 0) {
                lines.push(`\nFrontmatter:`);
                for (const [k, v] of Object.entries(meta.frontmatter)) {
                    lines.push(`  ${k}: ${v}`);
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
