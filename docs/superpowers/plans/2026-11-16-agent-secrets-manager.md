# Agent Secrets Manager (ASM) v1 – Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Selbst gehosteter Secrets-Manager (Docker) mit Web-UI, MCP-Endpoint und CLI, bei dem Agenten Secrets mit Projekt und Begründung anfordern, ein Mensch freigibt (oder der zeitlich begrenzte Auto-Modus) und alles hash-verkettet auditiert wird.

**Architecture:** pnpm-Monorepo. `apps/server` (Fastify) enthält REST-API, OAuth-2.1-Server, MCP-Endpoint `/mcp` (Streamable HTTP) und liefert das Vite-Build von `apps/web` aus. `apps/cli` (`asm`) koppelt sich per Device Grant und löst Grants ein, sodass Werte standardmäßig nie im Agent-Kontext landen. Persistenz: SQLite mit Envelope-Verschlüsselung.

**Tech Stack:** Node 22, TypeScript 5 (strict, ESM), pnpm, Fastify 5, `@modelcontextprotocol/sdk`, `better-sqlite3` + `drizzle-orm`/`drizzle-kit`, `@simplewebauthn/server|browser`, `argon2`, `zod`, `pino`, React 19 + Vite + TanStack Query/Router + Tailwind v4 + Radix, `commander`, `@napi-rs/keyring`, vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-secrets-manager-design.md`

## Global Constraints

- Secret-Werte erscheinen nie in Logs, Fehlermeldungen, Audit-Einträgen oder Exceptions (pino `redact` für `*.value`, `*.plaintext`, `authorization`, `cookie`).
- AES-256-GCM, pro Secret eigener 32-Byte-DEK, AAD = Secret-ID; DEK mit KEK verschlüsselt. KEK aus `ASM_MASTER_KEY_FILE` oder `ASM_MASTER_KEY` (base64, 32 Byte); fehlt er → Prozess-Exit ≠ 0.
- Env-Variablen: `ASM_PUBLIC_URL` (Pflicht, bestimmt WebAuthn-RP-ID/Origin), `ASM_MASTER_KEY_FILE`/`ASM_MASTER_KEY`, `ASM_TRUST_PROXY` (Default `false`), `ASM_AUTO_MODE_MAX_MIN` (Default `240`), `ASM_DATA_DIR` (Default `/data`), `PORT` (Default `8080`).
- Fristen: Anfrage verfällt nach **5 min**; `await_request` Long-Poll max **60 s**; Grant gültig **15 min**, Default 1 Nutzung; Access-Token **1 h**, Refresh-Token rotierend; Re-Auth nötig, wenn letzte Auth > **10 min**; Auto-Modus Default **30 min**.
- Session-Cookie: `httpOnly`, `Secure`, `SameSite=Strict`; mutierende Requests mit Origin-Prüfung gegen `ASM_PUBLIC_URL`.
- `delivery: "plaintext"` nur, wenn `secrets.allow_plaintext_to_agent = true` (Default `false`).
- `project` und `reason` sind bei jeder Anfrage Pflicht (nicht leer, max 200 bzw. 1000 Zeichen). `project` ist zusätzlich bei **allen MCP-Tools außer `await_request`** Pflicht und wird per `projectSlug()` normalisiert; jede Nutzung aktualisiert `projects.last_seen`.
- UI-Sprache Deutsch; Code/Identifier Englisch. Design-Tokens laut Spec-Abschnitt „Visuelles Design“ (Stone-Neutrals, einzige Signalfarbe Bernstein, Geist Sans/Mono, Radius 6 px, Haarlinien).
- IDs: Präfix + ULID (`usr_`, `vlt_`, `sec_`, `dev_`, `req_`, `grt_`, `aud_`, `prj_`).
- Agenten (Bearer-Geräte) dürfen Secrets **anlegen ohne Freigabe**, **ändern nur über eine Freigabe** (Anfrage-Art `update`, gleicher Ablauf wie Abrufe inkl. Auto-Modus), **archivieren ohne Freigabe** (mit Pflicht-`reason` und `project`), **nie löschen**, **nie reaktivieren** und **nie** `allow_plaintext_to_agent` setzen oder ändern.
- Archivierte Secrets: in Suchen nur mit `includeArchived`; Abruf, Änderung und Grant-Einlösung → `409 secret_archived`; beim Archivieren werden offene Anfragen zum Secret auf `denied` (`decided_by = 'system'`, `meta.cause = 'archived'`) gesetzt und Grants gelöscht.
- Jede Wertänderung oder Metadaten-Änderung erzeugt eine neue Zeile in `secret_versions`; Versionen werden nie gelöscht oder überschrieben (außer beim Löschen des ganzen Secrets durch einen Menschen). AAD einer Version = `${secretId}:${version}`.
- Push ist **nicht** Teil von v1.

## Review Focus

1. **Mitgliedschaft entzogen zwischen Anfrage und Freigabe/Einlösung** → Freigabe und Grant-Einlösung prüfen Tresor-Zugriff erneut und schlagen mit 403 fehl (Test in Task 9 und 11).
2. **Widerrufenes Gerät mit noch gültigem Access-Token** → jeder Bearer-Request prüft `devices.status = 'approved'`; sofort 401 (Test in Task 8).
3. **Doppelte Entscheidung (zwei Browser-Tabs, Freigeben + Verweigern gleichzeitig)** → nur die erste Entscheidung zählt, genau ein Grant, zweite liefert 409 (Test in Task 9).
4. **Grant-Einlösung durch Gerät eines anderen Nutzers, abgelaufen oder verbraucht** → 403/410 ohne Wert, Audit-Eintrag `grant.redeem_denied` (Test in Task 11).
5. **Agent versucht, sich Klartext-Zugriff zu verschaffen** (`allow_plaintext_to_agent` in `create_secret`/`update_secret`/`asm set` mitschicken) → 400 `field_not_allowed`, nichts wird angelegt oder geändert (Test in Task 7 und 10).

---

## Dateistruktur

```
package.json, pnpm-workspace.yaml, tsconfig.base.json, vitest.workspace.ts, .gitignore, .editorconfig
packages/shared/src/
  ids.ts            newId(prefix)
  schemas.ts        zod-Schemas für API-DTOs (SecretMeta, AccessRequestDto, AuditEntryDto, ...)
  api-client.ts     typed fetch client (von web und cli genutzt)
