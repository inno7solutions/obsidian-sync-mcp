/**
 * Admin web UI: server-rendered HTML forms over the Provisioner. No client
 * JavaScript, no build step. Login with ADMIN_TOKEN; the session is an
 * HttpOnly SameSite=Strict cookie, and every POST carries a per-session CSRF
 * token. Secrets (passwords, MCP tokens, Setup URIs) are shown exactly once.
 *
 * Meant to listen on loopback / a private network only: it holds CouchDB admin
 * credentials and the registry key.
 */

import { Hono, type Context } from "hono";
import { randomBytes, timingSafeEqual } from "crypto";
import type { Provisioner } from "../registry/provision.js";
import type { RegistryStore } from "../registry/store.js";
import type { SetupUriInput } from "../registry/setup-uri.js";
import { grantToAccess, userVaults, vaultSecurity, type GrantMode, type Snapshot } from "../registry/model.js";
import { describeAccess } from "../policy.js";
import type { AuditLogger } from "../audit.js";

export interface AdminUiConfig {
    adminToken: string;
    provisioner: Provisioner;
    store: RegistryStore;
    audit: AuditLogger;
    serviceUser: string;
    /** Shown in the client config snippet after issuing a token. */
    publicMcpUrl: string;
}

/**
 * How a user pulls an existing vault into Obsidian without ever overwriting
 * CouchDB. Shown with every Setup URI; the "Rebuild" path is the one way a new
 * client can wipe the shared vault.
 */
const onboardingSteps = (obsidianName: string) => `<h2>Connect Obsidian (pull, never overwrite)</h2><ol>
<li>In Obsidian, create a <strong>new, empty vault</strong> named <code>${h(obsidianName)}</code> (deep links use this name). Never use a vault that already has notes.</li>
<li>Install and enable the community plugin <strong>Self-hosted LiveSync</strong>.</li>
<li>Copy the Setup URI below, run <em>Use the copied setup URI</em> from the command palette and enter the URI passphrase.</li>
<li>When the wizard asks how to start, choose <strong>Fetch from remote</strong> (also called “Fetch remote database” or “Use this device as a new client”). <strong>Never</strong> choose “Rebuild”, “Overwrite remote” or “Initialise remote”: they upload the empty vault and wipe the shared one.</li>
<li>Before restarting Obsidian, check the vault folder: if an empty <code>flag_rebuild.md</code> exists, a wipe is queued — <strong>delete it</strong> and create an empty <code>flag_fetch.md</code> instead.</li>
<li>After the fetch finishes, open the LiveSync settings → <em>Sync settings</em> and set <strong>Sync mode = LiveSync</strong>. The wizard turns sync off during the fetch and leaves it off, even though the URI sets it. Check that <em>Batch database update</em> is off, so changes from agents appear within seconds.</li>
<li>If nothing syncs: open <em>Self-hosted LiveSync: Show log</em>; after a sync error use <em>Reload app without saving</em>.</li>
</ol>`;

/** Fallback when the Setup URI import fails: the same values, typed in by hand. */
const manualSteps = (m: SetupUriInput) => `<h2>Manual setup (if the Setup URI does not work)</h2><ol>
<li>Do steps 1–2 above, then in the LiveSync wizard choose manual setup with remote type <strong>CouchDB</strong>.</li>
<li>Enter the connection values below and use <em>Test</em> to check them.</li>
<li>${m.passphrase ? "Enable <strong>End-to-end encryption</strong> with the passphrase below (it must match exactly) and enable <strong>Path obfuscation</strong>." : "Leave <strong>End-to-end encryption</strong> off."}</li>
<li>Continue with steps 4–7 above: <strong>Fetch from remote</strong>, never Rebuild; then set <em>Sync mode = LiveSync</em>.</li>
</ol>
${[["Server URI", m.couchdbUrl], ["Username", m.username], ["Password", m.password], ["Database name", m.database], ...(m.passphrase ? [["E2E passphrase", m.passphrase]] : [])]
    .map(([k, v]) => `<label>${h(k)}</label><pre>${h(v)}</pre>`)
    .join("")}`;

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const COOKIE = "osm_admin";

