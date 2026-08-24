# Team Vault Deployment Plan

How to take obsidian-sync-mcp from a single-user server to a supportable internal
multi-user deployment.

Status: plan, not yet implemented. Verified against this repo at `v0.6.3` and
`fastmcp@3.35.0`.

---

## The plan on one screen

```
DEPLOYMENT UNIT — repeat per vault, nothing shared between them
┌────────────────────────────────────────────────────────────────────────────┐
│  Obsidian + LiveSync                                                       │
│         │              local vault folder must be named exactly VAULT_NAME │
│         ▼              (deep links carry it)                               │
│  CouchDB   db:<vault>  1 db = 1 vault = 1 E2E salt = 1 crypto domain       │
│         │              role-based _security; no read-only role exists      │
│         ▼  member acct (not admin — admins bypass _security everywhere)    │
│  MCP instance          own origin · own BASE_URL · own keys · own DATA_DIR │
│    ├ authenticate ──►  identity {sub, email, groups}   from the ID token   │
│    ├ policy       ──►  {readOnly | writeFolders[]}     default deny        │
│    ├ canAccess    ──►  readers never see write tools                       │
│    └ audit        ──►  actor · vault · tool · path      no note content    │
│         ▲                                                                  │
│         │ OAuth 2.1 + PKCE, DCR proxied upstream by fastmcp                │
│  IdP app registration  assignment = who can read this vault                │
└────────────────────────────────────────────────────────────────────────────┘
  BASE_URL is the tenant boundary: iss/aud are checked, so one origin per vault
  private notes → not hosted at all: VAULT_PATH on the person's own machine

ROADMAP
  critical path — minimum viable team deployment, ship to a pilot group
  ┌─────────────┐    ┌─────────────────┐    ┌─────────────┐
  │ 1 IDENTITY ✓│───►│ 2 AUTHORIZATION │───►│ 3 AUDIT     │
  │ IdP, no fork│    │ policy+canAccess│    │ who did what│
  │ built       │    │ 2 d             │    │ 1 d         │
  └─────────────┘    └─────────────────┘    └─────────────┘
  ┌─────────────┐  in parallel, ops not code
  │ 4 SECRETS   │  member acct · secret manager · pinned image      1-2 d
  └─────────────┘
                   after the pilot
                   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
                   │ 5 CONCURRENCY│ │ 6 INJECTION  │ │ 7 OPS/SCALE  │
                   │ preconditions│ │ ro instrs    │ │ token store  │
                   │ 2 d          │ │ 1 d          │ │ 1-2 d        │
                   └──────────────┘ └──────────────┘ └──────────────┘
                   when vault #2 appears
                   ┌────────────────────────────────────────────────┐
                   │ 8 MULTI-VAULT  registry → dbs, users, hosts,   │
                   │ 2-3 d          redirect URIs, Setup URIs       │
                   └────────────────────────────────────────────────┘
  ≈9-13 d for one vault, +2-3 d for many · real blocker: IdP registration lead

WHAT IT BUYS
  fixed              │ mitigated only        │ not fixable here
  ───────────────────┼───────────────────────┼──────────────────────────────
  real identity      │ concurrent writes     │ read scoping inside a vault
  per-user writes    │ prompt injection      │ two vaults in one database
  audit trail        │                       │ conflict resolution / merge
```

Everything below is the reasoning and the verified detail behind this.

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
private vaults for people who need them — run locally, not hosted (§4).
Treat the team vault as "internal, readable by everyone on the team" —
if a note can't be seen by the whole team, it doesn't belong in the team vault.
Don't try to reconstruct per-person read scoping with folder conventions; there is
no server-side enforcement for reads and there is no cheap way to add one.

Sections 1-3 assume the shared team vault. §4 covers what changes when there
is more than one — which there will be, as soon as anyone needs notes the
whole team cannot read.

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
  touch points, and upstream the generic parts (§8).

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

For more than one vault, this whole block repeats per vault, one origin each —
see §4.

---

## 3. Work plan

Effort is rough dev-days for one person, including tests.

### Phase 1 — Identity (2–3 d) · closes gap 1 · DONE

Implemented in `src/auth-idp.ts` and `src/token-store.ts`, wired in
`src/main.ts`, with 44 unit tests. What the build confirmed or corrected is
marked inline below.

New `src/auth-idp.ts`:

