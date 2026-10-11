# Obsidian Sync MCP

<!-- mcp-name: io.github.es617/obsidian-sync-mcp -->

![MCP](https://img.shields.io/badge/MCP-compatible-blue)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Node](https://img.shields.io/badge/node-22%2B-green.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue.svg)

A team server that gives AI agents access to many Obsidian vaults over MCP.
Vaults sync through [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)
and CouchDB; an admin web UI manages vaults, users, per-vault access and MCP tokens.

> **Example:** Ask your AI "What's in the team's meeting notes from Monday?" — it calls
> `list_vaults`, picks the team vault, and answers with a link that opens the note in Obsidian.

---

## How it works

```
Obsidian (LiveSync) ──per-user CouchDB account──▶ CouchDB ◀──mcp-service── MCP server ◀──per-user token── AI client
                                                     ▲                         │
                                                     └── admin UI (CouchDB admin) ─ registry ─┘
```

- **Vault = CouchDB database** (`vault-<id>`). One LiveSync E2E passphrase per vault (optional).
- **User = one CouchDB account** (for LiveSync on every device) **+ MCP tokens** (for AI clients).
- **Grant = user × vault → access**: read, read & write, or write only in listed folders.
  A grant adds the user's CouchDB account to the vault database's `_security` members,
  so Obsidian can sync it, and lets the user's MCP tokens reach it.
- **Registry** (`mcp_registry` database) stores vaults, users, grants and token hashes.
  Secrets that must be recoverable are sealed: vault passphrases with `REGISTRY_KEY`,
  users' CouchDB passwords (for Setup URIs) with the admin-only `CREDENTIALS_KEY`, so a
  compromised MCP server cannot recover them. The MCP server follows the registry's
  `_changes` feed, so new vaults, grants and revocations apply without a restart.

The same image runs in two roles:

| Role | Does | CouchDB identity | Exposure |
|---|---|---|---|
| `admin` | Web UI, provisioning (databases, accounts, `_security`) | server admin | loopback / private network only |
| `mcp` | MCP endpoint `/mcp` | `mcp-service` (member of each vault db, read-only on the registry) | public via TLS proxy |

MCP reads and writes CouchDB with [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) —
the library that powers the plugin — for proper chunk handling and E2E encryption.

---

## Run it

- **Local test:** [`deploy/local-test/`](deploy/local-test/README.md) — CouchDB + admin + MCP on localhost.
- **Team server:** [`deploy/team/`](deploy/team/docker-compose.yml) — same, behind Caddy with Let's Encrypt.

Then, in the admin UI:

1. **Create a vault.** Id (`team-notes` → database `vault-team-notes`), display name, the
   Obsidian vault name used for deep links, and optionally an E2E passphrase (fixed at creation).
2. **Create a user.** The generated CouchDB password is shown once (it is also stored sealed so
   Setup URIs can be issued later).
3. **Grant vaults** on the user page.
4. **Setup URI** per granted vault, with a random 128-bit URI passphrase. Send the URI and the
   passphrase over separate channels: the URI holds the user's CouchDB password and the vault's
   E2E passphrase. The user imports it in Obsidian (empty vault → Self-hosted LiveSync →
   "Use the copied setup URI" → *Fetch from remote*).
5. **Issue an MCP token**, for all granted vaults or scoped to one → the page shows the token and a ready `claude mcp add` command;
   the server is named `obsidian-<host>-vaults` after `PUBLIC_MCP_URL`'s host.

---

## Tools

Every tool except `list_vaults` takes an optional `vault` argument. It is required when the
caller has access to more than one vault; the error lists the choices.

| Tool | Description |
|---|---|
| `list_vaults` | Vaults you can access, with your access level in each |
| `read_note` | Read a note, text file or image (png/jpg/gif/webp, returned as an image, ≤3.75 MB). A bare name like `diagram.png` or `Meeting` resolves like an Obsidian link |
| `read_notes` | Read up to 20 notes in one call; missing ones are flagged inline, images are left to `read_note` |
| `search_notes` | Full-text search over paths and contents (every word must match), with snippets; attachments match by file name |
| `write_note` | Create or overwrite a note (replaces entire content) |
| `edit_note` | Edit a note without rewriting it — append, prepend (after frontmatter), or replace exact text |
| `list_folders` | List all folders in the vault with note and attachment counts |
| `list_tags` | List all tags in the vault with counts |
| `list_notes` | List notes with timestamps. Filter by folder, name, tag, or date. Sort by name or modified. `include_attachments` adds attachments with their size |
| `delete_note` | Delete a note |
| `move_note` | Move or rename a note — both ends must be writable; never overwrites an existing note |
| `get_note_metadata` | Frontmatter, tags, outgoing links, backlinks, size, and timestamps; for an attachment, the notes that embed it |

Every response includes an [Obsidian deep link](https://help.obsidian.md/Extending+Obsidian/Obsidian+URI)
built from the vault's *Obsidian vault name*.

---

## Connect an AI client

```bash
claude mcp add --transport http obsidian-vault-example-com-vaults https://vault.example.com/mcp \
  --header "Authorization: Bearer osm_..."
```

**One vault as its own MCP server.** Append `?vault=<id>` to the URL and the connection sees only
that vault — handy for project knowledge in a coding session. Run it inside the project; Claude Code's
default `local` scope keeps it to that project:

```bash
claude mcp add --transport http obsidian-vault-example-com-team-notes   "https://vault.example.com/mcp?vault=team-notes" --header "Authorization: Bearer osm_..."
```

The token page in the admin UI prints this command for every vault the user is granted. Connecting to a
vault the user can't access fails with `403`.

`?vault=` only narrows what a client sees; the same token still reaches the user's other vaults on the
plain URL. For a hard limit, pick a **scope** when issuing the token: a token issued for one vault is
pinned to it on every URL (`?vault=` for another vault → `403`). The scope is fixed for the token's life;
issue a new token to change it.

Any client that can send a bearer header over Streamable HTTP works (Claude Code, Claude Desktop
via config, Cursor, MCP Inspector). Revoking the token in the admin UI cuts access on the next request.

---

## Environment variables

| Variable | Role | Description |
|---|---|---|
| `ROLE` | both | `mcp` (default) or `admin` |
| `COUCHDB_URL` | both | CouchDB as the server reaches it, e.g. `http://couchdb:5984` |
| `MCP_SERVICE_PASSWORD` | both | Password of the `mcp-service` account (admin creates it) |
| `MCP_SERVICE_USER` | both | Default `mcp-service` |
| `REGISTRY_KEY` | both | ≥16 chars; seals vault E2E passphrases. Back it up. |
| `CREDENTIALS_KEY` | admin | ≥16 chars, ≠ `REGISTRY_KEY`; seals users' CouchDB passwords, so the MCP role can't recover them. Back it up. |
| `REGISTRY_DB` | both | Default `mcp_registry` |
| `PORT` / `HOST` | both | mcp: `8787` / `0.0.0.0`; admin: `8788` / `127.0.0.1` |
| `AUDIT_LOG` / `AUDIT_LOG_FILE` | both | Audit on by default (stdout); `off` disables; file gets a 0600 copy |
| `COUCHDB_ADMIN_USER` / `COUCHDB_ADMIN_PASSWORD` | admin | CouchDB server admin |
| `ADMIN_TOKEN` | admin | ≥16 chars; admin UI login |
| `PUBLIC_COUCHDB_URL` | admin | CouchDB URL for Obsidian clients, put into Setup URIs |
| `PUBLIC_MCP_URL` | admin | MCP URL shown in the client config snippet |
| `DATA_DIR` | mcp | Search-index cache (note text included), one folder per vault id; encrypted for E2EE vaults |
| `MCP_INSTRUCTIONS` / `MCP_INSTRUCTIONS_FILE` | mcp | Extra instructions appended to the server's MCP instructions |
| `LOG_LEVEL` | both | `debug` for library and tool-call logs |

---

## Audit log

One JSON line per tool call (`evt: "tool_call"`: vault, actor email, tool, outcome
`ok|denied|error`, duration, redacted params — never note bodies) and per admin action
(`evt: "admin"`: action and target). Paths still reveal vault structure, so treat the log
as confidential.

---

## Known limitations

- **Read-only is MCP-only.** CouchDB has no read-only member role: anyone granted a vault can
  write to it through LiveSync. Read and folder grants restrict MCP tools only.
- **Shared E2E passphrase.** One passphrase per vault, known to every member's devices and to the
  server. Removing a user does not rotate it.
- **One Obsidian vault name per vault.** Deep links break for users who name their local vault differently.
- **One shared admin token.** The admin audit log cannot tell admins apart, and the login has no
  rate limit — keep the admin UI on loopback.
- **Bearer tokens only.** Clients that require OAuth (claude.ai web/mobile custom connectors) are not supported.
- **No conflict resolution.** If an agent and Obsidian edit the same note simultaneously, last write wins.
- **Search is substring-based.** No stemming or ranking beyond match counts; each query scans the
  vault's notes in memory. For unencrypted vaults the index file in `DATA_DIR` holds note text in plain form.
- **Moves don't update links.** `[[links]]` in other notes keep pointing at the old path.
- **Attachments are read-only.** They can be listed and found by name, and images read with `read_note`;
  other binary files (PDF, audio) cannot be read, and writing or moving attachments is not supported.
- **Node 22+ required.**

---

## Safety

Agents can modify and delete notes. Keep CouchDB backups and use tool approval deliberately.
Expose only the MCP endpoint and CouchDB, both over HTTPS; keep the admin UI on loopback or a VPN.
The team `Caddyfile` blocks Fauxton (`/_utils`) and CouchDB's server-admin API (`/_node`, `/_config`,
…) on the public CouchDB host, since CouchDB has no login lockout; reach them through an SSH tunnel.

This software is provided as-is under the [MIT license](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

---

## Development

```bash
git clone --recursive https://github.com/es617/obsidian-sync-mcp.git
cd obsidian-sync-mcp
npm install && npm run build
npm test              # unit tests
npm run test:couchdb  # obfuscation e2e against a throwaway CouchDB
```

---

## License

MIT — see [LICENSE](https://github.com/es617/obsidian-sync-mcp/blob/main/LICENSE).

## Acknowledgements

- [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync) by vrtmrz — the Obsidian plugin and CouchDB sync protocol
- [livesync-commonlib](https://github.com/vrtmrz/livesync-commonlib) by vrtmrz — the shared library for reading/writing the LiveSync document format
- [FastMCP](https://github.com/punkpeye/fastmcp) — TypeScript MCP framework
- [CouchDB](https://couchdb.apache.org/) — document database