apps/server/src/
  main.ts           Start: loadConfig → openDb → buildApp → listen
  app.ts            buildApp(deps): FastifyInstance (registriert alle Module)
  config.ts         loadConfig(env)
  crypto/envelope.ts, crypto/keys.ts
  db/schema.ts, db/client.ts, db/migrations/*
  audit/audit.ts, audit/routes.ts
  auth/password.ts, auth/sessions.ts, auth/webauthn.ts, auth/setup.ts, auth/routes.ts, auth/guards.ts
  vaults/service.ts, vaults/routes.ts
  secrets/service.ts, secrets/routes.ts
  devices/service.ts, devices/routes.ts
  oauth/metadata.ts, oauth/clients.ts, oauth/authorize.ts, oauth/token.ts, oauth/device-grant.ts, oauth/bearer.ts
  requests/service.ts, requests/automode.ts, requests/grants.ts, requests/events.ts, requests/routes.ts
  mcp/server.ts, mcp/tools.ts
  scripts/generate-key.ts
apps/server/test/   je Modul *.test.ts, helpers/testApp.ts (In-Memory-DB, fester Key, Fake-Clock)
apps/cli/src/       index.ts, commands/{login,logout,search,request,run,write,mcp-config}.ts, auth-store.ts
apps/web/src/       main.tsx, styles/tokens.css, components/ui/*, layout/*, routes/*, lib/{api,sse,shortcuts}.ts
apps/web/e2e/       *.spec.ts (Playwright)
Dockerfile, docker-compose.example.yml, README.md
```

Zeit wird überall über ein injiziertes `Clock { now(): number }` gelesen (Tests nutzen `FakeClock`).

---

### Task 1: Monorepo-Gerüst und Server-Skelett

**Files:**
- Create: Root-Dateien oben, `packages/shared/src/ids.ts`, `apps/server/src/{main,app,config}.ts`, `apps/server/test/helpers/testApp.ts`
- Test: `apps/server/test/config.test.ts`, `apps/server/test/health.test.ts`, `packages/shared/test/ids.test.ts`

**Interfaces:**
- Produces:
  - `type Config = { publicUrl: URL; masterKey: Buffer; trustProxy: boolean; autoModeMaxMin: number; dataDir: string; port: number }`
  - `loadConfig(env: NodeJS.ProcessEnv, readFile?: (p: string) => string): Config` (wirft `ConfigError`)
  - `newId(prefix: 'usr'|'vlt'|'sec'|'dev'|'req'|'grt'|'aud'|'ses'|'cli'|'prj'): string`
  - `buildApp(deps: AppDeps): Promise<FastifyInstance>`; `AppDeps = { config: Config; db: Db; clock: Clock; logger?: pino.Logger }`
  - `createTestApp(opts?): Promise<{ app; db; clock: FakeClock; config }>`

- [ ] **Step 1: Tests schreiben**
  - `loadConfig` ohne Key → wirft `ConfigError` mit Text `ASM_MASTER_KEY`; Key mit 31 Byte → wirft; `ASM_MASTER_KEY_FILE` wird gelesen und getrimmt; Defaults (`port 8080`, `autoModeMaxMin 240`, `trustProxy false`).
  - `newId('sec')` matcht `/^sec_[0-9A-HJKMNP-TV-Z]{26}$/`.
  - `GET /healthz` → `200 {"status":"ok"}`.
- [ ] **Step 2:** `pnpm -r test` → FAIL (Module fehlen)
- [ ] **Step 3:** Workspace (pnpm, TS strict, ESM, vitest workspace), `loadConfig`, `newId` (ulid), `buildApp` mit `/healthz`, pino mit Redaction-Pfaden aus Global Constraints.
- [ ] **Step 4:** `pnpm -r test` → PASS; `pnpm -r typecheck` → keine Fehler
- [ ] **Step 5:** Commit `chore: monorepo scaffold and server skeleton`

---

### Task 2: Envelope-Verschlüsselung

**Files:**
- Create: `apps/server/src/crypto/envelope.ts`, `apps/server/src/scripts/generate-key.ts`
- Test: `apps/server/test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `type Sealed = { ciphertext: Buffer; iv: Buffer; tag: Buffer; wrappedDek: Buffer; dekIv: Buffer; dekTag: Buffer }`
  - `seal(kek: Buffer, aad: string, plaintext: string): Sealed`
  - `open(kek: Buffer, aad: string, sealed: Sealed): string` (wirft `DecryptError` ohne Klartext in `message`)
  - CLI-Skript `pnpm --filter server generate-key` → druckt 32 Byte base64

- [ ] **Step 1: Tests**: Roundtrip; zwei `seal` desselben Werts ergeben verschiedene Ciphertexte; gekipptes Byte in `ciphertext`, `tag` oder `wrappedDek` → `DecryptError`; falsche AAD → `DecryptError`; falscher KEK → `DecryptError`; `String(err)` enthält den Klartext nicht.
- [ ] **Step 2:** Test → FAIL
- [ ] **Step 3:** Implementieren mit `node:crypto` `aes-256-gcm`, 12-Byte-IVs, DEK via `randomBytes(32)`; DEK wird mit KEK gewrappt (AAD `dek:` + aad).
- [ ] **Step 4:** Test → PASS
- [ ] **Step 5:** Commit `feat(server): envelope encryption`

---

### Task 3: Datenbankschema und Migrationen

**Files:**
- Create: `apps/server/src/db/schema.ts`, `apps/server/src/db/client.ts`, `apps/server/src/db/migrations/0000_init.sql` (via drizzle-kit, FTS5-Teil handgeschrieben)
- Test: `apps/server/test/db.test.ts`

**Interfaces:**
- Produces: `openDb(path: string | ':memory:'): Db` (WAL, `foreign_keys=ON`, führt Migrationen aus); Drizzle-Tabellen:
  `users(id, username unique, password_hash null, is_admin, created_at)`,
  `passkeys(id, user_id, credential_id unique, public_key, counter, transports, name, created_at)`,
  `sessions(id, user_id, token_hash unique, last_auth_at, expires_at, created_at)`,
  `vaults(id, name, personal_of_user_id null, created_at)`,
  `vault_members(vault_id, user_id, role 'owner'|'member', PK(vault_id,user_id))`,
  `secrets(id, vault_id, title, description, tags json, env_name, allow_plaintext_to_agent, current_version, created_by_type 'user'|'device', created_by_id, archived_at null, archived_by_type null, archived_by_id null, archive_reason null, archive_project null, created_at, updated_at)`,
  `secret_versions(secret_id, version, ciphertext, iv, tag, wrapped_dek, dek_iv, dek_tag, meta_snapshot json {title,description,tags,envName}, changed_by_type, changed_by_id, project null, reason null, restored_from null, created_at, PK(secret_id, version))`,
  `secrets_fts` (FTS5: title, description, tags; Trigger für insert/update/delete),
  `devices(id, user_id null, name, kind 'mcp'|'cli', hostname, status 'pending'|'approved'|'denied'|'revoked', last_used_at, created_at)`,
  `oauth_clients(id, name, redirect_uris json, created_at)`,
  `oauth_codes(code_hash, client_id, device_id, user_id, code_challenge, redirect_uri, expires_at)`,
  `device_codes(device_code_hash, user_code unique, device_id, status, expires_at)`,
  `tokens(id, device_id, kind 'access'|'refresh', token_hash unique, expires_at, revoked_at)`,
  `access_requests(id, kind 'read'|'update', secret_id, device_id, user_id, project, reason, delivery 'cli'|'plaintext' null, proposed_meta json null, proposed_value_sealed json null, status 'pending'|'approved'|'denied'|'expired', decided_by null, auto, created_at, decided_at, expires_at)`,
  `grants(id, request_id, user_id, secret_id, uses_left, expires_at, created_at)`,
  `projects(id 'prj_', slug unique, display_name, merged_into null, first_seen, last_seen)`, `project_usage(project_id, secret_id, device_id, last_used_at, PK(project_id, secret_id, device_id))`,
  `auto_mode(user_id PK, enabled_until null, default_duration_min, vault_ids json null)`,
  `audit_log(seq integer PK autoincrement, id, ts, actor_type 'user'|'device'|'system', actor_id, event, secret_id, vault_id, device_id, project, reason, ip, meta json, prev_hash, hash)`

- [ ] **Step 1: Tests**: `openDb(':memory:')` legt alle Tabellen an; Insert in `secrets` macht ihn per `secrets_fts MATCH 'github'` findbar, Update der Beschreibung aktualisiert den Index, Delete entfernt ihn; FK-Verletzung (`vault_members` mit unbekanntem Vault) wirft; doppelte `(secret_id, version)` wirft.
- [ ] **Step 2:** FAIL → **Step 3:** Schema, Migration, `openDb` → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): sqlite schema with fts5`

---

### Task 4: Audit-Log mit Hash-Kette

**Files:**
- Create: `apps/server/src/audit/audit.ts`
- Test: `apps/server/test/audit.test.ts`

**Interfaces:**
- Produces:
  - `type AuditEvent = 'auth.login'|'auth.login_failed'|'device.pair_requested'|'device.approved'|'device.denied'|'device.revoked'|'secret.searched'|'request.created'|'request.approved'|'request.denied'|'request.auto_approved'|'request.expired'|'grant.redeemed'|'grant.redeem_denied'|'secret.plaintext_delivered'|'secret.created'|'secret.updated'|'secret.deleted'|'secret.revealed'|'secret.version_revealed'|'secret.version_restored'|'secret.archived'|'secret.unarchived'|'automode.enabled'|'automode.disabled'|'vault.member_added'|'vault.member_removed'`
  - `appendAudit(db, clock, entry: { actorType; actorId; event: AuditEvent; secretId?; vaultId?; deviceId?; project?; reason?; ip?; meta?: Record<string, unknown> }): AuditRow`
  - `verifyChain(db): { ok: true } | { ok: false; brokenAtSeq: number }`
  - `queryAudit(db, filter: { userId: string; deviceId?; secretId?; project?; event?; from?; to?; cursor?; limit? }): { items: AuditRow[]; nextCursor?: string }` (nur Einträge zu Tresoren, in denen `userId` Mitglied ist, plus eigene Akteur-Einträge)

- [ ] **Step 1: Tests**: Drei Einträge → `verifyChain` ok; `hash = sha256(prev_hash + kanonisches JSON der Felder ohne hash)`; erster `prev_hash` = 64×`0`; ein Eintrag per Raw-SQL geändert → `{ ok:false, brokenAtSeq }` mit korrekter seq; `meta` mit Schlüssel `value` wird abgelehnt (wirft), damit nie ein Secret ins Log gerät.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren; Append in einer Transaktion (letzten Hash lesen + insert) → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): hash-chained audit log`

---

### Task 5: Nutzer, Passwort-Login, Sessions, Setup-Admin

**Files:**
- Create: `apps/server/src/auth/{password,sessions,setup,guards,routes}.ts`
- Test: `apps/server/test/auth-password.test.ts`

**Interfaces:**
- Consumes: `appendAudit`, `newId`
- Produces:
  - `hashPassword(pw): Promise<string>`, `verifyPassword(hash, pw): Promise<boolean>` (argon2id)
  - `createSession(db, clock, userId): { token: string; session }`, Cookie `asm_session`
  - Fastify-Decorators: `req.user: { id; username; isAdmin } | undefined`, Guards `requireUser`, `requireAdmin`, `requireRecentAuth(maxAgeMs = 600_000)` (sonst `401 {"error":"reauth_required"}`)
  - `createUser(db, { username, password?, isAdmin })` legt **automatisch persönlichen Tresor** an (owner)
  - Routes: `GET /api/setup/status` → `{needsSetup}`; `POST /api/setup {token, username, password}` (Setup-Token beim ersten Start generiert, im Log ausgegeben, nur gültig solange keine Nutzer existieren); `POST /api/auth/login {username,password}`; `POST /api/auth/logout`; `GET /api/auth/me`; `POST /api/auth/reauth/password`; `POST /api/admin/users` (admin)
- [ ] **Step 1: Tests**: Setup mit falschem Token → 403; mit richtigem → 201 und danach `needsSetup:false`, zweites Setup → 409; Login falsches Passwort → 401 + Audit `auth.login_failed`; Login ok → Cookie mit `HttpOnly; Secure; SameSite=Strict`; `/api/auth/me` mit Cookie → User; POST ohne passenden `Origin`-Header → 403; neuer Nutzer hat genau einen persönlichen Tresor; `requireRecentAuth` nach 11 min (FakeClock) → `reauth_required`; 6. Fehl-Login innerhalb 1 min → 429.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren (`@fastify/cookie`, `@fastify/rate-limit`, Session-Token als sha256 gespeichert, Lebensdauer 7 Tage) → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): password auth, sessions, setup`

---

### Task 6: Passkeys (WebAuthn)

**Files:**
- Create: `apps/server/src/auth/webauthn.ts` (+ Routen in `auth/routes.ts`)
- Test: `apps/server/test/auth-webauthn.test.ts`

**Interfaces:**
- Produces Routes: `POST /api/auth/passkey/register/options` (requireUser), `POST /api/auth/passkey/register/verify`, `POST /api/auth/passkey/login/options` (discoverable, ohne Username), `POST /api/auth/passkey/login/verify`, `POST /api/auth/reauth/passkey/{options,verify}`, `GET /api/auth/passkeys`, `DELETE /api/auth/passkeys/:id`. RP-ID = `config.publicUrl.hostname`, Origin = `config.publicUrl.origin`. Challenges serverseitig an Session bzw. kurzlebigen Challenge-Cookie gebunden (5 min).
- [ ] **Step 1: Tests** (mit `@simplewebauthn/server` gemockten `verify*`-Funktionen über DI): Register speichert Credential; Login mit unbekannter Credential-ID → 401; erfolgreicher Login setzt Session und aktualisiert `counter`; Counter-Rückschritt → 401; letzte Passkey löschen, wenn kein Passwort gesetzt → 409.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): passkey authentication`

---

### Task 7: Tresore und Secrets

**Files:**
- Create: `apps/server/src/projects/{slug,service,routes}.ts`, `apps/server/src/vaults/{service,routes}.ts`, `apps/server/src/secrets/{service,routes}.ts`, `apps/server/src/audit/routes.ts`, `packages/shared/src/schemas.ts` (SecretMeta, SecretInput, VaultDto)
- Test: `apps/server/test/vaults.test.ts`, `apps/server/test/secrets.test.ts`, `apps/server/test/projects.test.ts`

**Interfaces:**
- Consumes: `seal`/`open`, `appendAudit`, Guards
- Produces:
  - `projectSlug(name: string): string` – CamelCase trennen, Kleinbuchstaben, alles außer `[a-z0-9]` → `-`, Mehrfach-/Rand-Bindestriche entfernen, max 100 Zeichen; leeres Ergebnis → wirft `ValidationError`
  - `touchProject(ctx, name): Project` (anlegen oder `last_seen` setzen, folgt `merged_into`), `recordUsage(ctx, projectId, secretId, deviceId)`
  - `listProjects(db, userId)`, `getProject(db, userId, id): { project; secrets: {secret, lastUsedAt}[]; devices: {device, lastUsedAt}[] }` (nur Secrets aus zugänglichen Tresoren), `mergeProjects(ctx, userId, fromId, intoId)` (setzt `merged_into`, verschiebt `project_usage`), `projectsForSecret(db, userId, secretId)`
  - Routes: `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id/merge {into}` (requireRecentAuth), `GET /api/secrets/:id/projects`
  - `canAccessVault(db, userId, vaultId): boolean`; `listVaultsForUser(db, userId)`
  - `type SecretMeta = { id; vaultId; vaultName; title; description; tags: string[]; envName: string|null; allowPlaintextToAgent: boolean; updatedAt }`
  - `SecretMeta` zusätzlich: `archived: null | { at; by: { type; id; name }; reason; project }`
  - `searchSecrets(db, userId, query: string, opts?: { vaultId?; includeArchived?: boolean; status?: 'active'|'archived'|'all' }): SecretMeta[]` (FTS5 Prefix-Match, leerer Query → alle, max 50, nur zugängliche Tresore)
  - `type Actor = { type: 'user'; userId } | { type: 'device'; deviceId; userId }`
  - `createSecret(ctx, actor, input: SecretInput & { value?: string; generate?: { length: number; alphabet?: 'alnum'|'hex'|'base64url'|'symbols' }; project?; reason? }): SecretMeta` – schreibt Version 1; genau eins von `value`/`generate` Pflicht; `generate.length` 16…256; Device-Actor: `project`/`reason` Pflicht, `allowPlaintextToAgent` im Input → 400 `field_not_allowed`, Standard-Tresor = persönlicher Tresor des Gerätebesitzers
  - `applySecretChange(ctx, actor, secretId, change: { meta?: Partial<SecretInput>; value?: string; generate?; project?; reason?; restoredFrom?: number }): SecretMeta` – legt Version `current_version + 1` an (Wert unverändert → bisheriger Klartext wird neu versiegelt), aktualisiert Metadaten und FTS; wird von menschlichen Updates direkt und von freigegebenen Agent-Updates (Task 9) aufgerufen
  - `deleteSecret(...)` (nur Nutzer), `revealSecret(ctx, userId, secretId, version?): string`
  - `listHistory(db, userId, secretId): { versions: SecretVersionDto[]; events: { type: 'archived'|'unarchived'; at; by; reason?; project? }[] }` (Events aus `audit_log`); `listVersions` = `listHistory(...).versions`. Signatur-Basis:
  - `listVersions(db, userId, secretId): SecretVersionDto[]` (`{ version, changedBy: { type, id, name }, project, reason, metaDiff, restoredFrom, createdAt }`, ohne Werte)
  - `archiveSecret(ctx, actor: Actor, secretId, { reason: string /* 1…1000 */; project: string }): SecretMeta` – idempotent nur im Sinne von `409 already_archived`; Audit `secret.archived`; setzt offene Anfragen auf `denied` und löscht Grants (Funktion `cancelOpenForSecret` aus Task 9 wird hier noch als No-Op-Hook `onArchived` aufgerufen und in Task 9 verdrahtet)
  - `unarchiveSecret(ctx, userId, secretId)` – nur Nutzer-Actor; Audit `secret.unarchived`
  - `restoreVersion(ctx, userId, secretId, version)` = `applySecretChange` mit Wert + Meta der alten Version und `restoredFrom`
  - Routes: `GET/POST /api/vaults`, `POST/DELETE /api/vaults/:id/members` (nur owner), `GET /api/secrets?q=&vault=`, `POST /api/secrets`, `PATCH/DELETE /api/secrets/:id`, `POST /api/secrets/:id/reveal` (requireRecentAuth, Audit `secret.revealed`), `GET /api/secrets/:id/versions`, `POST /api/secrets/:id/versions/:v/reveal` (requireRecentAuth, Audit `secret.version_revealed`), `POST /api/secrets/:id/versions/:v/restore` (requireRecentAuth, Audit `secret.version_restored`), `POST /api/secrets/:id/archive {reason, project?}`, `POST /api/secrets/:id/unarchive` (requireRecentAuth); `GET /api/secrets?status=active|archived|all` (Default `active`)
  - Audit-Routes: `GET /api/audit` (Filter wie `queryAudit`), `GET /api/audit.csv`, `GET /api/audit/verify`
  - Validierung: `envName` matcht `/^[A-Z_][A-Z0-9_]*$/`; `value` max 64 KiB
- [ ] **Step 1: Tests**: Nutzer B sieht Secrets aus A's persönlichem Tresor weder in Suche noch per ID (404); nach Hinzufügen zu geteiltem Tresor sichtbar; Suche „git“ findet „GitHub Token“ via Beschreibung; GET-Antworten enthalten nie `value`/Ciphertext-Felder; Reveal ohne Re-Auth → 401 `reauth_required`; Reveal liefert Klartext und schreibt Audit; Löschen des letzten Owners eines geteilten Tresors → 409; ungültiger `envName` → 400.
  - Versionen: Anlegen → Version 1; zwei Updates → Versionen 1–3, `revealSecret(…, 1)` liefert den ursprünglichen Wert, Liste enthält keine Werte; reines Metadaten-Update erzeugt ebenfalls eine Version mit `metaDiff`; Restore von Version 1 → Version 4 mit altem Wert und `restoredFrom: 1`; Chiffrat von Version 2 mit AAD von Version 3 → `DecryptError`.
  - Projekte: `projectSlug('AgentSecretsManager') === 'agent-secrets-manager'`, `projectSlug('  My_App v2 ') === 'my-app-v2'`, `projectSlug('---')` wirft; `touchProject('Foo')` und `touchProject('foo')` ergeben dasselbe Projekt; nach `mergeProjects(a→b)` liefert `touchProject(a.slug)` Projekt b und `getProject(b)` enthält die Nutzungen von a; Audit-Einträge bleiben unverändert; `getProject` zeigt Nutzer B keine Secrets aus A's Tresor.
  - Archiv: Device-Actor archiviert mit Grund → `archived.reason` gesetzt, Suche ohne `includeArchived` findet es nicht, mit `status:'archived'` schon; ohne `reason` → 400; zweites Archivieren → 409 `already_archived`; `applySecretChange` auf archiviertes Secret → 409 `secret_archived`; `unarchiveSecret` durch Device-Actor ist nicht aufrufbar (Route nur mit Session) und durch Nutzer → wieder aktiv; Versionen bleiben unverändert.
  - Device-Actor: `createSecret` ohne `project` → 400; mit `allowPlaintextToAgent: true` → 400 `field_not_allowed` und kein Secret angelegt (Review Focus 5); `generate: {length: 32}` erzeugt 32 Zeichen, die in keiner Antwort vorkommen; Tresor ohne Mitgliedschaft des Gerätebesitzers → 404.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): vaults and encrypted secrets`