export const h = (v: unknown) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Client-side MCP server name, e.g. "obsidian-vault-example-com-vaults", so several servers
 * don't collide as "vaults". `suffix` is a vault id for a single-vault connection.
 */
export function mcpServerName(publicMcpUrl: string, suffix = "vaults"): string {
    let host = "server";
    try {
        host = new URL(publicMcpUrl).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || host;
    } catch {
        // Malformed PUBLIC_MCP_URL: keep the generic name.
    }
    return `obsidian-${host}-${suffix}`;
}

/** The MCP URL pinned to one vault (`?vault=<id>`). */
export function singleVaultUrl(publicMcpUrl: string, slug: string): string {
    try {
        const url = new URL(publicMcpUrl);
        url.searchParams.set("vault", slug);
        return url.toString();
    } catch {
        return `${publicMcpUrl}?vault=${encodeURIComponent(slug)}`;
    }
}

function tokenMatches(given: string, expected: string): boolean {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

const STYLE = `
:root{--bg:#fafafa;--fg:#1b1b1f;--muted:#6b6b76;--card:#fff;--line:#e3e3e8;--accent:#4f46e5;--danger:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--fg:#ececf1;--muted:#9a9aa6;--card:#1d1d22;--line:#2e2e36;--accent:#8b85ff;--danger:#f97066;--ok:#47cd89}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}header{display:flex;gap:16px;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:12px 16px;background:var(--card)}
header a{color:var(--fg);text-decoration:none;font-weight:600}a{color:var(--accent)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0}
h1{font-size:20px;margin:8px 0}h2{font-size:16px;margin:0 0 12px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:middle}th{color:var(--muted);font-weight:500;font-size:13px}
.scroll{overflow-x:auto}form.inline{display:inline}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px;align-items:end}
label{display:block;font-size:13px;color:var(--muted)}input,select{width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:6px 12px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.secondary{background:transparent;color:var(--accent)}button.danger{background:transparent;border-color:var(--danger);color:var(--danger)}
.muted{color:var(--muted)}.badge{display:inline-block;padding:0 6px;border-radius:4px;border:1px solid var(--line);font-size:12px}
.err{border-color:var(--danger)}code,pre{font:13px ui-monospace,monospace;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 4px}
pre{padding:10px;white-space:pre-wrap;word-break:break-all}
`;

function layout(title: string, body: string, csrf?: string): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Vault Admin</title><style>${STYLE}</style></head><body>
<header><a href="/">Vault Admin</a>${csrf ? `<form class="inline" method="post" action="/logout"><input type="hidden" name="csrf" value="${h(csrf)}"><button class="secondary">Log out</button></form>` : ""}</header>
<main>${body}</main></body></html>`;
}

export function createAdminApp(cfg: AdminUiConfig): Hono {
    const app = new Hono();
    const sessions = new Map<string, { csrf: string; expires: number }>();

    const sessionOf = (c: Context) => {
        const sid = /(?:^|;\s*)osm_admin=([^;]+)/.exec(c.req.header("cookie") ?? "")?.[1];
        const s = sid ? sessions.get(sid) : undefined;
        if (!s || s.expires < Date.now()) return undefined;
        return { sid: sid!, ...s };
    };

    app.get("/login", (c) =>
        c.html(layout("Log in", `<section><h1>Log in</h1><form method="post" action="/login" class="grid">
<div><label for="t">Admin token</label><input id="t" name="token" type="password" autocomplete="current-password" required></div>
<div><button>Log in</button></div></form></section>`)),
    );

    app.post("/login", async (c) => {
        const body = await c.req.parseBody();
        if (!tokenMatches(String(body.token ?? ""), cfg.adminToken)) {
            cfg.audit.admin("login_failed", "-");
            return c.html(layout("Log in", `<section class="err"><p>Wrong token.</p><a href="/login">Try again</a></section>`), 401);
        }
        for (const [id, s] of sessions) if (s.expires < Date.now()) sessions.delete(id);
        const sid = randomBytes(32).toString("base64url");
        sessions.set(sid, { csrf: randomBytes(24).toString("base64url"), expires: Date.now() + SESSION_TTL_MS });
        cfg.audit.admin("login", "-");
        c.header("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
        return c.redirect("/");
    });

    // Everything below needs a session; POSTs also need the CSRF token.
    app.use("*", async (c, next) => {
        const s = sessionOf(c);
        if (!s) return c.redirect("/login");
        if (c.req.method === "POST") {
            const body = await c.req.parseBody();
            if (typeof body.csrf !== "string" || !tokenMatches(body.csrf, s.csrf)) return c.text("CSRF check failed", 403);
        }
        c.set("csrf" as never, s.csrf as never);
        c.set("sid" as never, s.sid as never);
        await next();
    });

    const csrfOf = (c: Context) => c.get("csrf" as never) as string;
    const hidden = (c: Context) => `<input type="hidden" name="csrf" value="${h(csrfOf(c))}">`;
    const render = (c: Context, title: string, body: string, status = 200) => c.html(layout(title, body, csrfOf(c)), status as 200);
    const fail = (c: Context, err: unknown, back: string) =>
        render(c, "Error", `<section class="err"><h1>That did not work</h1><p>${h((err as Error).message)}</p><a href="${h(back)}">Back</a></section>`, 400);
    const form = async (c: Context) => (await c.req.parseBody()) as Record<string, string>;

    /** Run an admin action, audit it, then redirect — or show the error. */
    const act = (action: string, back: (c: Context) => string, fn: (c: Context, f: Record<string, string>) => Promise<string | void>) =>
        async (c: Context) => {
            const f = await form(c);
            try {
                const target = (await fn(c, f)) ?? "-";
                cfg.audit.admin(action, target);
                return c.redirect(back(c));
            } catch (err) {
                return fail(c, err, back(c));
            }
        };

    /** `note` and `extra` are trusted HTML built here; secret values are escaped. */
    const secretPage = (c: Context, title: string, rows: [string, string][], note: string, back: string, extra = "") =>
        render(
            c,
            title,
            `<section><h1>${h(title)}</h1><p class="muted">${note} It is shown only once; store it now.</p>
${rows.map(([k, v]) => `<label>${h(k)}</label><pre>${h(v)}</pre>`).join("")}${extra}<p><a href="${h(back)}">Done</a></p></section>`,
        );

    app.post("/logout", (c) => {
        sessions.delete(c.get("sid" as never) as string);
        c.header("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        return c.redirect("/login");
    });

    // --- Dashboard ---
    app.get("/", async (c) => {
        const s = await cfg.store.load();
        return render(c, "Overview", dashboard(s, cfg.serviceUser, hidden(c)));
    });

    // --- Vaults ---
    app.post(
        "/vaults",
        act("vault_create", () => "/", async (_c, f) => {
            await cfg.provisioner.createVault({ slug: f.slug ?? "", displayName: f.displayName ?? "", obsidianName: f.obsidianName ?? "", passphrase: f.passphrase });
            return f.slug;
        }),
    );

    app.get("/vaults/:slug", async (c) => {
        const s = await cfg.store.load();
        const v = s.vaults.get(c.req.param("slug"));
        if (!v) return c.notFound();
        return render(c, v.displayName, vaultPage(s, v.slug, cfg.serviceUser, hidden(c)));
    });

    app.post(
        "/vaults/:slug",
        act("vault_update", (c) => `/vaults/${c.req.param("slug")}`, async (c, f) => {
            const slug = c.req.param("slug")!;
            await cfg.provisioner.updateVault(slug, {
                displayName: f.displayName,
                obsidianName: f.obsidianName,
                archived: f.archived === undefined ? undefined : f.archived === "1",
            });
            return slug;
        }),
    );

    // --- Users ---
    app.post("/users", async (c) => {
        const f = await form(c);
        try {
            const password = await cfg.provisioner.createUser({ username: f.username ?? "", email: f.email ?? "", name: f.name ?? "" });
            cfg.audit.admin("user_create", f.username!);
            return secretPage(c, "User created", [["CouchDB user", f.username!], ["CouchDB password", password]], "Next: grant vaults on the user page, then issue a Setup URI per vault (it already contains this password, and the page shows the user how to connect Obsidian without overwriting the vault). One account covers all the user's vaults and devices.", `/users/${f.username}`);
        } catch (err) {
            return fail(c, err, "/");
        }
    });

    app.get("/users/:u", async (c) => {
        const s = await cfg.store.load();
        const u = s.users.get(c.req.param("u"));
        if (!u) return c.notFound();
        return render(c, u.name, userPage(s, u.username, hidden(c)));
    });

    const userBack = (c: Context) => `/users/${c.req.param("u")}`;

    app.post(
        "/users/:u",
        act("user_update", userBack, async (c, f) => {
            const u = c.req.param("u")!;
            await cfg.provisioner.updateUser(u, { email: f.email, name: f.name, disabled: f.disabled === undefined ? undefined : f.disabled === "1" });
            return u;
        }),
    );

    app.post(
        "/users/:u/delete",
        act("user_delete", () => "/", async (c, f) => {
            const u = c.req.param("u")!;
            if (f.confirm !== u) throw new Error(`Type the username '${u}' to confirm deletion.`);
            await cfg.provisioner.deleteUser(u);
            return u;
        }),
    );

    app.post("/users/:u/reset-password", async (c) => {
        const u = c.req.param("u")!;
        try {
            const password = await cfg.provisioner.resetPassword(u);
            cfg.audit.admin("user_reset_password", u);
            return secretPage(c, "Password reset", [["CouchDB user", u], ["New CouchDB password", password]], "Every device of this user stops syncing until it imports a new Setup URI.", `/users/${u}`);
        } catch (err) {
            return fail(c, err, `/users/${u}`);
        }
    });

    app.post(
        "/users/:u/grants",
        act("grant_set", userBack, async (c, f) => {
            const u = c.req.param("u")!;
            await cfg.provisioner.setGrant(u, f.vault ?? "", (f.mode ?? "none") as GrantMode | "none", f.folders ?? "");
            return `${u}:${f.vault}=${f.mode}`;
        }),
    );

    app.post("/users/:u/tokens", async (c) => {
        const u = c.req.param("u")!;
        const f = await form(c);
        try {
            const scope = f.vault?.trim() || undefined;
            const token = await cfg.provisioner.issueToken(u, f.label ?? "", scope);
            cfg.audit.admin("token_issue", `${u}:${f.label ?? ""}${scope ? `@${scope}` : ""}`);
            const add = (name: string, url: string) => `claude mcp add --transport http ${name} "${url}" --header "Authorization: Bearer ${token}"`;
            const vaults = userVaults(await cfg.store.load(), u).filter((v) => !scope || v.vault.slug === scope);
            const perVault = vaults.map((v): [string, string] => [
                `Claude Code — only vault ${v.vault.slug}`,
                add(mcpServerName(cfg.publicMcpUrl, v.vault.slug), singleVaultUrl(cfg.publicMcpUrl, v.vault.slug)),
            ]);
            return secretPage(
                c,
                "MCP token issued",
                [["Token", token], ...(scope ? [] : [["Claude Code — all vaults", add(mcpServerName(cfg.publicMcpUrl), cfg.publicMcpUrl)] as [string, string]]), ...perVault, ["MCP URL", scope ? singleVaultUrl(cfg.publicMcpUrl, scope) : cfg.publicMcpUrl]],
                `${scope ? `This token only reaches vault ${h(scope)}. ` : ""}Send it to the user over a private channel. A single-vault command mounts just that vault as its own MCP server; run it inside a project and Claude Code keeps it to that project (default local scope).`,
                `/users/${u}`,
            );
        } catch (err) {
            return fail(c, err, `/users/${u}`);
        }
    });

    app.post(
        "/users/:u/tokens/:hash/revoke",
        act("token_revoke", userBack, async (c) => {
            await cfg.provisioner.revokeToken(c.req.param("u")!, c.req.param("hash")!);
            return `${c.req.param("u")}:${c.req.param("hash")!.slice(0, 12)}`;
        }),
    );

    app.post("/users/:u/setup-uri", async (c) => {
        const u = c.req.param("u")!;
        const f = await form(c);
        try {
            const { uri, uriPassphrase, manual } = await cfg.provisioner.setupUri(u, f.vault ?? "");
            const vault = (await cfg.store.load()).vaults.get(f.vault ?? "");
            cfg.audit.admin("setup_uri", `${u}:${f.vault}`);
            return secretPage(
                c,
                `Setup URI for ${f.vault}`,
                [["Setup URI", uri], ["URI passphrase", uriPassphrase]],
                "Send the URI and its passphrase to the user over separate private channels: the URI contains their CouchDB password and the vault's E2E passphrase.",
                `/users/${u}`,
                onboardingSteps(vault?.obsidianName ?? f.vault ?? "") + manualSteps(manual),
            );
        } catch (err) {
            return fail(c, err, `/users/${u}`);
        }
    });

    return app;
}

// --- Views ---

function dashboard(s: Snapshot, serviceUser: string, hidden: string): string {
    const vaultRows = [...s.vaults.values()]
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((v) => {
            const members = vaultSecurity(s, v.slug, serviceUser).members.names.filter((n) => n !== serviceUser).length;
            return `<tr><td><a href="/vaults/${h(v.slug)}">${h(v.slug)}</a></td><td>${h(v.displayName)}</td><td><code>${h(v.db)}</code></td>
<td>${v.passphraseEnc ? '<span class="badge">E2EE</span>' : ""} ${v.archived ? '<span class="badge">archived</span>' : ""}</td><td>${members}</td></tr>`;
        })
        .join("");
    const userRows = [...s.users.values()]
        .sort((a, b) => a.username.localeCompare(b.username))
        .map((u) => {
            const tokens = [...s.tokens.values()].filter((t) => t.username === u.username).length;
            return `<tr><td><a href="/users/${h(u.username)}">${h(u.username)}</a></td><td>${h(u.name)}</td><td>${h(u.email)}</td>
<td>${userVaults(s, u.username).length}</td><td>${tokens}</td><td>${u.disabled ? '<span class="badge">disabled</span>' : ""}</td></tr>`;
        })
        .join("");
    return `<h1>Overview</h1>
<section><h2>Vaults</h2><div class="scroll"><table><tr><th>Id</th><th>Name</th><th>Database</th><th></th><th>Members</th></tr>${vaultRows || '<tr><td colspan="5" class="muted">No vaults yet.</td></tr>'}</table></div>
<h2 style="margin-top:16px">New vault</h2><form method="post" action="/vaults" class="grid">${hidden}
<div><label for="vs">Id (lowercase, a-z0-9-)</label><input id="vs" name="slug" required pattern="[a-z][a-z0-9-]{0,39}"></div>
<div><label for="vd">Display name</label><input id="vd" name="displayName"></div>
<div><label for="vo">Obsidian vault name</label><input id="vo" name="obsidianName" placeholder="defaults to display name"></div>
<div><label for="vp">E2E passphrase (optional, fixed)</label><input id="vp" name="passphrase" type="password" autocomplete="new-password"></div>
<div><button>Create vault</button></div></form>
<p class="muted">Creates database <code>vault-&lt;id&gt;</code> with LiveSync's version marker, so first clients never see “Remote database is newer or corrupted”. The Obsidian vault name is what users name the vault on their devices; deep links only work if it matches. The E2E passphrase cannot be changed later — data written with it is unreadable with any other — and it is handed to clients inside the Setup URI.</p></section>
<section><h2>Users</h2><div class="scroll"><table><tr><th>Username</th><th>Name</th><th>Email</th><th>Vaults</th><th>Tokens</th><th></th></tr>${userRows || '<tr><td colspan="6" class="muted">No users yet.</td></tr>'}</table></div>
<h2 style="margin-top:16px">New user</h2><form method="post" action="/users" class="grid">${hidden}
<div><label for="uu">Username (a-z0-9-)</label><input id="uu" name="username" required pattern="[a-z][a-z0-9-]{0,39}"></div>
<div><label for="un">Name</label><input id="un" name="name"></div>
<div><label for="ue">Email</label><input id="ue" name="email" type="email"></div>
<div><button>Create user</button></div></form></section>`;
}

function vaultPage(s: Snapshot, slug: string, serviceUser: string, hidden: string): string {
    const v = s.vaults.get(slug)!;
    const rows = s.grants
        .filter((g) => g.vault === slug)
        .map((g) => {
            const u = s.users.get(g.username);
            return `<tr><td><a href="/users/${h(g.username)}">${h(g.username)}</a></td><td>${h(describeAccess(grantToAccess(g)))}</td><td>${u?.disabled ? '<span class="badge">disabled</span>' : ""}</td></tr>`;
        })
        .join("");
    const members = vaultSecurity(s, slug, serviceUser).members.names;
    return `<p><a href="/">← Overview</a></p><h1>${h(v.displayName)} <span class="muted">(${h(v.slug)})</span></h1>
<section><h2>Settings</h2><form method="post" action="/vaults/${h(slug)}" class="grid">${hidden}
<div><label for="d">Display name</label><input id="d" name="displayName" value="${h(v.displayName)}"></div>
<div><label for="o">Obsidian vault name (deep links)</label><input id="o" name="obsidianName" value="${h(v.obsidianName)}"></div>
<div><button>Save</button></div></form>
<p class="muted">Database <code>${h(v.db)}</code> · ${v.passphraseEnc ? "end-to-end encrypted" : "not encrypted"} · created ${h(v.createdAt.slice(0, 10))}</p>
<form method="post" action="/vaults/${h(slug)}">${hidden}<input type="hidden" name="archived" value="${v.archived ? "0" : "1"}">
<button class="${v.archived ? "secondary" : "danger"}">${v.archived ? "Unarchive" : "Archive (revokes all sync and MCP access, keeps data)"}</button></form></section>
<section><h2>Access</h2><div class="scroll"><table><tr><th>User</th><th>MCP access</th><th></th></tr>${rows || '<tr><td colspan="3" class="muted">Nobody has access. Grant it on a user page.</td></tr>'}</table></div>
<p class="muted">CouchDB members: ${members.map((m) => `<code>${h(m)}</code>`).join(" ") || "none (archived)"}. Every member can sync and write via LiveSync; read-only applies to MCP only.</p></section>`;
}

function userPage(s: Snapshot, username: string, hidden: string): string {
    const u = s.users.get(username)!;
    const base = `/users/${h(username)}`;
    const grantRows = [...s.vaults.values()]
        .filter((v) => !v.archived)
        .sort((a, b) => a.slug.localeCompare(b.slug))
        .map((v) => {
            const g = s.grants.find((g) => g.username === username && g.vault === v.slug);
            const mode = g?.mode ?? "none";
            const opt = (m: string, label: string) => `<option value="${m}"${m === mode ? " selected" : ""}>${label}</option>`;
            return `<tr><td>${h(v.slug)}</td><td><form method="post" action="${base}/grants" class="grid">${hidden}<input type="hidden" name="vault" value="${h(v.slug)}">
<div><label for="m-${h(v.slug)}">Access</label><select id="m-${h(v.slug)}" name="mode">${opt("none", "No access")}${opt("read", "Read")}${opt("write", "Read & write")}${opt("folders", "Write in folders")}</select></div>
<div><label for="f-${h(v.slug)}">Folders (comma-separated)</label><input id="f-${h(v.slug)}" name="folders" value="${h(g?.folders.join(", ") ?? "")}"></div>
<div><button class="secondary">Save</button></div></form></td>
<td>${g ? `<form method="post" action="${base}/setup-uri">${hidden}<input type="hidden" name="vault" value="${h(v.slug)}"><button class="secondary">Setup URI</button></form>` : ""}</td></tr>`;
        })
        .join("");
    const tokenRows = [...s.tokens.values()]
        .filter((t) => t.username === username)
        .map(
            (t) => `<tr><td>${h(t.label)}</td><td>${t.vault ? h(t.vault) : '<span class="muted">all vaults</span>'}</td><td>${h(t.createdAt.slice(0, 16).replace("T", " "))}</td><td><code>${h(t.hash.slice(0, 12))}…</code></td>
<td><form method="post" action="${base}/tokens/${h(t.hash)}/revoke">${hidden}<button class="danger">Revoke</button></form></td></tr>`,
        )
        .join("");
    return `<p><a href="/">← Overview</a></p><h1>${h(u.name)} <span class="muted">(${h(username)})</span> ${u.disabled ? '<span class="badge">disabled</span>' : ""}</h1>
<section><h2>Profile</h2><form method="post" action="${base}" class="grid">${hidden}
<div><label for="n">Name</label><input id="n" name="name" value="${h(u.name)}"></div>
<div><label for="e">Email</label><input id="e" name="email" type="email" value="${h(u.email)}"></div>
<div><button>Save</button></div></form>
<p style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">
<form method="post" action="${base}">${hidden}<input type="hidden" name="disabled" value="${u.disabled ? "0" : "1"}"><button class="${u.disabled ? "secondary" : "danger"}">${u.disabled ? "Enable" : "Disable (blocks sync and MCP)"}</button></form>
<form method="post" action="${base}/reset-password">${hidden}<button class="danger">Reset CouchDB password</button></form></p></section>
<section><h2>Vault access</h2><p class="muted">One CouchDB account per user; a grant adds it to the vault database. Read-only limits MCP only — LiveSync can still write.</p>
<div class="scroll"><table><tr><th>Vault</th><th>Access</th><th>Obsidian</th></tr>${grantRows || '<tr><td colspan="3" class="muted">No vaults yet.</td></tr>'}</table></div></section>
<section><h2>MCP tokens</h2><div class="scroll"><table><tr><th>Label</th><th>Scope</th><th>Created</th><th>Id</th><th></th></tr>${tokenRows || '<tr><td colspan="5" class="muted">No tokens.</td></tr>'}</table></div>
<form method="post" action="${base}/tokens" class="grid" style="margin-top:12px">${hidden}<div><label for="l">Label</label><input id="l" name="label" placeholder="e.g. laptop Claude Code" required></div>
<div><label for="ts">Scope (fixed once issued)</label><select id="ts" name="vault"><option value="">All granted vaults</option>${userVaults(s, username)
        .map((v) => `<option value="${h(v.vault.slug)}">Only ${h(v.vault.slug)}</option>`)
        .join("")}</select></div><div><button>Issue token</button></div></form></section>
<section><h2>Delete user</h2><form method="post" action="${base}/delete" class="grid">${hidden}
<div><label for="c">Type “${h(username)}” to confirm</label><input id="c" name="confirm" required></div><div><button class="danger">Delete user, grants and tokens</button></div></form></section>`;
}
