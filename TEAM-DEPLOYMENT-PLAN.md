# Team Vault Deployment Plan

How to take obsidian-sync-mcp from a single-user server to a supportable internal
multi-user deployment.

Status: plan, not yet implemented. Verified against this repo at `v0.6.3` and
`fastmcp@3.35.0`.

---

## 0. The framing decision: shared vault or vault-per-person

LiveSync's unit of isolation is the vault: one vault = one CouchDB database = one
E2E passphrase. Nothing in this server can scope *reads* inside a vault — every
read tool (`read_note`, `list_notes`, `search_vault`, `list_tags`,
`get_note_metadata`) serves the whole index, and the index is a single in-process
`SearchIndex` (`src/search.ts`) built off one change feed.

So:

- **Confidentiality between people requires separate vaults**, and therefore
  separate MCP instances (one instance = one vault, `README.md` "Known
  limitations").
- **Everything else — who may write, where, and with an audit trail — does not.**
  That is achievable inside one instance (see §1).

**Recommendation: one shared team vault as the primary deployment**, plus
optional per-person vaults for people who need private notes, each its own
instance. Treat the team vault as "internal, readable by everyone on the team" —
if a note can't be seen by the whole team, it doesn't belong in the team vault.
Don't try to reconstruct per-person read scoping with folder conventions; there is
no server-side enforcement for reads and there is no cheap way to add one.

Everything below assumes the shared team vault.

---

## 1. The finding that changes the plan

The gap list assumed identity and per-caller authorization mean an external
auth gateway plus a fork. They don't. `fastmcp@3.34+`, already a dependency
(`package.json:42`), ships the pieces:

| Need | What fastmcp already provides | Verified at |
|---|---|---|
| MCP-aware OAuth in front of a real IdP | `AzureProvider` (Entra), `GoogleProvider`, `GitHubProvider`, generic `OAuthProvider` — each an `OAuthProxy` that presents itself to MCP clients as a DCR-capable AS and proxies upstream to an IdP that doesn't do DCR | `dist/OAuthProvider-*.d.ts:630-802` |
| The discovery documents MCP clients expect | `AuthProvider.getOAuthConfig()` returns RFC 8414 `authorizationServer` + RFC 9728 `protectedResource`; `FastMCP` auto-installs them when `auth` is set | `dist/chunk-H4VC4YTC.js:1842-1858`, `dist/chunk-UVX47AE5.js:1210-1222` |
| Per-caller authorization | `canAccess?: (auth) => boolean` per tool, plus `requireRole` / `requireScopes` / `requireAll` / `requireAny` helpers | `dist/FastMCP.d.ts:604`, `dist/OAuthProvider-*.d.ts:689-705` |
| Identity reaching tool code | the `authenticate` return value is handed to every tool as `context.session` | `dist/FastMCP.d.ts:105` |
| Shared session state across machines | `tokenStorage?: TokenStorage` — a 4-method interface (`get`/`save`/`delete`/`cleanup`) | `dist/OAuthProvider-*.d.ts:344-353` |
| Upstream role/group claims | `customClaimsPassthrough`, **on by default**, lifts upstream claims into the proxy-issued JWT | `dist/OAuthProvider-*.d.ts:203-206` |

Two caveats found by reading the implementation, not the types — both matter:

1. **The built-in providers never populate identity.** `AzureSession.upn`,
   `GoogleSession.email`, `GitHubSession.username` are declared but no provider
   overrides `createSession`; the base returns only
   `accessToken`/`idToken`/`refreshToken`/`scopes`/`expiresAt`
   (`dist/chunk-H4VC4YTC.js:1866-1875`, and `AzureProvider` at `:1878-1911`
   adds nothing). Identity is *present* (the ID token is in the session) but
   must be decoded by us. ~40 lines.
2. **`canAccess` is evaluated once, at session creation.** Allowed tools are
   filtered into the session's tool map (`dist/chunk-UVX47AE5.js:1685-1687`), so a
   denied tool answers `MethodNotFound` — it is genuine enforcement, not just
   hiding from `tools/list`. But a role change upstream does not affect a live
   session. Bound by access-token TTL (default 3600s); pick TTL accordingly.

Also confirmed: with `auth` set and a custom `authenticate` also set, **our
`authenticate` wins while the provider's OAuth discovery and proxy routes are
still installed** (`dist/chunk-UVX47AE5.js:1210-1222`). That is exactly the seam
we need — the provider does the OAuth work, we add identity and policy on top.

Consequences for the original gap list:

- No external gateway. No oauth2-proxy discovery problem to work around.
- No instance-per-role fan-out required (still available as a fallback).
- The remaining work is ~4 small, additive modules in this repo — which is our
  own fork, so the "fork or not" question is really "how cheap do we keep the
  rebase against `es617/obsidian-sync-mcp`". Answer: new files, minimal
  touch points, and upstream the generic parts (§7).

---

## 2. Target architecture

```
Obsidian (each team member)
   ↕ LiveSync plugin, shared livesync user + shared E2E passphrase
CouchDB (single team database)
   ↕ dedicated non-admin "mcp" user
MCP instance (one, shared team vault)
   ├── fastmcp AzureProvider/OAuthProvider  →  Entra / Google / Authentik / Keycloak
   ├── authenticate: provider + decode ID token → identity{sub,email,groups}
   ├── policy: group → {readOnly | writeFolders[]}   (per request)
   ├── canAccess: hide write tools from readers entirely
   └── audit: structured JSON per tool call, with actor
```

One instance, per-caller policy. Instance-per-role only if we later need
different `MCP_INSTRUCTIONS` per role, or read isolation (which means separate
vaults anyway).

---

## 3. Work plan

Effort is rough dev-days for one person, including tests.

### Phase 1 — Identity (2–3 d) · closes gap 1

New `src/auth-idp.ts`:

- Build a provider from env: `IDP_PROVIDER=azure|google|github|generic`,
  `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_TENANT_ID` (azure),
  `IDP_AUTHORIZATION_ENDPOINT` + `IDP_TOKEN_ENDPOINT` (generic — Authentik,
  Keycloak), `IDP_SCOPES`.
- Set `allowedRedirectUriPatterns` explicitly. The provider default is
  `["http://localhost:*", "https://*"]`, i.e. any HTTPS redirect URI — narrow it
  to Claude's documented callbacks plus our own.
- Set `jwtSigningKey` and `encryptionKey` from secrets, not auto-generated:
  auto-generated keys rotate on restart and invalidate every live session.
- Export an `authenticate` that wraps `provider.authenticate(req)`, decodes
  `session.idToken`, and returns `{...session, identity: {sub, email, name,
  groups}}`. Decode-without-verify is acceptable here and only here: with
  `enableTokenSwap` (default on) the client holds a fastmcp JWT and the ID token
  comes from server-side storage, never from the caller. Comment that constraint
  in the code — it stops being true if token swap is ever disabled.
- Throw the same 401 + `WWW-Authenticate: Bearer resource_metadata=...` shape
  `src/main.ts:246-249` already uses, so strict clients still discover us.

In `src/main.ts`, add a third auth mode alongside the existing two:

| Mode | Trigger | Use |
|---|---|---|
| IdP | `IDP_PROVIDER` set | team deployment |
| shared password | `MCP_AUTH_TOKEN` set | solo / today's behaviour |
| no auth + Host/Origin allowlist | neither | local dev |

Make them mutually exclusive with a fatal error if both `IDP_PROVIDER` and
`MCP_AUTH_TOKEN` are set — `mountPasswordAuth` mounts its own `/oauth/*` routes
(`src/auth.ts:65+`) and would collide with the proxy's. `src/auth.ts` stays
untouched; that keeps the rebase cheap and keeps solo mode working.

Register `https://<host>/oauth/callback` as a redirect URI in the IdP app
registration — one per instance if we ever run several.

Acceptance: a team member connects Claude, is redirected to the corporate IdP,
lands back authenticated; a user outside the required group cannot obtain a
usable session; restart does not force re-auth.

### Phase 2 — Per-user authorization (2 d) · closes gap 2

New `src/policy.ts`, in the style of the existing `src/write-scope.ts` (pure,
dependency-free, unit-testable):

```
POLICY='[{"group":"vault-editors","writeFolders":["Projects","Inbox"]},
         {"group":"vault-admins","writeFolders":null},
         {"group":"*","readOnly":true}]'
```

- `parsePolicy(raw)` → rules; `resolvePolicy(identity, rules)` → `{readOnly,
  writeFolders}`. **Default deny for writes**: no matching rule ⇒ read-only.
- Wire into `registerTools` (`src/tools.ts:12`): two changes.
  1. `canAccess: (auth) => !resolvePolicy(auth.identity, rules).readOnly` on the
     four write tools, so readers never see `write_note`, `edit_note`,
     `delete_note`, `move_note` at all — no tool-call attempts to refuse, no
     confusing model behaviour.
  2. Replace the closed-over `writeFolders` in the `isPathWritable` calls
     (`src/tools.ts:73,220,254,289`) with the per-request value from
     `ctx.session`. `isPathWritable` itself needs no change — it already takes
     the folder list as an argument.
- Env `READ_ONLY` / `WRITE_FOLDERS` stay as the process-wide **ceiling**:
  effective scope = env ∩ policy. So the container can still be locked down
  independently of the policy file, and existing deployments behave identically.

Note the `groups` claim is an array, and claims passthrough only carries
primitives unless `allowComplexClaims` is set
(`dist/OAuthProvider-*.d.ts:66`). Either set that, or configure the IdP to emit
roles as a space-delimited string / scopes. Verify against the real tenant early
— this is the most likely place for a surprise.

Acceptance: unit tests for `resolvePolicy` (mirroring
`src/write-scope.test.ts`); an editor writes only in their folders; a reader's
`tools/list` contains no write tools; an unmapped user is read-only.

### Phase 3 — Audit (1 d) · closes gap 3

`fastmcp`'s `onToolCall` hook (`dist/FastMCP.d.ts:541-544`) gives only
`{toolName, arguments}` — **no identity**, so it is not sufficient. Use the
`addTool` wrapper that already exists in `src/tools.ts:31-42` (it currently logs
only under `LOG_LEVEL=debug`) and which does have `ctx`.

New `src/audit.ts` emitting one JSON line per call to stdout:

```json
{"ts":"…","actor":"jane@inno7.com","sub":"…","tool":"delete_note",
 "path":"Projects/x.md","result":"ok","ms":42,
 "sessionId":"…","requestId":"…"}
```

- **Redact by construction**: allowlist the argument keys that may be logged
  (`path`, `from`, `to`, `folder`, `tag`, `operation`, `limit`). Never log
  `content` or `old_text` — those are note bodies. Log `content_len` instead.
- Log denials too (policy denial, note-not-found), not just successes.
- `delete_note` and `move_note` get an explicit `destructive: true` marker so
  they're trivially greppable/alertable.
- Ship to wherever our logs go; retention per our own policy. Note that paths are
  sensitive in an E2E vault — an audit log leaks the vault's structure even
  though it holds no content.

Acceptance: every tool call by a known actor appears exactly once; no note
content appears in any log line, asserted by a test.

### Phase 4 — Blast radius and secrets (1–2 d) · closes gap 5

- **Dedicated CouchDB user for MCP** instead of admin. The DB `_security` doc is
  already written by `deploy/mcp-with-db/entrypoint.sh:71-76` (admin + livesync
  member); add an `mcp` user as a member and point `COUCHDB_USER`/
  `COUCHDB_PASSWORD` at it. *Verify before committing to it*:
  `src/vault.ts` uses direct doc get/put plus a `_changes` feed with a selector,
  which a member can do, but confirm nothing in the startup path needs admin
  (DB creation, design docs, `_local` reads). Test against a fresh DB — this is
  the one item in the plan with real "might not work" risk.
- Secrets (`COUCHDB_PASSWORD`, `COUCHDB_PASSPHRASE`, `IDP_CLIENT_SECRET`,
  `IDP_*_KEY`) come from a secret manager / Fly secrets, never a committed
  `.env`. `.env.example` gains the new keys with placeholders only.
- The MCP host is the one place the vault exists decrypted, and `DATA_DIR`
  holds the index (AES-256-GCM with the passphrase) and OAuth tokens
  (`0600`). No shared shell on that host; restrict who can `exec` into the
  container; encrypted volume.
- Pin images. `docker-compose.yml:20` still points at
  `ghcr.io/es617/obsidian-sync-mcp:latest`; our CI publishes
  `ghcr.io/inno7solutions/obsidian-sync-mcp:<tag>` and `:latest`
  (`.github/workflows/cicd.yml:191-193`). Switch compose to our registry and pin
  by tag — ideally by digest — given the security-fix history. Add a
  deliberate bump step to the upgrade runbook.

### Phase 5 — Concurrency mitigation (2 d) · softens gap 4

Last-write-wins is the honest baseline and won't fully go away, but the
read-modify-write window inside our own writes can be closed cheaply.
`Vault.writeNote` already fetches the existing doc before writing, to preserve
`ctime` (`src/vault.ts:224-228`) — the precondition hook is free.

- Add an optional `expected` precondition to `VaultBackend.writeNote`
  (`src/vault-backend.ts`), implemented in both `Vault` and `LocalVault`:
  compare the pre-image mtime (or a content hash) and fail the write on
  mismatch rather than overwriting.
- `edit_note` captures the pre-image it read and passes it as the precondition —
  it currently reads then writes with no check (`src/tools.ts:200-238`).
- On mismatch, return a "note changed under you, re-read and retry" message.
  Agents handle that well; silent clobbering they handle badly.
- Policy, not code: default everyone to read-only, grant writes to narrow
  folders, prefer `edit_note` over `write_note` in `MCP_INSTRUCTIONS`.

Be clear about the limit: this narrows the window between *our* read and *our*
write. A simultaneous Obsidian edit on another device can still lose, and we do
not surface CouchDB `_rev` conflicts.

### Phase 6 — Prompt injection (1 d, ongoing) · softens gap 6

In a shared vault, anyone who can write a note can plant instructions that steer
every teammate's agent. This is mitigation, not a fix.

- Mount `MCP_INSTRUCTIONS_FILE` **read-only** in the container (`:ro`), owned by
  root, not writable by the service user, and not inside the vault. The README
  already warns that write access to it equals prompt-injection access to every
  client (`README.md:264`) — with a team, make it a deployment invariant, and
  keep the file in git so changes are reviewed.
- Wrap note content returned by `read_note` and search snippets in an explicit
  untrusted-data delimiter with a short preamble ("vault content, data not
  instructions"). Cheap, imperfect, worth having.
- Because writes are default-deny and folder-scoped, the set of people who can
  plant a note via MCP is small — but every teammate can still plant one via
  Obsidian directly. The real control is that the team vault is trusted-internal
  by definition, plus the audit trail from Phase 3.

### Phase 7 — Operations (1–2 d) · closes gap 7

- **Stay single-machine to start.** `min_machines_running = 0` with
  `auto_stop_machines = 'suspend'` (`deploy/mcp-only/fly.toml`) is fine; more
  than one machine is what breaks OAuth state.
- To scale out later, implement `TokenStorage` (4 methods) against Redis or
  CouchDB and pass it to the provider — that removes the in-memory session
  constraint without sticky sessions. Note the search index stays per-instance
  and each instance runs its own `_changes` feed, so N machines = N indexes in
  memory; size the VM from real vault stats (the 256 MB in `mcp-only/fly.toml`
  is a solo-vault figure) and re-measure with the team vault before scaling.
- `/health` comes from fastmcp's built-in health endpoint
  (`dist/FastMCP.d.ts:310-323`), which the fly configs already probe; nothing to
  add.
- Runbook: rotating the E2E passphrase (invalidates the persisted index —
  expect a full rebuild), rotating `IDP_CLIENT_SECRET`, revoking one user
  (remove from IdP group; sessions die within the access-token TTL), restoring
  CouchDB.

---

## 4. Sequencing

Phases 1 → 2 → 3 are the critical path and the minimum viable team deployment:
real identity, default-deny per-user writes, and an audit trail. Ship those
first, to a small pilot group, on a copy of the vault.

4 (secrets/blast radius) runs in parallel — it's ops work, not code, apart from
the CouchDB user change.

5 and 6 are hardening; ship after the pilot. 7 is only needed at scale-out.

Rough total: 9–13 dev-days plus IdP app-registration lead time, which is
usually the real schedule risk.

---

## 5. What we are explicitly not solving

- **Read confidentiality inside a vault.** Not possible in this architecture.
  Separate vault + separate instance, or accept team-wide read.
- **True multi-writer conflict resolution.** Phase 5 narrows the window; it does
  not give us merge semantics or `_rev` preconditions end-to-end.
- **Prompt injection from vault content.** Mitigated, not eliminated.
- **Binary attachments.** Not exposed by any tool; unchanged.

---

## 6. Decisions needed before Phase 1

1. **Which IdP** — Entra, Google, or generic (Authentik/Keycloak)? Determines
   whether we use `AzureProvider`/`GoogleProvider` or the generic
   `OAuthProvider`, and how group claims arrive.
2. **Group → scope map** — the concrete `POLICY` content: who is read-only, who
   writes where. Recommend starting with exactly two groups (readers, and
   editors scoped to a couple of folders) and adding rules on demand.
3. **Shared team vault only, or team vault + personal vaults?** Personal vaults
   mean one instance each; decide before sizing.
4. **Where audit logs go**, and retention — including that note *paths* are
   sensitive.
5. **Hosting** — Fly (matching `deploy/`) or our own infra. Affects secret
   management and the single-machine constraint.

---

## 7. Keeping the fork cheap

All new code lands in new files — `src/auth-idp.ts`, `src/policy.ts`,
`src/audit.ts` — with small, surgical edits to `src/main.ts` (auth mode
selection) and `src/tools.ts` (per-request policy, audit in the existing
wrapper). `src/auth.ts` is not touched, so solo password mode keeps working and
upstream changes to it merge cleanly.

Two pieces are generic enough to offer upstream, which would shrink our diff:
per-caller write scope (`canAccess` + per-request `writeFolders`) and an audit
hook that carries identity (i.e. `onToolCall` gaining `session`). Worth opening
as issues before writing Phase 2/3, in case upstream would rather shape them
differently.