- Build a provider from env: `IDP_PROVIDER=azure|google|github|generic`,
  `IDP_CLIENT_ID`, `IDP_CLIENT_SECRET`, `IDP_TENANT_ID` (azure),
  `IDP_AUTHORIZATION_ENDPOINT` + `IDP_TOKEN_ENDPOINT` (generic — Authentik,
  Keycloak), `IDP_SCOPES`.
- ~~Set `allowedRedirectUriPatterns` explicitly to narrow the default of any
  HTTPS URI.~~ **Corrected: this option cannot narrow anything.**
  `OAuthProxy.validateRedirectUri()` tries the configured patterns and then
  falls back to `protocol === "https:" || loopback`, so any HTTPS or loopback
  redirect URI is accepted whatever the list says — verified by registering
  `https://evil.example/cb` successfully. The list can only *widen* (custom
  schemes). The redirect URI allowlist in the IdP is the boundary that holds;
  worth reporting upstream.
- Set `jwtSigningKey` and `encryptionKey` from secrets, not auto-generated:
  auto-generated keys rotate on restart and invalidate every live session.
- Export an `authenticate` that wraps `provider.authenticate(req)`, decodes
  `session.idToken`, and returns `{...session, identity: {sub, email, name,
  groups}}`. Decode-without-verify is acceptable here and only here: with
  `enableTokenSwap` (default on) the client holds a fastmcp JWT and the ID token
  comes from server-side storage, never from the caller. Comment that constraint
  in the code — it stops being true if token swap is ever disabled.
- Throw the same 401 + `WWW-Authenticate: Bearer resource_metadata=...` shape
  `src/main.ts` already uses in password mode, so strict clients still discover
  us.
- **Added during implementation:** a file-backed `TokenStorage`
  (`src/token-store.ts`). fastmcp defaults to in-memory storage, which would log
  the whole team out on every restart and deploy — and the acceptance criterion
  below is that a restart does not force re-auth. Same 4-method contract, same
  TTL semantics, `0600` file, values already encrypted by fastmcp's storage
  layer. This is also the seam Phase 7 swaps for Redis to scale out.
- **Added during implementation:** an access gate. `IDP_REQUIRED_GROUPS`
  (any-of) and `IDP_ALLOWED_DOMAINS` (email domain), enforced per
  authentication with denials logged, plus a startup warning when neither is
  set. Without it, "authenticated" would mean "anyone in the tenant".

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

Status: unit tests cover config parsing, ID-token decoding, identity extraction
and the gate; a local smoke test confirms both discovery documents advertise our
`BASE_URL`, that `/oauth/authorize` hands off upstream to the configured IdP,
that `/mcp` answers 401 with the resource-metadata pointer, and that every
misconfiguration fails fast at startup. **The end-to-end login and the
group-denial path still need a real tenant** — that is the remaining Phase 1
acceptance work, and it needs decision 1 (§7) settled first.

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

The claims-passthrough limitation noted here earlier does not apply: Phase 1
decodes the ID token directly, so array claims arrive intact and
`allowComplexClaims` is irrelevant. `IDP_GROUPS_CLAIM` selects which claims to
read, and `toStringList` already accepts arrays, space-delimited and
comma-delimited values.

The IdP-side wrinkle is real, though, and needs checking against the actual
tenant early: Entra needs the `groups` optional claim configured, or app roles
(cleaner — names, not GUIDs, in `roles`), and overflows to `hasgroups` past ~200
groups; Google does **not** put Workspace groups in the ID token at all, so
Google deployments authorize by `IDP_ALLOWED_DOMAINS` plus per-email policy;
Keycloak and Authentik need a mapper to emit `groups`.

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
  `COUCHDB_PASSWORD` at it. A plain member account suffices — `src/vault.ts` does
  direct doc get/put plus a selector `_changes` feed, and the database already
  exists by then. It cannot be narrowed further: CouchDB has no read-only
  database role, and the salt document may need writing (§4). Still worth a test
  against a fresh database before committing.
- Secrets (`COUCHDB_PASSWORD`, `COUCHDB_PASSPHRASE`, `IDP_CLIENT_SECRET`,
  `IDP_*_KEY`) come from a secret manager / Fly secrets, never a committed
  `.env`. `.env.example` gains the new keys with placeholders only.