---

### Task 8: Geräte und OAuth-2.1-Server (MCP-Kopplung + Device Grant)

**Files:**
- Create: `apps/server/src/devices/{service,routes}.ts`, `apps/server/src/oauth/{metadata,clients,authorize,token,device-grant,bearer}.ts`
- Test: `apps/server/test/oauth-authcode.test.ts`, `apps/server/test/oauth-device.test.ts`, `apps/server/test/devices.test.ts`

**Interfaces:**
- Produces:
  - `GET /.well-known/oauth-protected-resource` (resource = `${publicUrl}/mcp`, authorization_servers = [publicUrl]); `GET /.well-known/oauth-authorization-server` (issuer, authorization/token/registration/device_authorization endpoints, `code_challenge_methods_supported:["S256"]`, grant types `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`)
  - `POST /oauth/register` (RFC 7591, nur `redirect_uris` auf `http://localhost`/`127.0.0.1` oder https erlaubt)
  - `GET /oauth/authorize` → leitet zur Web-Consent-Seite `/connect?req=…` (SPA); `POST /api/oauth/consent {req, decision:'approve'|'deny', deviceName}` (requireUser + requireRecentAuth) → legt `devices` (kind `mcp`, status approved) an, Audit `device.approved|denied`, gibt `redirectTo` mit `code`+`state` zurück
  - `POST /oauth/token`: `authorization_code` (PKCE S256 Pflicht, Code einmalig, 60 s gültig), `refresh_token` (Rotation; Wiederverwendung eines alten Refresh-Tokens widerruft das Gerät), `device_code` (`authorization_pending`, `slow_down`, `expired_token`, `access_denied` gem. RFC 8628)
  - `POST /oauth/device_authorization {client_name, hostname}` → `{device_code, user_code (Format XXXX-XXXX), verification_uri: ${publicUrl}/activate, expires_in: 600, interval: 5}`; legt Gerät kind `cli`, status `pending` an, Audit `device.pair_requested`
  - `POST /api/devices/activate {user_code, decision}` (requireUser + requireRecentAuth)
  - `bearerAuth` preHandler: `req.device: { id; userId; kind }`; 401 mit `WWW-Authenticate: Bearer resource_metadata="…"` wenn Token fehlt/ungültig/abgelaufen **oder Gerät nicht `approved`**; aktualisiert `last_used_at`
  - `GET /api/devices`, `PATCH /api/devices/:id {name}`, `POST /api/devices/:id/revoke` (widerruft alle Tokens)
