/**
 * Admin-side operations: every change to the registry together with the
 * CouchDB side effect that makes it real (databases, user accounts, per-vault
 * `_security`). Runs only in the admin role, which holds CouchDB admin creds.
 *
 * `_security` is always recomputed from the registry (`vaultSecurity`), never
 * patched, so re-running any operation converges to the same state.
 */

import type { Couch } from "./couch.js";
import type { RegistryStore } from "./store.js";
import { seal, open } from "../secret-box.js";
import {
    dbNameFor,
    docId,
    hashToken,
    isValidName,
    newPassword,
    newToken,
    vaultSecurity,
    type GrantMode,
    type Snapshot,
    type UserRecord,
    type VaultRecord,
} from "./model.js";
import { makeSetupUri, uriPassphrase as newUriPassphrase, type SetupUriInput } from "./setup-uri.js";
import { parseWriteFolders } from "../write-scope.js";

/** LiveSync's database version marker; without it the plugin reports "Remote database is newer or corrupted". */
const LIVESYNC_VERSION_DOC = { _id: "obsydian_livesync_version", type: "versioninfo", version: 12 };

/** Only CouchDB admins may write the registry; members (the MCP service) read it. */
const REGISTRY_VALIDATE = `function (newDoc, oldDoc, userCtx) {
  if (userCtx.roles.indexOf('_admin') === -1) throw({ forbidden: 'registry is read-only' });
}`;

const GRANT_MODES: readonly string[] = ["none", "read", "write", "folders"];

export interface ProvisionConfig {
    couch: Couch; // admin credentials
    store: RegistryStore;
    /** Seals vault E2E passphrases; the MCP role holds it too. */
    registryKey: string;
    /** Seals users' CouchDB passwords; admin role only. */
    credentialsKey: string;
    serviceUser: string;
    servicePassword: string;
    /** CouchDB URL as Obsidian clients reach it, for Setup URIs. */
    publicCouchUrl: string;
}

export class Provisioner {
    constructor(private readonly cfg: ProvisionConfig) {}

    private get couch() {
        return this.cfg.couch;
    }

    /** Idempotent startup: registry DB, its lock-down, the service account, and all vault `_security` docs. */
    async bootstrap(): Promise<void> {
        const db = this.cfg.store.db;
        await this.couch.request("PUT", `/${db}`, undefined, [412]);
        await this.couch.upsert(db, "_design/registry", { validate_doc_update: REGISTRY_VALIDATE });
        await this.couch.request("PUT", `/${db}/_security`, {
            admins: { names: [], roles: [] },
            members: { names: [this.cfg.serviceUser], roles: ["_admin"] },
        });
        await this.putCouchUser(this.cfg.serviceUser, this.cfg.servicePassword);
        const s = await this.cfg.store.load();
        for (const slug of s.vaults.keys()) await this.syncSecurity(s, slug);
    }

    private async putCouchUser(name: string, password: string): Promise<void> {
        await this.couch.upsert("_users", `org.couchdb.user:${name}`, { name, password, roles: [], type: "user" });
    }

    private async syncSecurity(s: Snapshot, slug: string): Promise<void> {
        const vault = s.vaults.get(slug);
        if (!vault) return;
        await this.couch.request("PUT", `/${vault.db}/_security`, vaultSecurity(s, slug, this.cfg.serviceUser));
    }

    /** Re-sync every vault the user can appear in (after enable/disable/delete). */
    private async syncAllSecurity(): Promise<void> {
        const s = await this.cfg.store.load();
        for (const slug of s.vaults.keys()) await this.syncSecurity(s, slug);
    }

    // --- Vaults ---

    async createVault(input: { slug: string; displayName: string; obsidianName: string; passphrase?: string }): Promise<void> {
        const slug = input.slug.trim();
        if (!isValidName(slug)) throw new Error("Vault id: lowercase letters, digits and '-', starting with a letter, max 40.");
        const s = await this.cfg.store.load();
        if (s.vaults.has(slug)) throw new Error(`Vault '${slug}' already exists.`);
        const db = dbNameFor(slug);
        await this.couch.request("PUT", `/${db}`, undefined, [412]);
        await this.couch.request("PUT", `/${db}/${LIVESYNC_VERSION_DOC._id}`, LIVESYNC_VERSION_DOC, [409]);
        const passphrase = input.passphrase?.trim();
        const vault: VaultRecord = {
            type: "vault",
            slug,
            displayName: input.displayName.trim() || slug,
            obsidianName: input.obsidianName.trim() || input.displayName.trim() || slug,
            db,
            archived: false,
            createdAt: new Date().toISOString(),
            ...(passphrase ? { passphraseEnc: seal(passphrase, this.cfg.registryKey) } : {}),
        };
        await this.cfg.store.put(docId.vault(slug), vault);
        await this.syncSecurity(await this.cfg.store.load(), slug);
    }

    async updateVault(slug: string, patch: { displayName?: string; obsidianName?: string; archived?: boolean }): Promise<void> {
        const s = await this.cfg.store.load();
        const vault = s.vaults.get(slug);
        if (!vault) throw new Error(`Unknown vault '${slug}'.`);
        const next: VaultRecord = {
            ...vault,
            displayName: patch.displayName?.trim() || vault.displayName,
            obsidianName: patch.obsidianName?.trim() || vault.obsidianName,
            archived: patch.archived ?? vault.archived,
        };
        await this.cfg.store.put(docId.vault(slug), next);
        await this.syncSecurity(await this.cfg.store.load(), slug);
    }

    // --- Users ---