- **A dedicated, minimally privileged IdP app registration per vault is not
  optional.** Found while smoke-testing Phase 1: `/oauth/register` answers any
  caller with the upstream `client_id` and `client_secret` — that is how fastmcp
  bridges clients expecting dynamic registration — so those credentials are
  recoverable by anyone who can reach the port. Grant the app nothing beyond
  `openid`/`profile`/`email`, no client-credentials grant, and rotate on
  exposure (which also ends all sessions, since the session keys derive from it).
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

### Phase 8 — Multi-vault provisioning (2–3 d) · only if §4 applies

One vault registry file as the source of truth — per vault: name, CouchDB
database, hostname, owning group, sensitivity tier. Generate from it: compose /
fly config per instance, the IdP redirect URI list, CouchDB users and
`_security` docs, and LiveSync Setup URIs. `deploy/generate-setup-uri.mjs`
already mints a per-vault Setup URI from `hostname`/`username`/`password`/
`database`/`passphrase` — drive it from the registry instead of by hand.

The CouchDB half is a loop over that registry, where
`deploy/mcp-with-db/entrypoint.sh` today does exactly one database, one user and
one name-based `_security` doc: per vault create the database, create
`livesync-<vault>` and `mcp-<vault>`, and write a role-based `_security` (§4).
Requires admin credentials, so keep it a provisioning script rather than
something an instance runs at boot.

Plus: one rollout script that bumps the pinned image across every instance (N
instances means N chances to forget one), and a per-instance health check.
Mostly ops glue, no server code.

---

## 4. Multiple vaults

Three things drive a second vault: notes the whole team cannot read (personal,
HR, legal), different membership (per-client or per-project), and different
sensitivity tiers (own passphrase, own host). All three are the same mechanism —
another vault, another instance.

### Topology: one instance per vault, one *origin* per vault

Not just one port per vault — one hostname. Two verified reasons:

1. **`BASE_URL` is the cryptographic tenant boundary.** With token swap on
   (default), the proxy's JWT issuer is constructed with
   `issuer = audience = baseUrl` (`dist/chunk-H4VC4YTC.js:886-892`) and
   verification rejects a mismatched `iss` or `aud`
   (`dist/chunk-H4VC4YTC.js:591-604`). So a distinct `BASE_URL` per vault means a
   token minted for vault A is refused by vault B — even if the signing keys were
   shared. The converse is the trap: two instances configured with the *same*
   `BASE_URL` would accept each other's tokens if they shared a signing key.
   Distinct hostname per vault, and never share `jwtSigningKey` / `encryptionKey`
   across vaults regardless.
2. **You cannot path-multiplex vaults under one origin.** fastmcp does serve the
   RFC 9728 path-suffixed protected-resource document
   (`/.well-known/oauth-protected-resource<endpoint>`), but
   `/.well-known/oauth-authorization-server` and every `/oauth/*` proxy route are
   fixed at origin root (`dist/chunk-UVX47AE5.js:1789-1817`), as is this repo's
   own password-mode discovery (`src/auth.ts:116,124`). Several instances behind
   one origin collide there.

So: `vault-<name>.mcp.internal` → container, routed by host header at the
reverse proxy. Nothing clever.

### Rejected: one process serving many vaults

Tempting — one URL, one OAuth flow, one audit stream, and vault-granular read
scoping via `canAccess`. But it means a real fork (a `VaultBackend` and
`SearchIndex` per vault, a vault argument or namespaced tools threaded through
all of `src/tools.ts`, `DATA_DIR` per vault), every passphrase and every
decrypted vault in one process, and a policy bug becomes a cross-vault read.
Process isolation is the only control here that isn't code we have to get right.
Revisit only if instance count becomes unmanageable — call it 10-15 vaults.

### Footguns, verified in this codebase

1. **`DATA_DIR` is keyed on `VAULT_NAME` alone** —
   `vaultId = sha256(VAULT_NAME)[0:12]` (`src/main.ts:98-100`). Two instances
   with the same `VAULT_NAME` sharing a data volume land in the same directory
   and fight over `search-index.json` and `auth-tokens.json`; with different
   passphrases each fails to decrypt the other's index and rebuilds, forever.
   Distinct `VAULT_NAME` per vault, and prefer a distinct `DATA_DIR` per
   instance.
2. **Deep links embed `VAULT_NAME`** (`src/deeplink.ts:8`) as
   `obsidian://open?vault=<name>`, which must match the Obsidian vault *folder
   name* on each person's machine. So vault naming is a team-wide onboarding
   rule, not a server detail: pick the names once (`team-knowledge`,
   `client-acme`) and have everyone use them locally.
