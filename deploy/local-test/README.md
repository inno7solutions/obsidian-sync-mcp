# Local test stack

CouchDB + admin UI + MCP server built from this branch, all on localhost, no TLS.

| Service | URL | Login |
|---|---|---|
| Admin UI | http://localhost:8788 | `ADMIN_TOKEN` |
| MCP | http://localhost:8787/mcp | per-user token from the admin UI |
| CouchDB | http://localhost:5984 (Fauxton: `/_utils`) | `COUCHDB_ADMIN_*` or a user's account |

All ports bind to `127.0.0.1` only.

## Run

```sh
# once, from the repo root (Docker Desktop running)
git submodule update --init --recursive
cp deploy/local-test/.env.example deploy/local-test/.env   # fill in secrets

# every change
npm run build
docker compose -f deploy/local-test/docker-compose.yml --env-file deploy/local-test/.env up --build -d
docker compose -f deploy/local-test/docker-compose.yml logs -f admin mcp
```

`mcp` may log `Registry load failed … 401` once at first start: it waits for `admin` to
create the registry and the `mcp-service` account, then retries.

## Walkthrough

1. Admin UI → **New vault** (e.g. id `test`, Obsidian vault name = the name you'll give the vault in Obsidian).
2. **New user** → note the CouchDB password (shown once).
3. User page → grant `test` → **Setup URI**.
4. Obsidian: create an **empty** vault with the name from step 1 → install *Self-hosted LiveSync* →
   copy the URI → *Use the copied setup URI* → enter the URI passphrase → **Fetch from remote**.
5. User page → **Issue token** → run the shown `claude mcp add …` command (or use the MCP Inspector:
   `npx @modelcontextprotocol/inspector`, transport *Streamable HTTP*, header `Authorization: Bearer <token>`).
6. Ask the agent to `list_vaults` and write a note; it appears in Obsidian within seconds.

## Smoke test with curl

MCP over HTTP needs an `initialize` handshake; a bare `tools/list` returns `No valid session ID provided`.

```sh
TOKEN=osm_...   # from the admin UI
SID=$(curl -s -D - -o /dev/null -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"1.0"}}}' \
  http://localhost:8787/mcp | grep -i mcp-session-id | awk '{print $2}' | tr -d '\r')
curl -s -H "Authorization: Bearer $TOKEN" -H "mcp-session-id: $SID" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_vaults","arguments":{}}}' \
  http://localhost:8787/mcp

# Audit trails
docker compose -f deploy/local-test/docker-compose.yml exec mcp cat /data/audit.jsonl
docker compose -f deploy/local-test/docker-compose.yml exec admin cat /data/admin-audit.jsonl
```

No token or an unknown/revoked token → `401`.

## Pitfalls

- **Never choose "Rebuild" / "Overwrite remote"** in LiveSync when the database already has notes —
  it replaces CouchDB with the local vault. A pending rebuild shows up as an empty `flag_rebuild.md`
  in the vault root; delete it before restarting Obsidian and create an empty `flag_fetch.md` instead.
- **"Remote database is newer or corrupted"** — the version marker is missing. Vaults created in the
  admin UI have it; for a database created another way:
  `curl -u admin:<pw> -X PUT -H "Content-Type: application/json" -d '{"version":12,"type":"versioninfo"}' http://localhost:5984/<db>/obsydian_livesync_version`
- If Obsidian connects but nothing syncs, the CouchDB log shows only `GET /<db>/` and no
  `_changes`/`_bulk_docs`. Check the plugin log (*Self-hosted LiveSync: Show log*) and reload Obsidian
  after a sync error — live sync may not restart on its own.
- **Read-only grants limit MCP only**; LiveSync can still write.
- Back up before experimenting:
  `curl -u admin:<pw> "http://localhost:5984/<db>/_all_docs?include_docs=true" > backup.json`
- On Windows/Git Bash, run `docker compose` from PowerShell or prefix it with `MSYS_NO_PATHCONV=1` —
  path conversion can create stray folders such as `couchdb-init.ini;C/`.

## Tear down

```sh
docker compose -f deploy/local-test/docker-compose.yml down      # keep data
docker compose -f deploy/local-test/docker-compose.yml down -v   # also wipe volumes
```
