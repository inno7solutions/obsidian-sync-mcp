# Security

This document describes the security posture of obsidian-sync-mcp.

---

## Authentication

### Password-gated OAuth 2.1

The server implements a self-contained OAuth 2.1 authorization server with PKCE. No third-party identity provider (Google, GitHub, etc.) is required. Users set a password via `MCP_AUTH_TOKEN` and enter it once when an agent connects.

- **OAuth 2.1 with PKCE (S256)** — authorization code flow with Proof Key for Code Exchange. Only S256 is accepted; plain PKCE and missing challenges are rejected.
- **Dynamic Client Registration (RFC 7591)** — agents register themselves automatically. No manual client setup.
- **Access tokens** expire after 1 hour. Agents refresh transparently — users don't re-enter the password.
- **Refresh tokens** expire after 14 days of inactivity (configurable via `MCP_REFRESH_DAYS`). After expiry, the user must re-authenticate.
- **Refresh token rotation** — each refresh issues a new refresh token and invalidates the old one. If a token is leaked and both parties try to refresh, the first one wins and the leaked token becomes invalid.
- **No auth mode** — when `MCP_AUTH_TOKEN` is not set, the server runs without authentication. Intended for local testing or use behind a private network.
- **Browser-attack protection (no auth mode)** — with no token, the server validates both the HTTP `Host` and `Origin` headers and rejects any request whose host/origin is not `localhost`/`127.0.0.1`/`::1` (extend with `MCP_ALLOWED_HOSTS`, comma-separated). The `Host` check blocks DNS rebinding (CWE-350) — a loopback bind alone does **not** stop this, since the browser sends the attacker's hostname in `Host`. The `Origin` check blocks the simpler variant where a page directly fetches `http://127.0.0.1:<port>/mcp`: that request has a genuine loopback `Host` but carries a cross-origin `Origin`, and the transport's wildcard CORS would otherwise expose the response. Non-browser MCP clients (CLI, desktop apps) send no `Origin`, so they are unaffected. These checks block *browser*-delivered attacks only: a direct non-browser network client can still forge both headers, so on an untrusted network set `MCP_AUTH_TOKEN`. When a token is set, no host/origin check is needed — a bearer token is not attached by browsers.

### Identity-provider OAuth (team mode)

Setting `IDP_PROVIDER` replaces the shared password with OAuth against an
external identity provider (Entra ID, Google, or any OIDC provider). The server
runs an OAuth proxy: to MCP clients it is a standards-compliant authorization
server with dynamic client registration, while the actual login is delegated
upstream. Mutually exclusive with `MCP_AUTH_TOKEN` — setting both is a fatal
startup error, because both serve `/oauth/*`.

- **Identity per caller** — `sub`, `email`, `name` and group/role claims are read
  from the OIDC ID token and attached to the session. The ID token is decoded
  without signature verification, which is sound only because it never passes
  through the caller: the client holds a server-issued token, and the ID token is
  read from server-side storage having arrived over TLS from the IdP's token
  endpoint. Disabling fastmcp's token swap would invalidate that reasoning.
- **Access gate** — `IDP_REQUIRED_GROUPS` (any-of) and `IDP_ALLOWED_DOMAINS`
  (email domain) are enforced on every authentication, and denials are logged
  with the subject and reason. With neither set, any account the IdP will issue a
  token for has full vault access; the server warns about this at startup.
- **Token issuer and audience are `BASE_URL`** — tokens minted by one instance are
  rejected by another with a different `BASE_URL`, so separate vaults on separate
  hostnames cannot borrow each other's sessions.
- **Session keys are derived from `IDP_CLIENT_SECRET`** unless
  `IDP_JWT_SIGNING_KEY` / `IDP_ENCRYPTION_KEY` are set. This is deliberate:
  auto-generated keys would rotate on every restart, invalidating all sessions
  and the persisted token store. Rotating the client secret intentionally ends
  every session.
- **Persisted token store** — OAuth state is written to `DATA_DIR/oauth-store.json`
  with `0600` permissions, so restarts and deploys do not log the team out. The
  values are encrypted by fastmcp's storage layer before they reach the file.
- **The IdP client credentials are retrievable** — `/oauth/register` answers any
  caller with the upstream `client_id` and `client_secret`, which is how the
  proxy serves clients that expect dynamic registration. Use a dedicated app
  registration with no permissions beyond `openid`/`profile`/`email` and no
  client-credentials grant, and treat the secret as exposed to anyone who can
  reach the port.
- **Redirect URIs are not restricted by this server** —
  `IDP_ALLOWED_REDIRECT_URIS` can only add patterns; the underlying check falls
  back to accepting any HTTPS or loopback URI when no pattern matches. Keep the
  redirect URI allowlist in the IdP tight, since that is the boundary that holds.

### Per-user authorization (team mode)

With `IDP_PROVIDER` set, `POLICY` maps each caller's group/role claims to what
they may write. It is enforced two ways at once:

- **Tool visibility** — a caller who can write nothing does not see the write
  tools at all. fastmcp evaluates `canAccess` when the session is created and
  filters the tool set, so a hidden tool answers `MethodNotFound`, not a refusal.
  This is genuine enforcement, not cosmetic hiding. Because it is evaluated per
  session, a policy change takes effect for a caller only on their next session
  (bounded by the access-token lifetime).
- **Per-path check** — every write additionally re-checks the caller's folder
  scope at call time (`isWritable`), so folder scoping does not depend on the
  tool having been hidden.

Two safety properties hold by construction:

- **Default deny.** A configured policy with no rule matching the caller yields
  read-only. Writing requires a rule that grants it.
- **The ceiling only removes access.** Effective write scope is the intersection
  of the caller's policy and the process-wide `READ_ONLY` / `WRITE_FOLDERS`
  ceiling, so a locked-down container stays locked down regardless of policy.
  With no `POLICY` set, every authenticated caller gets the ceiling directly —
  the pre-existing behavior.

Group membership is read from the ID token claims named by `IDP_GROUPS_CLAIM`.
Reads are **not** scoped: every authenticated caller can read the whole vault
(see the vault-isolation note under Known limitations).

### Audit logging

Every tool call emits one structured JSON line (`AUDIT_LOG`, on by default) to
stdout, and optionally to a `0600` file (`AUDIT_LOG_FILE`). It records the actor
(email or subject id in IdP mode, `anonymous` otherwise), the tool, the outcome
(`ok` / `denied` / `error`), timing, and session/request ids. `delete_note` and
`move_note` are flagged `destructive`.

- **Redaction is by allowlist.** Only known-safe argument keys are logged; note
  bodies (`content`, `old_text`) are recorded as byte lengths, never text, so a
  future tool parameter cannot leak content by default.
- **Paths are logged and are sensitive.** In an E2E vault the paths alone reveal
  its structure, so the audit stream is confidential and should be access-
  controlled like the vault itself.
- **Auditing cannot break a tool call.** A failing sink is caught and logged, not
  propagated.
- **It is emitted from the tool wrapper, not fastmcp's `onToolCall`**, because
  that hook does not receive the caller identity.

### Brute-force protection

- **Rate limiting with exponential backoff** — after 5 failed password attempts, the server locks out for 5 seconds. Each subsequent lockout doubles: 10s, 20s, 40s, 80s, and so on.
- **No counter reset on lockout** — the failed attempt counter persists across lockouts. Only a successful login resets it.
- **All failed attempts are logged** with attempt count for monitoring.

### Token security

- **Timing-safe comparison** — both password and CSRF token comparisons use `crypto.timingSafeEqual` to prevent timing side-channel attacks.
- **CSRF protection** — the OAuth approval form includes a per-request CSRF token. Submissions without a valid token are rejected.
- **Redirect URI validation** — the `/oauth/authorize` endpoint validates that the `redirect_uri` matches what the client registered, preventing authorization code theft via open redirect.
- **Token persistence** — OAuth tokens are persisted to disk on clean shutdown (and every 5 minutes) and loaded on restart, so sessions survive server restarts and deploys. Files are stored in `DATA_DIR/<vault-hash>/` with `0600` permissions (owner-only). Defaults to `~/.obsidian-mcp/` locally, or the persistent volume on Fly.io. Each vault gets an isolated subdirectory.

---

## CouchDB

### Access control

- **`require_valid_user = true`** on both `[chttpd]` and `[chttpd_auth]` — every CouchDB request requires valid credentials, including the admin UI (`/_utils`).
- **Separate credentials** — CouchDB credentials (for LiveSync sync) and the MCP auth token (for agent access) are independent. Rotating one doesn't affect the other.
- **Least-privilege LiveSync user (recommended)** — set `LIVESYNC_USER` and `LIVESYNC_PASSWORD` to create a non-admin CouchDB user restricted to the vault database only. If LiveSync credentials are compromised, the attacker cannot access CouchDB admin functions (delete databases, change config, create users). Without this, LiveSync uses the admin account.
- **Credentials from environment** — CouchDB admin password is set via `COUCHDB_PASSWORD` environment variable, never hardcoded. Docker Compose refuses to start without it.

### Network

- **TLS via Fly.io** — both the MCP server (port 8787) and CouchDB (port 5984) are served through Fly.io's TLS proxy. No plaintext traffic on the public internet.
- **HTTPS warning** — when `MCP_AUTH_TOKEN` is set and `BASE_URL` doesn't start with `https://` (and isn't localhost), the server logs a warning at startup.
- **CORS restricted** — CouchDB CORS is limited to Obsidian app origins (`app://obsidian.md`, `capacitor://localhost`).

---

## Filesystem (local mode)

- **Path traversal prevention** — all file operations resolve the full path and verify it stays within the vault root directory. Attempts to access `../` or absolute paths outside the vault throw an error before any I/O occurs.
- **Symlink resolution** — `fs.realpath()` resolves symlinks before the path check. A symlink inside the vault pointing to `/etc/passwd` is caught because the resolved path falls outside the vault root.

---

## Data handling

- **E2E encryption supported** — when `COUCHDB_PASSPHRASE` is set, the server decrypts and encrypts vault data using the same scheme as Self-hosted LiveSync. Data is encrypted at rest in CouchDB.
- **Text only** — binary attachments are not exposed through MCP tools, reducing the attack surface.
- **Search result cap** — search results are limited to 50 matches, preventing large responses from exhausting memory or leaking excessive content.
- **Search index encryption** — the persisted search metadata (paths and timestamps) is encrypted at rest using `COUCHDB_PASSPHRASE` when set. Note content is not persisted — only the FlexSearch tokenized index lives in memory (lost on full restart, rebuilt from vault). Content snippets are fetched on demand from the vault, not cached.

---

## Graceful shutdown

- The server handles `SIGTERM` and `SIGINT` signals, cleanly closing the CouchDB connection before exiting. Prevents data corruption on container stop.

---

## Reporting vulnerabilities

If you find a security issue, please open a GitHub issue or email the maintainer directly. Do not open a public issue for critical vulnerabilities — use private disclosure.