- [ ] **Step 1: Tests**: vollständiger Auth-Code-Flow mit PKCE → Access-Token funktioniert gegen eine Test-Route mit `bearerAuth`; falscher `code_verifier` → `invalid_grant`; Code zweimal → `invalid_grant`; Refresh-Rotation, alter Refresh erneut → 400 und Gerät `revoked`; Device-Flow: Poll vor Freigabe → `authorization_pending`, nach Aktivierung → Tokens, nach Verweigerung → `access_denied`, nach 10 min → `expired_token`; **Gerät widerrufen → gültiges Access-Token liefert sofort 401** (Review Focus 2); Access-Token nach 61 min (FakeClock) → 401; Tokens in DB nur als sha256; 21. Token-Request pro Minute von einer IP → 429.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): oauth device pairing`

---

### Task 9: Anfragen, Freigaben, Auto-Modus, Grants, Live-Events

**Files:**
- Create: `apps/server/src/requests/{service,automode,grants,events,routes}.ts`
- Test: `apps/server/test/requests.test.ts`, `apps/server/test/automode.test.ts`, `apps/server/test/events.test.ts`

**Interfaces:**
- Consumes: `canAccessVault`, `appendAudit`, `bearerAuth`/`requireUser`
- Produces:
  - `createRequest(ctx, { device, secretId, project, reason, delivery }): AccessRequestDto` – prüft Zugriff (404 sonst), Plaintext-Flag (`403 plaintext_not_allowed`), `expires_at = now + 5 min`; bei aktivem Auto-Modus für den Tresor sofort `approved`, `auto=true`, Audit `request.auto_approved`, sonst Audit `request.created` + Event
  - `decideRequest(ctx, { requestId, userId, decision: 'approve'|'deny' }): AccessRequestDto` – nur Besitzer des Geräts; prüft Tresorzugriff erneut; atomar `UPDATE … WHERE status='pending'`, sonst `409 already_decided`; bei Ablauf `410 expired`
  - `createUpdateRequest(ctx, { device, secretId, project, reason, meta?, value?, generate? }): AccessRequestDto` – `kind:'update'`; `allowPlaintextToAgent` in `meta` → 400 `field_not_allowed`; vorgeschlagener Wert wird sofort mit `seal` (AAD `req:${requestId}`) gespeichert bzw. bei `generate` serverseitig erzeugt; Auto-Modus wirkt wie bei `read`; bei Freigabe ruft `decideRequest` `applySecretChange` mit Device-Actor, Projekt und Grund auf und löscht `proposed_value_sealed`
  - `createRequest`, `createUpdateRequest`, `createSecret` (Device), `archiveSecret` rufen `touchProject`; `recordUsage` bei Freigabe (read und update), Anlegen und Archivieren
  - `createRequest`/`createUpdateRequest` auf archiviertes Secret → `409 secret_archived`; `cancelOpenForSecret(ctx, secretId)` setzt `pending` → `denied` (system, `meta.cause:'archived'`), löscht Grants, emittiert `request.updated`; als `onArchived`-Hook in `archiveSecret` verdrahtet
  - `AccessRequestDto` enthält `kind` und bei `update` `metaDiff` + `valueChanged: boolean` (nie den Wert)
  - `waitForRequest(ctx, requestId, deviceId, timeoutMs ≤ 60_000): Promise<AccessRequestDto>` – resolved bei Statuswechsel oder Timeout
  - `expireDue(ctx)` – Intervall alle 15 s, setzt `expired` + Audit
  - `getAutoMode(db, userId)`, `enableAutoMode(ctx, userId, minutes, vaultIds?)` (requireRecentAuth; `minutes` 1…`autoModeMaxMin`, sonst 400), `disableAutoMode(...)`; aktiv ⇔ `now < enabled_until`
  - `issueGrant(ctx, request): Grant` (bei approve + delivery `cli`; 15 min, `uses_left 1`)
  - `RequestEvents` (EventEmitter pro userId): Events `request.created|request.updated|automode.changed`
  - Routes: `GET /api/requests?status=pending`, `POST /api/requests/:id/decision`, `GET /api/events` (SSE, requireUser, Heartbeat 25 s), `GET/PUT/DELETE /api/automode`
- [ ] **Step 1: Tests**:
  - Anfrage ohne `project` oder `reason` → 400.
  - `delivery:'plaintext'` bei Secret ohne Flag → 403.
  - Freigabe durch fremden Nutzer → 403; durch Besitzer → approved + Grant mit 15 min.
  - **Zwei parallele `decideRequest` (approve + deny) → genau einer erfolgreich, der andere 409, genau ein Grant** (Review Focus 3).
  - **Besitzer verliert Tresormitgliedschaft nach Anfrage → Freigabe 403** (Review Focus 1).
  - Nach 5 min (FakeClock + `expireDue`) → `expired`, `decideRequest` → 410.
  - Auto-Modus 30 min an → Anfrage sofort `approved`, `auto=true`; **bei `now == enabled_until` → `pending`**; **neue `buildApp` auf derselben DB-Datei → Auto-Modus noch aktiv**; Auto-Modus auf Tresor X begrenzt → Anfrage aus Tresor Y bleibt `pending`; Dauer > `autoModeMaxMin` → 400.
  - Archivieren während offener Lese- und Update-Anfrage → beide `denied` mit `cause:'archived'`, `waitForRequest` resolved sofort; vorhandener Grant danach nicht mehr einlösbar.
  - Update-Anfrage: vor Freigabe bleibt `current_version` unverändert; nach Freigabe neue Version mit Device als Akteur sowie Projekt/Grund; nach Verweigerung keine neue Version und `proposed_value_sealed` gelöscht; im Auto-Modus sofort angewendet; DTO enthält nie den Wert.
  - `waitForRequest` resolved unmittelbar nach `decideRequest`; SSE-Stream liefert `request.created` an den Besitzer, nicht an andere Nutzer.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): approval engine, auto mode, grants, sse`