3. **CouchDB provisioning is single-vault today** — one database, one user, one
   name-based `_security` doc (`deploy/mcp-with-db/entrypoint.sh:33-76`). Per
   vault we want its own database and its own `livesync-<vault>` /
   `mcp-<vault>` accounts, so a leaked sync credential reaches exactly one
   vault. Detail below.
4. **Memory and change feeds are per instance.** Each instance holds its own
   in-memory index and its own `_changes` feed, so size per vault rather than per
   team (the 256 MB in `deploy/mcp-only/fly.toml` is a solo-vault figure). Fly's
   `auto_stop_machines = 'suspend'` with `min_machines_running = 0` means idle
   vaults cost almost nothing and a cold start resumes from the persisted
   `since` — so many vaults is cheap as long as few are busy.

### CouchDB: one server, many vault databases — yes; one database, many vaults — no

**One CouchDB hosting every vault as its own database works today, with no code
change.** `COUCHDB_URL` and `COUCHDB_DATABASE` are separate settings
(`src/main.ts:29-31`), so N instances point at one server and N databases. This
is CouchDB's normal multi-tenancy shape and the recommended deployment.

**Two vaults inside one database is not possible**, and won't become possible
cheaply:

- Document `_id` is the note path — or `f:<hash>` with LiveSync's "Obfuscate
  properties" — with no vault dimension (`src/id-format.ts`). Two vaults would
  collide on every identically-named note.
- The PBKDF2 salt lives in a single per-database local document,
  `_local/obsidian_livesync_sync_parameters`
  (`lib/livesync-commonlib/src/common/models/sync.definition.ts:10`). One salt
  per database means **one E2E crypto domain per database** — vaults sharing a
  database share the encryption context, which is most of what we wanted
  separation for.
- The `_changes` feed has no vault dimension, so every instance would index
  every vault's changes, and `reconcileObfuscation` (`src/vault.ts:63-80`)
  samples IDs database-wide — a shared database would classify as `mixed` and
  warn on every start.

So: **one database per vault, one instance per database.**

### CouchDB facts that shape the provisioning

- **Use roles, not names, in `_security`.** Users are global in `_users`;
  authorization is per database. `deploy/mcp-with-db/entrypoint.sh:71` writes
  `members.names` today, which means adding a person edits every vault's
  `_security`. A per-vault role (`vault-<name>`) inverts that: membership becomes
  a `_users` document edit.
- **CouchDB has no read-only database role.** `members` means read *and* write.
  A read-only MCP instance is therefore enforced only by `READ_ONLY=true` in our
  process, not by the database. If we want it enforced underneath, that is a
  `validate_doc_update` design doc rejecting writes from that role — and note it
  would also block the sync-params write below, so it needs an exemption.
- **The MCP account needs write access even when the instance is read-only.**
  The sync-params document holding the salt is created if absent
  (`SyncParamsHandler`), so a brand-new or rebuilt database needs a writable
  account on first use. For an existing vault the document is already there.
  This resolves the open question in Phase 4: a plain member account is enough —
  no server admin — but it cannot be narrowed below read+write.
- **Server admins bypass `_security` entirely**, so admin credentials reach every
  vault on the server. That is the argument for the dedicated per-vault account
  in Phase 4, and it gets stronger with each vault added. Note the layering that
  does hold: a CouchDB admin sees ciphertext for every vault (plus paths, unless
  obfuscation is on); the MCP host is the only place one vault is plaintext.
- **Creating a database requires a server admin**, so vault creation is a
  provisioning-time action with admin credentials, never something an instance
  does for itself.
- **There are no per-database quotas.** One runaway vault fills the shared disk
  for all of them. Monitor per-database size; give a high-risk or high-volume
  vault its own volume or its own server.
- **Watch `max_dbs_open`** (default 500) and file descriptors: each vault carries
  its members' LiveSync replications plus one MCP `_changes` feed. Fine at team
  scale, worth knowing before "a database per person". LiveSync also churns
  chunk documents, so N vaults means N compaction workloads on one node.

### Identity and access, per vault

- **Per-vault app registration in the IdP is the read-scoping mechanism.** One
  registration per vault (redirect URI `https://<vault-host>/oauth/callback`)
  with user or group assignment required means vault *membership* is administered
  in the IdP, and the server needs no read-scoping code at all: a non-member
  never gets a token the instance will accept. This is the answer to the §0
  problem — enforce read confidentiality at the IdP and instance boundary, since
  it cannot be enforced inside a vault.
