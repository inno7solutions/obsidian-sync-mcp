/**
 * Minimal CouchDB HTTP client for the registry and provisioning. Vault content
 * goes through livesync-commonlib (PouchDB); this only talks plain JSON docs and
 * the server admin API, so `fetch` is enough.
 */

export class CouchError extends Error {
    constructor(
        readonly status: number,
        readonly body: unknown,
        method: string,
        path: string,
    ) {
        super(`CouchDB ${method} ${path} failed: ${status} ${JSON.stringify(body)}`);
    }
}

export class Couch {
    private readonly authHeader: string;

    constructor(
        readonly url: string,
        readonly user: string,
        password: string,
    ) {
        this.url = url.replace(/\/+$/, "");
        this.authHeader = "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
    }

    /** JSON request. Statuses in `allow` are returned instead of thrown (e.g. 404, 409, 412). */
    async request<T = any>(method: string, path: string, body?: unknown, allow: number[] = []): Promise<{ status: number; json: T }> {
        const res = await fetch(this.url + path, {
            method,
            headers: { Authorization: this.authHeader, "Content-Type": "application/json", Accept: "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        const json = text ? JSON.parse(text) : undefined;
        if (!res.ok && !allow.includes(res.status)) throw new CouchError(res.status, json, method, path);
        return { status: res.status, json };
    }

    async get<T = any>(path: string): Promise<T | null> {
        const { status, json } = await this.request<T>("GET", path, undefined, [404]);
        return status === 404 ? null : json;
    }

    /** PUT a doc, fetching its current _rev first so the write overwrites. */
    async upsert(db: string, id: string, doc: Record<string, unknown>): Promise<void> {
        const path = `/${db}/${encodeURIComponent(id)}`;
        const existing = await this.get<{ _rev: string }>(path);
        await this.request("PUT", path, { ...doc, _id: id, ...(existing ? { _rev: existing._rev } : {}) });
    }

    async remove(db: string, id: string): Promise<void> {
        const path = `/${db}/${encodeURIComponent(id)}`;
        const existing = await this.get<{ _rev: string }>(path);
        if (existing) await this.request("DELETE", `${path}?rev=${existing._rev}`, undefined, [404]);
    }
}