    /** Creates the registry user and its CouchDB account. Returns the generated CouchDB password. */
    async createUser(input: { username: string; email: string; name: string }): Promise<string> {
        const username = input.username.trim();
        if (!isValidName(username)) throw new Error("Username: lowercase letters, digits and '-', starting with a letter, max 40.");
        if (username === this.cfg.serviceUser) throw new Error(`'${username}' is reserved for the MCP service.`);
        const s = await this.cfg.store.load();
        if (s.users.has(username)) throw new Error(`User '${username}' already exists.`);
        const existing = await this.couch.get(`/_users/${encodeURIComponent(`org.couchdb.user:${username}`)}`);
        if (existing) throw new Error(`A CouchDB account '${username}' already exists outside the registry.`);
        const password = newPassword();
        await this.putCouchUser(username, password);
        const user: UserRecord = {
            type: "user",
            username,
            email: input.email.trim(),
            name: input.name.trim() || username,
            couchPasswordEnc: seal(password, this.cfg.credentialsKey),
            disabled: false,
            createdAt: new Date().toISOString(),
        };
        await this.cfg.store.put(docId.user(username), user);
        return password;
    }

    async updateUser(username: string, patch: { email?: string; name?: string; disabled?: boolean }): Promise<void> {
        const user = (await this.cfg.store.load()).users.get(username);
        if (!user) throw new Error(`Unknown user '${username}'.`);
        await this.cfg.store.put(docId.user(username), {
            ...user,
            email: patch.email?.trim() || user.email,
            name: patch.name?.trim() || user.name,
            disabled: patch.disabled ?? user.disabled,
        });
        if (patch.disabled !== undefined && patch.disabled !== user.disabled) await this.syncAllSecurity();
    }

    /** New CouchDB password; every device of this user must re-import a Setup URI. */
    async resetPassword(username: string): Promise<string> {
        const user = (await this.cfg.store.load()).users.get(username);
        if (!user) throw new Error(`Unknown user '${username}'.`);
        const password = newPassword();
        await this.putCouchUser(username, password);
        await this.cfg.store.put(docId.user(username), { ...user, couchPasswordEnc: seal(password, this.cfg.credentialsKey) });
        return password;
    }

    async deleteUser(username: string): Promise<void> {
        const s = await this.cfg.store.load();
        if (!s.users.has(username)) throw new Error(`Unknown user '${username}'.`);
        for (const g of s.grants.filter((g) => g.username === username)) await this.cfg.store.remove(docId.grant(username, g.vault));
        for (const t of [...s.tokens.values()].filter((t) => t.username === username)) await this.cfg.store.remove(docId.token(t.hash));
        await this.cfg.store.remove(docId.user(username));
        // Revoke vault membership first: if the account delete fails, the user still can't sync.
        await this.syncAllSecurity();
        await this.couch.remove("_users", `org.couchdb.user:${username}`);
    }

    // --- Grants ---

    /** mode "none" removes the grant. Folders are a comma-separated list for mode "folders". */
    async setGrant(username: string, slug: string, mode: GrantMode | "none", folders = ""): Promise<void> {
        if (!GRANT_MODES.includes(mode)) throw new Error(`Unknown access mode '${mode}'.`);
        const s = await this.cfg.store.load();
        if (!s.users.has(username)) throw new Error(`Unknown user '${username}'.`);
        if (!s.vaults.has(slug)) throw new Error(`Unknown vault '${slug}'.`);
        if (mode === "none") {
            await this.cfg.store.remove(docId.grant(username, slug));
        } else {
            const list = mode === "folders" ? (parseWriteFolders(folders) ?? []) : [];
            if (mode === "folders" && list.length === 0) throw new Error("Folder access needs at least one folder.");
            await this.cfg.store.put(docId.grant(username, slug), { type: "grant", username, vault: slug, mode, folders: list });
        }
        await this.syncSecurity(await this.cfg.store.load(), slug);
    }

    // --- MCP tokens ---

    /** Returns the token; only its hash is stored. */
    async issueToken(username: string, label: string): Promise<string> {
        const user = (await this.cfg.store.load()).users.get(username);
        if (!user) throw new Error(`Unknown user '${username}'.`);
        const token = newToken();
        const hash = hashToken(token);
        await this.cfg.store.put(docId.token(hash), {
            type: "token",
            hash,
            username,
            label: label.trim() || "token",
            createdAt: new Date().toISOString(),
        });
        return token;
    }

    async revokeToken(username: string, hash: string): Promise<void> {
        const token = (await this.cfg.store.load()).tokens.get(hash);
        if (token?.username !== username) throw new Error(`No such token for '${username}'.`);
        await this.cfg.store.remove(docId.token(hash));
    }

    // --- Onboarding ---

    async setupUri(username: string, slug: string): Promise<{ uri: string; uriPassphrase: string; manual: SetupUriInput }> {
        const s = await this.cfg.store.load();
        const user = s.users.get(username);
        const vault = s.vaults.get(slug);
        if (!user || !vault) throw new Error("Unknown user or vault.");
        if (!s.grants.some((g) => g.username === username && g.vault === slug)) throw new Error(`${username} has no grant on ${slug}.`);
        const uriPassphrase = newUriPassphrase();
        const manual: SetupUriInput = {
            couchdbUrl: this.cfg.publicCouchUrl,
            username,
            password: open(user.couchPasswordEnc, this.cfg.credentialsKey),
            database: vault.db,
            passphrase: vault.passphraseEnc ? open(vault.passphraseEnc, this.cfg.registryKey) : undefined,
        };
        const uri = await makeSetupUri(manual, uriPassphrase);
        return { uri, uriPassphrase, manual };
    }
}
