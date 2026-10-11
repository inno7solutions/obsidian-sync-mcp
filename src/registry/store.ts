/**
 * Registry store: all vault/user/grant/token docs live in one CouchDB database.
 * The data set is small (admins edit it by hand), so readers always work on a
 * full in-memory snapshot and reload it whenever the _changes feed moves.
 */

import type { Couch } from "./couch.js";
import { buildSnapshot, type RegistryDoc, type Snapshot } from "./model.js";

export class RegistryStore {
    constructor(
        private readonly couch: Couch,
        readonly db: string,
    ) {}

    async load(): Promise<Snapshot> {
        const { json } = await this.couch.request("GET", `/${this.db}/_all_docs?include_docs=true`);
        return buildSnapshot(json.rows.filter((r: any) => !r.id.startsWith("_design/")).map((r: any) => r.doc));
    }

    put(id: string, doc: RegistryDoc): Promise<void> {
        return this.couch.upsert(this.db, id, doc as unknown as Record<string, unknown>);
    }

    remove(id: string): Promise<void> {
        return this.couch.remove(this.db, id);
    }

    /**
     * Long-poll the _changes feed forever and call `onChange` with a fresh
     * snapshot after every change. Errors back off and retry, so a CouchDB
     * restart only delays updates. Returns a stop function.
     */
    watch(onChange: (s: Snapshot) => void): () => void {
        let stopped = false;
        (async () => {
            let since: string | null = null;
            while (!stopped) {
                if (since === null) {
                    // Take the seq first, then reload: no change can slip in between.
                    try {
                        since = String((await this.couch.request("GET", `/${this.db}`)).json.update_seq);
                        onChange(await this.load());
                    } catch (err) {
                        since = null;
                        console.error(`Registry watch failed, retrying in 5s: ${(err as Error).message}`);
                        await new Promise((r) => setTimeout(r, 5000));
                    }
                    continue;
                }
                try {
                    const { json } = await this.couch.request("GET", `/${this.db}/_changes?feed=longpoll&timeout=55000&since=${encodeURIComponent(since)}`);
                    since = json.last_seq;
                    if (json.results.length > 0 && !stopped) onChange(await this.load());
                } catch (err) {
                    console.error(`Registry watch failed, retrying in 5s: ${(err as Error).message}`);
                    await new Promise((r) => setTimeout(r, 5000));
                }
            }
        })();
        return () => {
            stopped = true;
        };
    }
}
