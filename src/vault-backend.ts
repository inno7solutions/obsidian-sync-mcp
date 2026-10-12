import type { NoteMetadata } from "./parse.js";

export interface NoteInfo extends NoteMetadata {
    path: string;
    size: number;
    ctime: number;
    mtime: number;
}

/** An attachment (any non-markdown file) as the index sees it: metadata only, never content. */
export interface FileMeta {
    mtime: number;
    size: number;
}

/** Called with null when the file was deleted. */
export type FileListener = (path: string, meta: FileMeta | null) => void;

export interface NoteListing {
    path: string;
    mtime: number;
}

export interface VaultBackend {
    init(): Promise<void>;
    close(): Promise<void>;
    /** Text content, null if missing. Throws for binary files. */
    readNote(path: string): Promise<string | null>;
    /** Bytes of a file, or only its size when larger than maxBytes; null if missing. */
    readBinary(path: string, maxBytes: number): Promise<{ size: number; bytes?: Uint8Array } | null>;
    /** Modification time in ms, or null if the file doesn't exist. Metadata only. */
    getMtime(path: string): Promise<number | null>;
    /** Paths whose file name equals `name` (case-insensitive), shortest path first. */
    findByName(name: string): Promise<string[]>;
    writeNote(path: string, content: string): Promise<boolean>;
    deleteNote(path: string): Promise<boolean>;
    /** Move a note or attachment (binary content is preserved). */
    moveNote(from: string, to: string): Promise<boolean>;
    getMetadata(path: string): Promise<NoteInfo | null>;
    listNotes(folder?: string): Promise<string[]>;
    listNotesWithMtime(folder?: string): Promise<NoteListing[]>;
    watchChanges?(callback: (path: string, content: string | null, mtime?: number, seq?: string | number) => void, onFile?: FileListener): void;
    /** Catch up on changes since a sequence. Returns the new sequence. CouchDB only. */
    catchUp?(since: string, callback: (path: string, content: string | null, mtime?: number) => void, onBatch?: (since: string, processed: number) => Promise<void>, onFile?: FileListener): Promise<string>;
}