---

### Task 10: MCP-Endpoint

**Files:**
- Create: `apps/server/src/mcp/{server,tools}.ts`
- Test: `apps/server/test/mcp.test.ts` (mit `@modelcontextprotocol/sdk` Client über In-Process-Transport bzw. `app.inject`)

**Interfaces:**
- Consumes: `bearerAuth`, `searchSecrets`, `createRequest`, `waitForRequest`, `listVaultsForUser`, `open`
- Produces: `POST/GET/DELETE /mcp` (Streamable HTTP, stateless pro Request, Device aus Bearer). Tools (zod-Inputs; **jedes Tool außer `await_request` hat Pflichtfeld `project: string`**, Beschreibung: „Name des Git-Repos bzw. Arbeitsordners“, Server ruft `touchProject`):
  - `search_secrets { query: string; project; vault_id?: string; include_archived?: boolean }` (archivierte Treffer mit `archived.reason`; Secrets mit `project_usage` für dieses Projekt zuerst, Feld `used_by_this_project: true`; Audit mit Projekt) → Liste `SecretMeta` (Audit `secret.searched` mit `meta.query`)
  - `request_secret { secret_id; project; reason; delivery?: 'cli'|'plaintext' = 'cli' }` → `{ request_id, status, expires_at }` (+ Ergebnis wie unten, falls sofort approved)
  - `await_request { request_id }` → wartet ≤ 60 s; Ergebnis je Status:
    - `approved` + `cli`: `{ status, grant_id, env_name, expires_at, instructions: "Run: asm run --grant <id> -- <command>  |  asm write --grant <id> <file>" }`
    - `approved` + `plaintext`: `{ status, value }` + Audit `secret.plaintext_delivered`
    - `pending` → `{ status:'pending', hint:'Call await_request again' }`; `denied`/`expired` → Status
  - `create_secret { title; description; tags?; env_name?; vault_id?; project; reason; value?: string; generate?: { length; alphabet? } }` → `{ secret_id, version: 1 }` (sofort, ohne Freigabe)
  - `update_secret { secret_id; project; reason; title?; description?; tags?; env_name?; value?; generate? }` → `{ request_id, status, expires_at }`; Ergebnis über `await_request` (`approved` → `{ status, version }`)
  - Beschreibungen von `create_secret`/`update_secret`: `value` landet im Transkript; `generate` oder `asm set --from-env/--from-stdin` bevorzugen, wenn der Wert nicht ohnehin schon im Kontext ist
  - `archive_secret { secret_id; reason; project }` → `{ secret_id, archived_at }` (sofort, ohne Freigabe; Beschreibung nennt Beispiele für Gründe: ersetzt durch anderes Secret, Service entfernt, Token widerrufen)
  - `list_vaults { project }`, `whoami { project }` → Gerät, Nutzer, Auto-Modus-Status
  - Tool-Beschreibungen (Englisch, für den Agenten) sagen ausdrücklich: Begründung + Projekt angeben, `cli`-Delivery bevorzugen, Werte nie ausgeben/committen.
