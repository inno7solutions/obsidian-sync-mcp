# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

Give any AI agent access to your Obsidian vault over MCP. Run it locally against your vault files, or pair it with [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and deploy to the cloud so it works even when your machine is off.

> **Example:** From your phone, ask your AI: "What's in my daily note for today?" — and get the full content back, with a link to open it in Obsidian.

---

## How it works

The server connects to your vault in two ways:

- **Filesystem mode** — reads `.md` files directly from your vault folder. No database needed.
- **CouchDB mode** — reads from a CouchDB database, locally or in the cloud. Your vault syncs to CouchDB via [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync), the community Obsidian plugin (600k+ downloads). The MCP server reads from CouchDB directly using [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) — the same library that powers the plugin — for proper chunk handling and E2E encryption support.

Both modes expose the same MCP tools over HTTP, so any MCP-compatible agent can connect: Claude, Copilot, custom agents, anything that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

---

## Choose your setup

| Need it always available? | Have LiveSync? | Go to |
|---|---|---|
| Yes | Yes | [Setup A](#a-deploy-mcp-to-the-cloud) — add MCP alongside your existing CouchDB |
| Yes | No | [Setup B](#b-deploy-everything-to-the-cloud) — CouchDB + MCP + LiveSync from scratch |
| No | — | [Setup C](#c-run-on-your-machine) — filesystem or CouchDB, npx or Docker |

---

## A. Deploy MCP to the cloud

You already have LiveSync and CouchDB on an always-on server. You just need the MCP server deployed alongside it.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 2 (MCP only)
```

The script asks for your CouchDB connection details, vault name, and encryption passphrase.

**Or run the Docker image on any always-on server:**

```bash
docker run -p 8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e COUCHDB_URL=https://your-couchdb:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD=yourpassword \
  -e COUCHDB_DATABASE=obsidian -e VAULT_NAME=MyVault \
  -e COUCHDB_PASSPHRASE=your-encryption-passphrase \
  -e COUCHDB_OBFUSCATE_PROPERTIES=false \
  -e MCP_AUTH_TOKEN=yourpassword \
  -e BASE_URL=https://your-server-url \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Set `COUCHDB_PASSPHRASE` if you use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings. Set `BASE_URL` to your public URL (required for OAuth callbacks when agents connect over HTTPS).

Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `https://your-server:8787/mcp` (Docker behind HTTPS).

See [Cost](#cost-flyio) for Fly.io pricing.

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

## B. Deploy everything to the cloud

Starting fresh — no LiveSync yet. Deploy CouchDB and MCP together, then set up LiveSync in Obsidian.

**Using Fly.io setup script** (macOS/Linux, or WSL on Windows):

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
./deploy/setup.sh    # choose option 1 (CouchDB + MCP)
```

The script generates credentials, creates the database, and deploys. Save the credentials it prints.

**Or with Docker Compose on any always-on server:**

```bash
git clone https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp

cat > .env <<EOF
COUCHDB_PASSWORD=changeme
VAULT_NAME=MyVault
EOF

docker compose up -d
```

**After deployment:**

1. In Obsidian, install [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) and configure it with the credentials from the setup output
2. Your MCP endpoint is `https://your-app.fly.dev/mcp` (Fly.io) or `http://your-server:8787/mcp` (Docker)
3. The `MCP_AUTH_TOKEN` is the password you enter when an agent connects

```
Always-on server
├── CouchDB + persistent storage
└── MCP server
      ↑                    ↑
Obsidian + LiveSync    AI agents
```

Requires [flyctl](https://fly.io/docs/flyctl/install/) for the Fly.io path:

```bash
curl -L https://fly.io/install.sh | sh
export PATH="$HOME/.fly/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc
fly auth login
```

---

### Cost (Fly.io)

Applies to both Setup A and Setup B.

| Component | Cost |
|---|---|
| CouchDB + MCP VM (shared, 512MB) | ~$3-4/month (kept alive by LiveSync) |
| MCP-only VM (shared, 256MB) | ~$0-2/month (suspends when idle) |
| 1GB persistent volume | ~$0.15/month |

As of March 2026, Fly.io [may waive charges under $5/month](https://community.fly.io/t/bill-clarification-under-5-usd-of-usage-bill-charges-are-waived/26366), which could make this effectively free with a shared IPv4. Either way, cheaper than Obsidian Sync ($4/month) and you own the data.

---

## C. Run on your machine

Run the MCP server locally. Works with filesystem mode (reads vault files directly) or CouchDB mode (if you have LiveSync). Machine must stay on for agents to reach it.

**Filesystem mode (simplest):**

```bash
VAULT_PATH=~/Documents/MyVault \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

**CouchDB mode (if you have LiveSync):**

```bash
COUCHDB_URL=http://localhost:5984 \
COUCHDB_USER=admin \
COUCHDB_PASSWORD=yourpassword \
COUCHDB_DATABASE=obsidian \
COUCHDB_PASSPHRASE=your-encryption-passphrase \
COUCHDB_OBFUSCATE_PROPERTIES=false \
VAULT_NAME=MyVault \
npx obsidian-sync-mcp
```

Omit `COUCHDB_PASSPHRASE` if you don't use E2E encryption in LiveSync. Set `COUCHDB_OBFUSCATE_PROPERTIES=true` if "Obfuscate Properties" is also enabled in your LiveSync settings. For an existing vault the server detects the actual setting from the database at startup and corrects a mismatch with a warning; only for a brand-new empty database does the value need to match your LiveSync settings.

**Or with Docker:**

```bash
docker run -p 8787:8787 \
  -v mcp-data:/data -e DATA_DIR=/data \
  -e VAULT_PATH=/vault -v ~/Documents/MyVault:/vault \
  -e VAULT_NAME=MyVault \
  ghcr.io/es617/obsidian-sync-mcp:latest
```

Your MCP endpoint is `http://localhost:8787/mcp`.

**Want remote access?** Add a tunnel (machine must stay on):

```bash
cloudflared tunnel --url http://localhost:8787    # free
tailscale funnel 8787                             # or Tailscale
ngrok http 8787                                   # or ngrok
```

Set `BASE_URL` to the tunnel URL when using authentication.

---

## Tools

| Tool | Description |
|---|---|
| `read_note` | Read a note's markdown content by path |
| `write_note` | Create or overwrite a note (replaces entire content) |
| `edit_note` | Edit a note without rewriting it — append, prepend (after frontmatter), or replace exact text |
| `list_folders` | List all folders in the vault with note counts — use to discover folder names |
| `list_tags` | List all tags in the vault with counts — use to discover tags before filtering |
| `list_notes` | List notes with timestamps. Filter by folder, name, tag, or date. Sort by name or modified. |
| `delete_note` | Delete a note |
| `move_note` | Move or rename a note — works across folders, creates destination folders automatically |
| `get_note_metadata` | Get frontmatter, tags, outgoing links, backlinks, size, and timestamps — navigate the knowledge graph |

Every tool response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI) (`obsidian://open?vault=...&file=...`) that works on Mac and iOS.

> "Add a bullet point to my daily note." "Find my notes about the MCP server and fix the typo in the second one."

---

## Authentication

Set `MCP_AUTH_TOKEN` to a password to enable authentication:

```bash
MCP_AUTH_TOKEN=mysecretpassword npx obsidian-sync-mcp
```

The server includes a self-contained OAuth 2.1 provider. When an agent connects:

1. A browser window opens with a password page
2. Enter the `MCP_AUTH_TOKEN` password
3. The agent gets an access token and refreshes it transparently

The session is shared across all your Claude interfaces (Desktop, Web, Mobile) and persists across server restarts. You'll need to re-enter the password after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`).

For non-OAuth clients (curl, MCP Inspector, custom agents), you can also pass the token directly as `Authorization: Bearer <MCP_AUTH_TOKEN>`.

Without `MCP_AUTH_TOKEN`, the server runs without authentication — suitable for local use or behind a private network.

### Team mode: your own identity provider

For a team, one shared password is the wrong unit. Set `IDP_PROVIDER` instead and
the server authenticates against your IdP (Entra ID, Google, or any OIDC
provider such as Keycloak or Authentik), so people sign in as themselves:

```bash
IDP_PROVIDER=azure \
IDP_TENANT_ID=<tenant-id> \
IDP_CLIENT_ID=<app-client-id> \
IDP_CLIENT_SECRET=<app-client-secret> \
IDP_REQUIRED_GROUPS=vault-team \
BASE_URL=https://vault.example.com \
npx obsidian-sync-mcp
```

The server presents itself to MCP clients as a standards-compliant
authorization server — serving the discovery documents they expect and handling
dynamic client registration — and proxies the actual login upstream to your IdP,
which does not need to support dynamic registration itself. Register
`<BASE_URL>/oauth/callback` as a redirect URI in the IdP app.

Each caller's identity (`sub`, `email`, `name`, and group/role claims) is read
from the OIDC ID token and attached to the session, which is what per-user
authorization and audit logging build on. Access is denied unless the caller
satisfies `IDP_REQUIRED_GROUPS` and/or `IDP_ALLOWED_DOMAINS` — set at least one,
or any account your IdP will issue a token to can reach the vault.

`IDP_PROVIDER` and `MCP_AUTH_TOKEN` are mutually exclusive; setting both is a
startup error, since both serve `/oauth/*`.

#### Generic OIDC setup (Keycloak, Authentik, Okta, …)

For any OpenID Connect provider, use `IDP_PROVIDER=generic` and point it at the
provider's endpoints (both listed in its `/.well-known/openid-configuration`):

```bash
IDP_PROVIDER=generic \
IDP_AUTHORIZATION_ENDPOINT=https://idp.example.com/authorize \
IDP_TOKEN_ENDPOINT=https://idp.example.com/token \
IDP_CLIENT_ID=<client-id> \
IDP_CLIENT_SECRET=<client-secret> \
IDP_REQUIRED_GROUPS=vault-team \
IDP_GROUPS_CLAIM=groups \
BASE_URL=https://vault.example.com \
npx obsidian-sync-mcp
```

In the provider, create a **confidential/web** client (it has a secret and does
the authorization-code flow), and:

1. **Redirect URI** — add `<BASE_URL>/oauth/callback` exactly. This is the list
   that actually constrains where tokens can be sent; keep it tight (the
   server's own `IDP_ALLOWED_REDIRECT_URIS` can only widen, not narrow — see the
   note below).
2. **Groups in the ID token** — the server reads membership from the ID token,
   so the provider must put it there under the claim named by `IDP_GROUPS_CLAIM`
   (default `groups`):
   - **Keycloak** — add a *Group Membership* mapper on the client (or a dedicated
     client scope), name it `groups`, and tick "Add to ID token". Untick "Full
     group path" unless your `POLICY` uses `/parent/child` names.
   - **Authentik** — the default `groups` scope already emits a `groups` claim in
     the ID token; add that scope to the provider and request it (it is covered
     by the default `IDP_SCOPES`).
   - **Okta** — add a *Groups* claim to the **ID token** (not just the access
     token) with a filter matching your vault groups, named `groups`.
3. **Assignment = who can read this vault.** Restrict the app to the group(s)
   that should reach this vault, and set `IDP_REQUIRED_GROUPS` to match. Because
   reads are not scoped inside a vault, this assignment *is* the read boundary.

Verify the ID token actually carries `groups` before rolling out — decode it at
[jwt.io](https://jwt.io) or check the server log for `Auth denied … (claims
carried: …)`, which lists exactly what arrived. Then map those group names to
write scope with `POLICY` (below).

This whole flow — discovery, dynamic client registration, consent, upstream
login, callback, token exchange, the group gate, `POLICY` scoping, and the audit
line — is covered end to end by `npm run test:idp`, which runs the server
against a local OIDC stub. Point that test at your own provider's config to
smoke-test a real tenant.

#### Audit log

Every tool call is logged as one JSON line — who called it, which tool, which
path, the outcome (`ok` / `denied` / `error`), and how long it took:

```json
{"ts":"2026-08-24T12:00:00.000Z","evt":"tool_call","vault":"Team","actor":"jane@inno7.com","sub":"...","tool":"delete_note","outcome":"ok","ms":42,"destructive":true,"params":{"path":"Projects/x.md"},"sessionId":"..."}
```

`actor` is the caller's email (or subject id) in IdP mode, `anonymous` in
password / no-auth mode. `delete_note` and `move_note` carry `destructive:true`
for easy alerting. Note **bodies are never logged** — `content` and `old_text`
appear only as `content_len` / `old_text_len`. Paths *are* logged, and paths are
sensitive in an E2E vault (they reveal its structure), so treat the audit stream
as confidential. On by default; `AUDIT_LOG=off` disables it, `AUDIT_LOG_FILE`
also appends to a file.

#### Per-user write access

By default every authenticated caller has the container's full write scope. Set
`POLICY` to grant write access by group instead:

```jsonc
POLICY='[
  {"group":"vault-admins","writeFolders":null},        // write anywhere
  {"group":"vault-editors","writeFolders":["Projects","Inbox"]},
  {"group":"*","readOnly":true}                          // everyone else: read-only
]'
```

Rules are matched in order, first match wins, so list specific groups before the
`*` catch-all. A caller with no matching rule is read-only (default deny).
Readers don't just get refused — the write tools are hidden from them entirely.
`POLICY` is always intersected with the process-wide `READ_ONLY` / `WRITE_FOLDERS`
ceiling, so those can only ever remove access, never add it. Group membership
comes from the ID token claims named by `IDP_GROUPS_CLAIM`.

Two things to know before exposing this:

- **Use a dedicated, minimally privileged app registration.** The OAuth proxy
  answers `/oauth/register` with the upstream `client_id` and `client_secret` —
  that is how it bridges clients that expect dynamic registration — so treat
  those credentials as readable by anyone who can reach the port. Grant the app
  nothing beyond `openid`/`profile`/`email` and no client-credentials grant.
- **Redirect URIs are constrained by your IdP, not by this server.**
  `IDP_ALLOWED_REDIRECT_URIS` can only *add* patterns (for clients whose
  callback is neither HTTPS nor loopback); the underlying check falls back to
  accepting any HTTPS or loopback URI, so keep the IdP's own redirect URI list
  tight.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_PATH` | Filesystem mode | — | Path to your Obsidian vault directory |
| `COUCHDB_URL` | CouchDB mode | — | CouchDB server URL |
| `COUCHDB_USER` | CouchDB mode | `admin` | CouchDB username |
| `COUCHDB_PASSWORD` | CouchDB mode | — | CouchDB password (required) |
| `COUCHDB_DATABASE` | CouchDB mode | `obsidian` | CouchDB database name |
| `COUCHDB_PASSPHRASE` | CouchDB mode | — | LiveSync E2E encryption passphrase (must match plugin setting) |
| `COUCHDB_OBFUSCATE_PROPERTIES` | CouchDB mode | `false` | Set to `true` if "Obfuscate Properties" is enabled in LiveSync (obfuscates file paths, sizes, dates in the database). For existing vaults the actual setting is auto-detected at startup; this value only decides the format for a brand-new empty database |
| `VAULT_NAME` | Both | `MyVault` | Vault name (used for deep links and index storage) |
| `MCP_AUTH_TOKEN` | Optional | — | Password for authentication |
| `IDP_PROVIDER` | Optional | — | Enables team auth against an identity provider: `azure` (Entra ID), `google`, or `generic` (any OIDC provider — Keycloak, Authentik, Okta). Mutually exclusive with `MCP_AUTH_TOKEN`. `github` is rejected: GitHub OAuth issues no ID token, so there is no identity or group claim to authorize against. |
| `IDP_CLIENT_ID` | With `IDP_PROVIDER` | — | OAuth client id of the app registration for this server |
| `IDP_CLIENT_SECRET` | With `IDP_PROVIDER` | — | OAuth client secret. Also the seed for the token-signing and storage-encryption keys, so rotating it ends all live sessions. |
| `IDP_TENANT_ID` | `azure` only | `common` | Entra tenant id, or `organizations` / `consumers` |
| `IDP_AUTHORIZATION_ENDPOINT` | `generic` only | — | From your IdP's `/.well-known/openid-configuration` |
| `IDP_TOKEN_ENDPOINT` | `generic` only | — | From your IdP's `/.well-known/openid-configuration` |
| `IDP_REQUIRED_GROUPS` | Optional | — | Comma-separated groups/roles; the caller must be in at least one. Read from the ID token claims named by `IDP_GROUPS_CLAIM`. |
| `IDP_ALLOWED_DOMAINS` | Optional | — | Comma-separated email domains allowed to connect (e.g. `example.com`). Combine with or use instead of `IDP_REQUIRED_GROUPS`; with neither set, any account your IdP will issue a token to has access. |
| `IDP_GROUPS_CLAIM` | Optional | `groups,roles` | ID token claims to read group/role membership from. Entra app roles arrive in `roles`; Keycloak/Authentik usually need a mapper to emit `groups`. Note Google does not put Workspace groups in the ID token — use `IDP_ALLOWED_DOMAINS` there. |
| `POLICY` | Optional | — | JSON array mapping groups to write access, e.g. `[{"group":"vault-admins","writeFolders":null},{"group":"vault-editors","writeFolders":["Projects","Inbox"]},{"group":"*","readOnly":true}]`. First matching rule wins (put specific groups before `*`). `writeFolders:null` means the whole vault; a list scopes writes; `readOnly:true` denies them. No matching rule ⇒ read-only (default deny). Only meaningful with `IDP_PROVIDER`. Always narrowed by the `READ_ONLY` / `WRITE_FOLDERS` ceiling. |
| `IDP_SCOPES` | Optional | `openid profile email offline_access` (`azure`, `generic`); `openid profile email` (`google`) | Comma-separated scopes requested upstream. Must include `openid` — without an ID token there is no identity. |
| `IDP_ALLOWED_REDIRECT_URIS` | Optional | hosted Claude callbacks + loopback | Comma-separated redirect URI patterns (`*` wildcards) to *add* for clients whose callback is neither HTTPS nor loopback. Cannot narrow: the underlying check accepts any HTTPS or loopback URI regardless. |
| `IDP_JWT_SIGNING_KEY` | Optional | derived from `IDP_CLIENT_SECRET` | Signing key for the server's own session tokens. Set explicitly to rotate it independently of the client secret. |
| `IDP_ENCRYPTION_KEY` | Optional | derived from `IDP_CLIENT_SECRET` | Encryption key for the persisted OAuth token store. Changing it invalidates stored sessions. |
| `BASE_URL` | Optional | `http://localhost:PORT` | Public URL (for OAuth callbacks when using a tunnel). In IdP mode it is also the token issuer and audience, so it must be the URL clients actually reach. |
| `PORT` | Optional | `8787` | HTTP port |
| `HOST` | Optional | `0.0.0.0` | Bind address (`127.0.0.1` to restrict to localhost) |
| `MCP_ALLOWED_HOSTS` | Optional | — | Comma-separated extra `Host` values accepted in no-auth mode (e.g. `192.168.1.5,mybox.local`). No-auth mode rejects any other Host to block browser DNS-rebinding; localhost is always allowed. Ignored when `MCP_AUTH_TOKEN` is set. |
| `AUDIT_LOG` | Optional | `on` | One JSON line per tool call (actor, tool, path, outcome, timing) to stdout. Set to `off` to disable. Note bodies are never logged — only their byte length. |
| `AUDIT_LOG_FILE` | Optional | — | Additionally append audit lines to this file (created `0600`). Stdout still receives them. |
| `DATA_DIR` | Optional | `~/.obsidian-mcp` | Directory for persisted data (metadata index, auth tokens) |
| `LOG_LEVEL` | Optional | — | Set to `debug` for verbose logging (library logs, change feed, index sync) |
| `MCP_REFRESH_DAYS` | Optional | `14` | Days before auth session expires |
| `READ_ONLY` | Optional | `false` | Set to `true` to disable all write tools (`write_note`, `edit_note`, `delete_note`, `move_note`). Only read tools are exposed via MCP. Useful when sharing the server with multiple AI clients and write access should be opt-in. |
| `WRITE_FOLDERS` | Optional | — | Comma-separated list of vault-relative folders where writes are allowed (e.g. `MCP,Inbox`). When set, the whole vault stays readable but `write_note`, `edit_note`, `delete_note`, and `move_note` refuse paths outside these folders (`move_note` requires both source and destination to be writable). Enforced server-side, unlike `MCP_INSTRUCTIONS`. Matching is case-sensitive and folder-boundary-aware (`MCP` matches `MCP/note.md` but not `MCP-private/note.md`). Ignored when `READ_ONLY=true`; unset means the whole vault is writable. |
| `MCP_INSTRUCTIONS` | Optional | — | Extra text appended to the server's MCP `instructions` (the string clients inject into the system prompt). Use this to bake vault-specific conventions into the server — e.g. folder structure, naming rules, folders to avoid — so they apply across every MCP client without per-client config. Best-effort: not all clients respect `instructions`. |
| `MCP_INSTRUCTIONS_FILE` | Optional | — | Path to a file (e.g. markdown) whose contents are appended to the MCP `instructions`. Easier than `MCP_INSTRUCTIONS` for multi-line conventions. If both are set, the file wins and `MCP_INSTRUCTIONS` is ignored (with a startup warning). Missing/unreadable file or files larger than 32 KB are fatal startup errors. **Store this file somewhere only the service user can write (e.g. `chmod 600`)** — its contents land in every MCP session's system prompt, so write access to it = prompt-injection access to every client. |

Set `VAULT_PATH` for filesystem mode or `COUCHDB_URL` for CouchDB mode.

---

## Try without an agent

Test the server interactively using the [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
VAULT_PATH=~/Documents/MyVault npx obsidian-sync-mcp &
npx @modelcontextprotocol/inspector
```

Set transport to **Streamable HTTP**, enter `http://localhost:8787/mcp`, and connect.

---

## How to update

| How you run it | How to update |
|---|---|
| `npx obsidian-sync-mcp` | Automatic — npx pulls latest |
| Fly.io | From the same directory where you ran setup: `fly deploy`. If you lost the fly.toml, run `fly config save --app your-app-name` to restore it. |
| Docker | `docker pull ghcr.io/es617/obsidian-sync-mcp:latest` and restart |

---

## Known limitations

- **Single vault per instance.** Each server connects to one vault. For multiple vaults, run multiple instances on different ports.
- **Single machine on Fly.io.** Auth state is in-memory, so multiple machines break the OAuth flow. The setup script enforces this automatically.
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, last write wins.
- **Text only.** Binary attachments are not exposed through MCP tools.
- **Deep links depend on the client.** Obsidian `obsidian://` deep links are included in every tool response. They work on Claude Mobile and in browsers, but some clients (Claude Desktop) may not render them as clickable links.
- **Node 22+ required.**
- **Setup script requires bash.** The `deploy/setup.sh` script works on macOS and Linux. On Windows, use WSL or Git Bash.

---

## Safety

This server gives an AI agent read/write access to your Obsidian vault.

**Agents can modify and delete notes.** Keep backups. Use tool approval deliberately.

**Authentication is optional.** Always set `MCP_AUTH_TOKEN` when exposing to the internet.

**Use HTTPS in production.** Use a tunnel or deploy behind a reverse proxy.

This software is provided as-is under the [MIT license](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE). You are responsible for what agents do with your vault.

---

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install && npm run build
npm test          # unit tests
npm run test:e2e  # integration tests
```

---

## License

MIT — see [LICENSE](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [CouchDB](https://couchdb.apache.org/) — document database
- [Fly.io](https://fly.io/) — deployment platform
