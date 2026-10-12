/**
 * Rewrite links that point at a moved note or attachment, the way Obsidian does
 * when you rename inside the app. Pure, so every link form is unit-testable.
 *
 * Handles `[[target]]`, `![[embed]]`, `[[target#heading|alias]]`, and markdown
 * links `[text](path.md)` (URL-encoded or not). A bare `[[Name]]` counts as a
 * link to the moved file only if that file name was unique in the vault, and it
 * stays bare only if the new name is unique too. Code fences are left alone.
 * Relative markdown links (`../x.md`) are not resolved.
 */

export interface LinkMove {
    from: string;
    to: string;
    /** No other file had the moved file's name before the move. */
    bareNameWasUnique: boolean;
    /** No other file has the new name after the move. */
    bareNameStaysUnique: boolean;
}

const stripMd = (p: string) => p.replace(/\.md$/i, "");
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export function rewriteLinks(content: string, m: LinkMove): { content: string; count: number } {
    const fromFull = m.from.toLowerCase();
    const fromNoExt = stripMd(m.from).toLowerCase();
    const fromBase = base(fromFull);
    const fromBaseNoExt = base(fromNoExt);
    let count = 0;

    /** New target in the original's style, or undefined when `target` doesn't point at `from`. */
    const retarget = (target: string): string | undefined => {
        const t = target.trim().replace(/^\/+/, "");
        const lower = t.toLowerCase();
        const isPath = t.includes("/");
        const hit = isPath ? lower === fromFull || lower === fromNoExt : m.bareNameWasUnique && (lower === fromBase || lower === fromBaseNoExt);
        if (!hit) return undefined;
        const keepExt = lower === fromFull || lower === fromBase;
        const next = keepExt ? m.to : stripMd(m.to);
        const out = !isPath && m.bareNameStaysUnique ? base(next) : next;
        if (out !== t) count++; // a bare name that still resolves is not a change
        return out;
    };

    const rewrite = (text: string) =>
        text
            .replace(/(!?\[\[)([^\]|#^\n]+)([#^][^\]|\n]*)?(\|[^\]\n]*)?\]\]/g, (all, open: string, target: string, anchor = "", alias = "") => {
                const next = retarget(target);
                return next === undefined ? all : `${open}${next}${anchor}${alias}]]`;
            })
            .replace(/(!?\[[^\]\n]*\]\()([^)\s#]+)(#[^)\s]*)?(\s+"[^"]*")?\)/g, (all, open: string, target: string, anchor = "", title = "") => {
                if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return all; // external URL, mailto:, obsidian:
                let decoded = target;
                try {
                    decoded = decodeURI(target);
                } catch {
                    // Malformed escape: compare as written.
                }
                const next = retarget(decoded);
                if (next === undefined) return all;
                const encode = decoded !== target || /\s/.test(next);
                const out = encode ? encodeURI(next).replace(/\(/g, "%28").replace(/\)/g, "%29") : next;
                return `${open}${out}${anchor}${title})`;
            });

    const parts = content.split(/(```[\s\S]*?```)/);
    const out = parts.map((part, i) => (i % 2 === 1 ? part : rewrite(part))).join("");
    return { content: out, count };
}