- [ ] **Step 1: Tests**: ohne Token → 401 mit `WWW-Authenticate`; `tools/list` enthält genau die 8 Tools (`search_secrets`, `request_secret`, `await_request`, `create_secret`, `update_secret`, `archive_secret`, `list_vaults`, `whoami`); `archive_secret` ohne `reason` → Fehler; jedes Tool außer `await_request` ohne `project` → Validierungsfehler; `search_secrets` mit `project:'Foo'` nach freigegebenem Abruf von Secret X in Projekt `foo` listet X zuerst mit `used_by_this_project: true`; `request_secret` auf archiviertes Secret → Fehler `secret_archived`; kein Tool zum Reaktivieren oder Löschen; `create_secret` mit `allow_plaintext_to_agent` im Input → Fehler `field_not_allowed` (Review Focus 5); `update_secret` → `pending`, nach Freigabe liefert `await_request` die neue Versionsnummer; Suche liefert keine Werte; Request → `pending`; nach `decideRequest` liefert `await_request` `grant_id` und **kein** `value`; Plaintext-Secret mit Flag liefert `value` und Audit-Eintrag; widerrufenes Gerät mitten in der Session → 401.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(server): mcp endpoint with secret tools`

---

### Task 11: Grant-Einlösung und CLI `asm`

**Files:**
- Modify: `apps/server/src/requests/grants.ts`, `apps/server/src/requests/routes.ts`
- Create: `apps/cli/src/index.ts`, `apps/cli/src/auth-store.ts`, `apps/cli/src/commands/*.ts`, `packages/shared/src/api-client.ts`
- Test: `apps/server/test/grants.test.ts`, `apps/cli/test/run.test.ts`, `apps/cli/test/write.test.ts`

**Interfaces:**
- Produces (Server):
  - `POST /api/grants/:id/redeem` (bearerAuth, nur kind `cli`) → `{ secrets: [{ envName, value }] }`; prüft gleicher Nutzer, nicht abgelaufen, `uses_left > 0`, Tresorzugriff; dekrementiert atomar; Audit `grant.redeemed` mit `meta.hostname`, sonst `grant.redeem_denied` + 403/410
  - `POST /api/cli/requests` (bearerAuth) = `createRequest` für CLI-Nutzung ohne Agent
  - `POST /api/cli/secrets/:id/archive {reason, project}` (bearerAuth) = `archiveSecret` mit Device-Actor
  - Grant-Einlösung für archiviertes Secret → 409 `secret_archived`
  - `POST /api/cli/secrets` (bearerAuth) = `createSecret` mit Device-Actor; `POST /api/cli/secrets/:id/update` = `createUpdateRequest`
- Produces (CLI, `commander`):
  - `asm login <url>` (Device-Flow: zeigt `user_code` + URL, pollt), speichert `{url, accessToken, refreshToken}` via `@napi-rs/keyring` (Service `asm`, Account = Host); Fallback-Datei `~/.config/asm/credentials.json` mit 0600 nur mit `--insecure-store`
  - `asm logout`, `asm search <query>`, `asm request <secretId> --project --reason [--wait]`
  - `asm run (--grant <id> | --secret <id>[=ENV]…) -- <cmd…>` → spawnt `cmd` mit zusätzlichen Env-Variablen (nur im Kindprozess), Exit-Code wird durchgereicht; `--secret` erstellt Anfrage und wartet auf Freigabe
  - `asm write --grant <id> <file>` → schreibt/merged `ENV=value`-Zeilen, Dateimodus 0600, Warnung auf stderr, falls `git check-ignore <file>` nicht greift
  - `asm set --new --title T --description D [--tags a,b] [--env NAME] [--vault ID] --project P --reason R (--from-stdin | --from-env VAR | --from-file F | --generate [LEN])` bzw. `asm set <secretId> --project P --reason R [Meta-Flags] [Wertquelle] [--wait]`; gibt nur ID/Version bzw. Anfrage-ID aus, nie den Wert
  - `asm archive <secretId> --reason R --project P`; `asm search --archived`
  - `--project` ist bei allen Befehlen optional mit Default `basename(git rev-parse --show-toplevel)`, sonst `basename(cwd)`
  - `asm mcp-config` → druckt `claude mcp add --transport http asm <url>/mcp`
  - automatischer Token-Refresh bei 401
- [ ] **Step 1: Tests (Server)**: Einlösung durch CLI-Gerät desselben Nutzers → Wert; **durch Gerät eines anderen Nutzers → 403 ohne Wert; zweite Einlösung → 410; nach 16 min → 410; nach Entzug der Tresormitgliedschaft → 403** (Review Focus 1, 4); MCP-Gerät (kind `mcp`) → 403.
- [ ] **Step 2: Tests (CLI)** mit gemocktem API-Client: `run` setzt `GITHUB_TOKEN` im Kind (`node -e "process.stdout.write(process.env.GITHUB_TOKEN)"`) und nicht in `process.env` des Elternprozesses; Exit-Code 3 des Kinds → CLI-Exit 3; `write` erzeugt Datei mit Modus `0o600`, ersetzt bestehende Zeile gleichen Namens, Warnung wenn nicht ignoriert; `set --new --from-env FOO` sendet den Wert von `FOO` und druckt ihn nicht auf stdout/stderr; `set` ohne Wertquelle und ohne Meta-Flags → Exit 2 mit Usage; ohne `--project` in einem Git-Repo `foo-bar` wird `project: 'foo-bar'` gesendet.
- [ ] **Step 3:** FAIL → **Step 4:** implementieren → **Step 5:** PASS
- [ ] **Step 6:** Commit `feat: grant redemption and asm cli`

---

### Task 12: Web-UI-Fundament und Design-Freigabe

**Files:**
- Create: `apps/web/` (Vite + React + TS), `apps/web/src/styles/tokens.css`, `apps/web/src/components/ui/{Button,Input,Dialog,Table,Badge,Kbd,Toast,Skeleton,CommandPalette,MonoChip}.tsx`, `apps/web/src/layout/{AppShell,Sidebar,Topbar,AutoModePill}.tsx`, `apps/web/src/lib/{api,sse,shortcuts}.ts`, Routen `setup`, `login`
- Modify: `apps/server/src/app.ts` (statische Auslieferung von `apps/web/dist` mit SPA-Fallback, CSP-Header)
- Test: `apps/web/src/**/*.test.tsx` (vitest + Testing Library)

**Interfaces:**
- Consumes: alle `/api/*`-Routen, `packages/shared` Schemas/Client
- Produces: `AppShell` mit Sidebar (Übersicht, Anfragen [Badge], Secrets, Projekte, Tresore, Geräte, Audit-Log, Einstellungen), Tresor-Umschalter oben links, `AutoModePill` (Bernstein, Countdown `mm:ss`), ⌘K-Palette, `useShortcut(key, handler)`, `useEvents()` (SSE mit Reconnect), Hell/Dunkel per `prefers-color-scheme` + Umschalter.

- [ ] **Step 0: Design-Freigabe (vor jedem UI-Code).** Skill `frontend-design` laden. 2–3 statische, klickbare HTML-Mockups (Anfragen-Dashboard, Audit-Log, Kopplungs-/Consent-Seite) in Hell und Dunkel nach Spec-Abschnitt „Visuelles Design“ bauen, dem Nutzer im Browser zeigen und Freigabe bzw. Änderungen einholen. Ergebnis (finale Tokens) in `tokens.css` übernehmen.
- [ ] **Step 1: Tests**: `AutoModePill` zeigt `29:59` eine Sekunde nach Aktivierung von 30 min und verschwindet bei 0; `CommandPalette` öffnet mit Meta+K und filtert; Login-Seite zeigt „Mit Passkey anmelden“ und Passwortformular; bei `needsSetup` leitet die App auf `/setup` um.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren (Tailwind v4 Tokens, Radix, lucide `strokeWidth={1.5}`, Geist via `@fontsource`) → **Step 4:** PASS; `pnpm --filter web build` ok
- [ ] **Step 5:** Commit `feat(web): design system, shell, auth pages`

---

### Task 13: Web-UI-Seiten

**Files:**
- Create: `apps/web/src/routes/{requests,secrets,projects,vaults,devices,audit,settings,connect,activate}.tsx` + zugehörige Komponenten (`RequestCard`, `SecretPanel`, `AuditRow`, `ReauthDialog`)
- Test: entsprechende `*.test.tsx`

**Interfaces:**
- Consumes: Task-12-Komponenten, API aus Tasks 5–11
- Produces:
  - **Anfragen**: `RequestCard` mit Satz „**{device}** möchte `{ENV|Titel}` für **{project}**“, Begründung kursiv, Zeitbalken bis `expires_at`, Buttons Verweigern (`D`) / Freigeben (`A`) für die fokussierte Karte; Live-Update per SSE; Browser-`Notification` bei neuer Anfrage, wenn Tab im Hintergrund und erlaubt; Auto-Modus-Steuerung (Dauer wählbar 15/30/60/120 min oder frei bis Maximum, optional Tresore)
  - **Anfragen** zeigen auch Änderungsanfragen: „**{device}** möchte `{ENV}` ändern“ mit Metadaten-Diff und Hinweis „Wert wird geändert“; neu von Agenten angelegte Secrets erscheinen im Aktivitäts-Feed
  - **Secrets**: Filter-Segment Aktiv / Archiviert / Alle (Default Aktiv); archivierte Einträge gedämpft mit Badge „Archiviert“ und Grund als Tooltip, Panel zeigt Archiv-Hinweis (wer, wann, Projekt, Grund) und Button „Reaktivieren“ (Re-Auth); „Archivieren“-Aktion mit Pflichtfeld Grund auch für Menschen; Liste mit Suche, Badge „von Agent“ bei agenten-angelegten Secrets, rechtes Panel zum Anlegen/Bearbeiten (Titel, Beschreibung, Tags, ENV-Name, Schalter „Klartext an Agenten erlauben“ mit Warnhinweis), „Anzeigen/Kopieren“ über `ReauthDialog`; Reiter **Verlauf** (`VersionTimeline`): Version, Zeit, Akteur, Projekt, Grund, Metadaten-Diff, „Wert anzeigen“ (Re-Auth) und „Wiederherstellen“ mit Bestätigung
  - **Projekte**: Tabelle (Name, zuletzt gesehen, Anzahl Secrets/Geräte), Detail mit genutzten Secrets, Geräten und letzten Audit-Einträgen (Filter Projekt), Aktion „Zusammenführen mit …“; im Secret-Panel Abschnitt „Genutzt von“ (Projekte + letzter Zugriff)
  - **Tresore**: anlegen, Mitglieder hinzufügen/entfernen
  - **Geräte**: Tabelle (Name, Typ, Host, zuletzt genutzt, Status), umbenennen, widerrufen
  - **Audit-Log**: Filterleiste (Gerät, Secret, Projekt, Ereignis, Zeitraum), Zeilen als Satz + Mono-Event-Code + IP + Zeit, aufklappbar mit Details (Projekt, Grund, Meta), CSV-Export (clientseitig aus geladenen Seiten oder `GET /api/audit.csv`), Badge „Kette intakt“ via `GET /api/audit/verify`
  - **Connect** (`/connect?req=`): Consent-Seite für MCP-Kopplung (Client-Name, Redirect-Ziel, Rechte-Liste, Gerätename editierbar, Freigeben/Verweigern)
  - **Activate** (`/activate`): Eingabe des `user_code` für CLI-Kopplung
  - **Einstellungen**: Passkeys verwalten, Passwort ändern, Nutzerverwaltung (Admin)
- [ ] **Step 1: Tests**: `RequestCard` ruft bei Taste `A` `decision:'approve'` auf; Zeitbalken-Breite proportional zur Restzeit; 409 vom Server zeigt Toast „Bereits entschieden“; Audit-Zeile zeigt Projekt und Grund; Reveal ohne Re-Auth öffnet `ReauthDialog`; Consent-Seite sendet `deny` bei „Verweigern“; Update-Karte zeigt Diff `Titel: alt → neu` und „Wert wird geändert“; Projekt-Detail listet Secrets mit letztem Zugriff, „Zusammenführen“ ruft `merge` mit Ziel-ID auf; Secret-Panel zeigt „Genutzt von“; Filter „Archiviert“ zeigt nur archivierte Secrets mit Grund; Archivieren-Dialog ohne Grund ist nicht absendbar; `VersionTimeline` zeigt Archiv-/Reaktivierungs-Ereignisse zwischen den Versionen und listet Versionen absteigend und ruft beim Wiederherstellen `restore` mit der gewählten Version auf.
- [ ] **Step 2:** FAIL → **Step 3:** implementieren → **Step 4:** PASS
- [ ] **Step 5:** Commit `feat(web): requests, secrets, vaults, devices, audit, settings`

---

### Task 14: Docker, Doku, End-to-End

**Files:**
- Create: `Dockerfile`, `.dockerignore`, `docker-compose.example.yml`, `README.md`, `apps/web/e2e/{flow,passkey}.spec.ts`, `playwright.config.ts`

**Interfaces:**
- Produces: Image `asm` (Multi-Stage `node:22-alpine`, `USER node`, `EXPOSE 8080`, `VOLUME /data`, `HEALTHCHECK` auf `/healthz`); Compose mit Docker-Secret `asm_master_key` → `ASM_MASTER_KEY_FILE=/run/secrets/asm_master_key` und auskommentierten Traefik-/Caddy-Labels; README: Setup, Key erzeugen, Reverse-Proxy-Hinweise, `asm login`, `claude mcp add`, Sicherheitsmodell (Hybrid-Übergabe, warum Klartext riskant ist).
- [ ] **Step 1: E2E-Tests (Playwright, gegen `pnpm start` mit Temp-Datenverzeichnis)**: Setup → Login mit Passwort → Passkey registrieren (CDP virtueller Authenticator) → Logout → Login mit Passkey; Secret anlegen; per API eine MCP-Anfrage simulieren → Karte erscheint live → `A` → Audit-Log zeigt `request.approved` mit Projekt und Grund; Auto-Modus 1 min aktivieren → Pill zählt herunter; per API als Gerät `update_secret` → Änderungskarte freigeben → Verlauf zeigt Version 2 mit Gerät, Projekt und Grund, alte Version lässt sich anzeigen und wiederherstellen.
- [ ] **Step 2:** FAIL → **Step 3:** Dockerfile/Compose/README/Fehlendes ergänzen → **Step 4:** `pnpm -r test && pnpm e2e` PASS; `docker build -t asm .` ok; `docker run` ohne Key → Exit ≠ 0 mit klarer Meldung; mit Key → `/healthz` 200
- [ ] **Step 5: Manuelle End-to-End-Prüfung mit Claude Code**: `claude mcp add --transport http asm http://localhost:8080/mcp` → Kopplung im Browser freigeben → Claude sucht und fordert Secret an → Freigabe → `asm run --grant … -- printenv GITHUB_TOKEN` zeigt Wert → `grep -r "<wert>" ~/.claude/projects/` findet nichts.
- [ ] **Step 6:** Commit `chore: docker image, compose example, e2e tests, readme`

---

## Nicht in diesem Plan
Phase 2 (Web Push mit VAPID, Service-Worker-Aktionen, signierte Einmal-Freigabe-Tokens) bekommt nach v1 einen eigenen Plan.