- **Cheaper alternative:** one app registration with N redirect URIs, plus a
  required-group check in each instance's `authenticate` (reject when the
  expected group claim is absent). Less admin work, weaker guarantee — the IdP
  will issue tokens to anyone in the tenant and the check is ours to get right.
  Recommend per-vault registrations for confidential vaults, shared app plus
  group check for ordinary team vaults.
- **Policy stays one file.** The Phase 2 `POLICY` becomes vault-keyed, mounted
  read-only into every instance, each selecting its own section by `VAULT_NAME`.
  One reviewable source of truth in git beats N env blobs drifting apart; add
  `vault` to the `resolvePolicy` inputs.
- **Audit gains a `vault` field** (Phase 3) and every instance ships to one
  sink, so "who touched what, anywhere" stays a single query.

### Client-side reality

Each vault is a separate MCP server entry in the client, so a person doing three
vaults does three OAuth flows and sees three copies of the same ten tool names,
distinguished only by server name. That confuses model tool-selection more than
it confuses people. Mitigate by naming each server after its vault in client
config and using the per-instance `MCP_INSTRUCTIONS` to state which vault this
is and what belongs in it. It is also a real argument for **few broad vaults
over many narrow ones**.

### Personal vaults: don't host them

If someone wants a private vault, the cheapest safe answer is filesystem mode on
their own machine — `VAULT_PATH` with `npx obsidian-sync-mcp`, no auth, the
loopback plus Host/Origin guard that already ships — or their own local CouchDB.
No hosted instance, no OAuth app, no secret we hold, no per-person container.
Reserve hosted instances for vaults with more than one member. That is what keeps
instance count proportional to *teams* rather than *people*.

---

## 5. Sequencing

Phases 1 → 2 → 3 are the critical path and the minimum viable team deployment:
real identity, default-deny per-user writes, and an audit trail. Ship those
first, to a small pilot group, on a copy of the vault.

4 (secrets/blast radius) runs in parallel — it's ops work, not code, apart from
the CouchDB user change.

5 and 6 are hardening; ship after the pilot. 7 is only needed at scale-out.

Phase 8 is independent of 1–7 and only applies once a second vault exists. Do
not build it speculatively — but do pick vault *names* and the `DATA_DIR` /
`VAULT_NAME` convention (§4) before the pilot, because changing a vault name
later breaks everyone's deep links and orphans the persisted index.

Rough total: 9–13 dev-days for a single vault, plus 2–3 for multi-vault
provisioning, plus IdP app-registration lead time — which is usually the real
schedule risk.

---

## 6. What we are explicitly not solving

- **Read confidentiality inside a vault.** Not possible in this architecture.
  Solved *at vault granularity* by §4 — separate vault, separate instance,
  membership administered in the IdP — or accept team-wide read. There is no
  folder-level read scoping and no cheap way to add one.
- **True multi-writer conflict resolution.** Phase 5 narrows the window; it does
  not give us merge semantics or `_rev` preconditions end-to-end.
- **Prompt injection from vault content.** Mitigated, not eliminated.
- **Binary attachments.** Not exposed by any tool; unchanged.

---

## 7. Decisions needed before Phase 1

1. **Which IdP** — Entra, Google, or generic (Authentik/Keycloak)? Determines
   whether we use `AzureProvider`/`GoogleProvider` or the generic
   `OAuthProvider`, and how group claims arrive.
2. **Group → scope map** — the concrete `POLICY` content: who is read-only, who
   writes where. Recommend starting with exactly two groups (readers, and
   editors scoped to a couple of folders) and adding rules on demand.
3. **Which vaults exist, and who is in each?** This is the §4 registry, and it
   drives instance count, IdP registrations, CouchDB databases and cost. Bias
   toward few broad vaults.
4. **Personal vaults: hosted or local?** Recommendation is local filesystem mode
   (§4) — no instance, no OAuth app, no secret we hold. Hosting them instead
   makes instance count scale with headcount.
5. **Where audit logs go**, and retention — including that note *paths* are
   sensitive.
6. **Hosting** — Fly (matching `deploy/`) or our own infra. Affects secret
   management and the single-machine constraint.

---

## 8. Keeping the fork cheap

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
