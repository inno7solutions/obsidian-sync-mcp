/**
 * YAML frontmatter (Obsidian "properties"): read as real YAML, and edit in place
 * so comments, ordering and untouched keys survive.
 */

import { parseDocument } from "yaml";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/;

/** Parsed frontmatter, or {} when there is none or it is not a YAML mapping. */
export function readFrontmatter(content: string): Record<string, unknown> {
    const m = FM_RE.exec(content);
    if (!m) return {};
    try {
        const doc = parseDocument(m[1]);
        if (doc.errors.length > 0) return {};
        const data = doc.toJS();
        return data && typeof data === "object" && !Array.isArray(data) ? data : {};
    } catch {
        return {};
    }
}

export type PropertyValue = string | number | boolean | string[] | null;

/** Set properties (null removes one). Throws when the existing frontmatter is not valid YAML. */
export function setProperties(content: string, props: Record<string, PropertyValue>): string {
    const m = FM_RE.exec(content);
    const doc = parseDocument(m ? m[1] : "");
    if (doc.errors.length > 0) throw new Error(`Frontmatter is not valid YAML (${doc.errors[0].message.split("\n")[0]}); fix it with edit_note first.`);
    if (doc.contents === null) doc.contents = doc.createNode({}) as never;
    for (const [key, value] of Object.entries(props)) {
        if (value === null) doc.delete(key);
        else doc.set(key, value);
    }
    const body = m ? content.slice(m[0].length) : content;
    const yaml = Object.keys(doc.toJS() ?? {}).length > 0 ? doc.toString().trimEnd() : "";
    return yaml ? `---\n${yaml}\n---\n${body}` : body;
}
