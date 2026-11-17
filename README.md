# ASM – Agent Secrets Manager

Deutsch: [README.de.md](README.de.md)

A self-hosted, multi-user secrets manager built for AI agents such as Claude Code.
Agents find secrets via MCP, request them with a project and a reason, and you approve each request in the
browser. By default the value never reaches the agent, only the process it starts.

- **Server** (`apps/server`): Fastify API, OAuth 2.1 for MCP clients, MCP endpoint `/mcp`, serves the web UI. SQLite.
- **Web UI** (`apps/web`): approve requests, manage secrets, vaults, devices, audit log. Available in English and
  German; it follows the browser language and can be switched under Settings → Language.
- **CLI** (`apps/cli`, command `asm`): hands approved secrets to commands or `.env` files.

## Security model

- **Hybrid delivery.** The agent requests a secret via MCP (`request_secret`, default `delivery: "cli"`).
  Once approved, it only receives a grant ID and calls `asm run --grant <id> -- <command>`: the CLI fetches
  the value and sets it as an environment variable for that process only. The value therefore never ends up in
  the conversation history or at the model provider. Grants are valid for 15 minutes and, by default, for a single use.
- **Plaintext is opt-in per secret.** `delivery: "plaintext"` only works if "Allow plaintext to agents" is enabled
  on the secret (default: off). A plaintext value then appears in the transcript, in logs and at the model
  provider – use it only for non-critical values. Agents can never change this setting.
- **Approvals.** Every request (read or change) waits for your decision (`A` / `D` in the UI) and expires
  after 5 minutes. **Auto mode** approves automatically for a limited time (default 30 min, at most
  `ASM_AUTO_MODE_MAX_MIN`) and for selected vaults – every auto-approval is recorded in the audit log.
- **What agents may do.** Create secrets (immediately), change them (only with approval), archive them (immediately,
  with a reason). Never delete, never restore.
- **Archive instead of delete.** Archived secrets no longer show up in searches and can be neither read nor
  changed; pending requests for them are denied. A human can restore them.
- **Versions.** Every change creates a new version with actor, project and reason. Old values remain
  viewable and can be restored.
- **Audit log** with a hash chain: each entry contains the hash of the previous one, so tampering is detectable
  (see limitations below).
- **Devices.** Every pairing (Claude Code, CLI) is a separate device that you approve in the browser and can
  revoke at any time. Refresh tokens rotate; reuse locks the device.
- **Deactivating accounts.** Admins can deactivate accounts in Settings (offboarding): the person is
  signed out, can no longer sign in, and all their devices are revoked.
- **Encryption.** AES-256-GCM, with a separate key per secret that is encrypted with the master key.
  Sensitive actions (reveal a value, pair a device, auto mode) require a sign-in no older than
  10 minutes. Sign in with password or passkey.

## Setup (Docker)

The image is based on `node:24-alpine`. Without Docker, the server needs Node.js ≥ 24 (LTS) and pnpm 11.

```sh
docker build -t asm .

# Generate the master key – back it up separately from the data! Without it, all secrets are lost.
# Separate directory (secrets/ is excluded in .gitignore and .dockerignore).
mkdir -p secrets && chmod 700 secrets
docker run --rm asm node apps/server/dist/scripts/generate-key.js > secrets/asm_master_key
chmod 600 secrets/asm_master_key
sudo chown 1000:1000 secrets/asm_master_key   # the container runs as user node (UID 1000) and must be able to read the file
```

Never commit the key or bake it into the image. Ideally keep it entirely outside the repo (then adjust the path
under `secrets.asm_master_key.file` in the Compose file).

Then copy `docker-compose.example.yml`, adjust `ASM_PUBLIC_URL` and start:

```sh
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml logs asm | grep "ASM setup token"
```

Open `ASM_PUBLIC_URL` in the browser, enter the setup token from the log and create the first account (admin).
Add more users under "Settings". You can also add a passkey there.

| Variable | Meaning | Default |
| --- | --- | --- |
| `ASM_PUBLIC_URL` | Public address (origin), required. Determines the passkey domain, OAuth issuer and origin check. | – |
| `ASM_MASTER_KEY_FILE` / `ASM_MASTER_KEY` | Master key (base64, 32 bytes) as a file or inline. If missing, the server exits with an error. | – |
| `ASM_TRUST_PROXY` | Behind a reverse proxy: number of proxy hops (usually `1`) or comma-separated IPs/CIDRs of the proxies. `true` trusts every `X-Forwarded-For` entry (spoofable, logs a warning) and is not allowed together with `ASM_TRUSTED_NETWORKS`. | `false` |
| `ASM_AUTO_MODE_MAX_MIN` | Maximum duration of auto mode. | `240` |
| `ASM_DATA_DIR` | Data directory (`asm.db`). | `/data` |
| `PORT` | HTTP port. | `8080` |
| `ASM_CLI_DIR` | Directory containing the CLI bundle (`asm.mjs`, `asm.json`) for `/cli/install.sh`. | Image: `/app/cli` |
| `ASM_TRUSTED_NETWORKS` | Comma-separated IPv4/IPv6 CIDRs (e.g. `192.168.0.0/16,100.64.0.0/10`). Clients outside these can only reach the approval page (see "Push approval from your iPhone"); everything else returns 404. Behind a proxy, only useful with `ASM_TRUST_PROXY=1` (or the proxy IPs). Never add the proxy or Docker network – otherwise every request through the proxy counts as internal. | empty = no restriction |
| `ASM_VAPID_SUBJECT` | Contact for Web Push services (`mailto:` or `https:`). A real address is recommended – Apple sometimes rejects placeholders. | `mailto:asm@localhost` |

## Reverse proxy

- TLS terminates at the proxy; ASM itself only speaks HTTP. Examples for Traefik and Caddy are included,
  commented out, in `docker-compose.example.yml`.
- `ASM_PUBLIC_URL` must be exactly the https origin under which browsers and agents reach ASM
  (e.g. `https://asm.example.com`, without a path). http is only allowed for `localhost`.
- Set `ASM_TRUST_PROXY=1` (one proxy hop; with several proxies, their count or the proxy IPs/CIDRs). Otherwise ASM only sees the proxy's IP, and the per-IP rate limits hit all
  users together. Then make the container port reachable only by the proxy.
- Passkeys need https and a domain name – an IP address does not work.
- Do not buffer live requests (server-sent events) and MCP long polls (up to ~50 s); keep timeouts ≥ 60 s.

## Push approval from your iPhone

When a request is waiting for approval, ASM sends a push notification to your devices. Tapping it opens a
small approval page: "Approve" (with Face ID) or "Deny". This works on the go even though ASM is not
publicly reachable – only the approval page is exposed.

**Setup (once, on your home network/VPN):**

1. Open ASM in Safari (`ASM_PUBLIC_URL`), sign in, Share → "Add to Home Screen" (iOS ≥ 16.4).
2. Launch ASM from the new icon, Settings → "Notifications" → "Enable", and allow.
3. "Send test" checks delivery. To approve, your account needs a passkey (Face ID).

ASM generates the VAPID keys itself on first start (private key stored in the DB, encrypted with the master key).

**Public paths:** `/approve/`, `/api/approve/`, `/assets/`, `/favicon.svg`, `/theme-init.js`, `/sw.js`,
`/manifest.webmanifest`, `/icons/icon-180.png`, `/icons/icon-192.png`, `/icons/icon-512.png`. Everything else only from
the home network/VPN. Use one hostname for inside and outside so that the same passkey works.

**Nginx Proxy Manager – option A (UI):**

- *Access Lists* → new list "Home network": under *Access* `allow 192.168.0.0/16` (and the VPN network if any), rest `deny`,
  no users, "Satisfy Any".
- *Proxy Host* `asm.example.de` → `http://asm:8080`, SSL enabled, *Access List* = "Home network".
- *Custom Locations* without an access list, same target (`asm`, `8080`): `/approve/`, `/api/approve/`, `/assets/`,
  `/favicon.svg`, `/theme-init.js`, `/sw.js`, `/manifest.webmanifest`, `/icons/`. For `/approve/` and `/api/approve/`
  enter `access_log off;` in the gear field (the links contain one-time tokens).
- Test over mobile data: `https://asm.example.de/` must return 403, an approval link must work. If the
  access list in your NPM version also applies to the custom locations, use option B.

**Option B (*Advanced* tab of the proxy host, no access list on the host):**

```nginx
location ~ ^/(api/)?approve/ {
  access_log off;        # links contain one-time tokens
  include conf.d/include/proxy.conf;
}
location ~ ^/(assets/|favicon\.svg$|theme-init\.js$|sw\.js$|manifest\.webmanifest$|icons/icon-(180|192|512)\.png$) {
  include conf.d/include/proxy.conf;
}
location / {
  allow 192.168.0.0/16;
  allow 100.64.0.0/10;   # e.g. Tailscale
  deny all;
  proxy_buffering off;   # live requests (SSE)
  proxy_read_timeout 120s;
  include conf.d/include/proxy.conf;
}
```

Also set `ASM_TRUST_PROXY=1` and `ASM_TRUSTED_NETWORKS=192.168.0.0/16,100.64.0.0/10`: ASM itself then blocks
all other paths for foreign IPs as well (a second safeguard in case the proxy is misconfigured). With
`ASM_TRUST_PROXY=1`, only the `X-Forwarded-For` entry appended by the proxy counts – entries sent by the client
are ignored. The proxy or Docker network (e.g. `172.16.0.0/12`) does **not** belong in `ASM_TRUSTED_NETWORKS`.

**Security:**

- The notification text is neutral ("New request waiting for approval"), with no secret, project or reason.
  The content is end-to-end encrypted (Web Push); Apple only sees the target and the time.
- Every link contains a one-time token (stored only as SHA-256). It is valid only for that request, only while it
  is pending, and becomes worthless after a decision – whether made via the link or in the dashboard.
- "Approve" requires a passkey of the owner with user verification (Face ID/device PIN). "Deny" works
  without one. No session, no cookie, no secret values; 30 calls per minute and IP.
- Push subscriptions are only accepted for known push services (Apple, Google FCM, Mozilla, Windows).
- ASM does not write the tokens to its log. The proxy's access logs, however, do contain the links – turn them off for `/approve/` and
  `/api/approve/` (see above).
- Decisions appear in the audit log as usual (`request.approved`/`request.denied`) with `via: push`.

## Connecting Claude Code

```sh
claude mcp add --transport http asm https://asm.example.com/mcp
```

On first use, Claude Code opens the browser: sign in, check the pairing, "Approve". After that, Claude can
search secrets (`search_secrets`), request them (`request_secret` + `await_request`), create them, propose
changes and archive them. `asm mcp-config` prints the matching command for your server.

## CLI

Install directly from your own ASM server (requires Node ≥ 22.12 plus `curl` or `wget`; no sudo,
no GitHub or npm access needed):

```sh
curl -fsSL https://asm.example.com/cli/install.sh | sh
# without curl:  wget -qO- https://asm.example.com/cli/install.sh | sh
asm login https://asm.example.com
```

The script downloads the CLI bundle (`/cli/asm.mjs`), verifies SHA-256 and size against `/cli/asm.json` (this
requires `sha256sum`, `shasum` or `openssl`) and installs it to `~/.local/share/asm/asm.mjs`
(different location: `ASM_HOME`). The command `~/.local/bin/asm` (different directory: `ASM_INSTALL_DIR`) is created
as a symlink to it; the `.mjs` extension ensures Node always loads the file as an ES module. An
existing `asm` – including a symlink to a repo build – is replaced. If the directory is not on the
`PATH`, the script prints a hint. Example with custom paths:

```sh
curl -fsSL https://asm.example.com/cli/install.sh | ASM_HOME=/opt/asm ASM_INSTALL_DIR=$HOME/bin sh
```

This way the CLI version always matches the server version; `asm update` later fetches the current bundle from the server
(also hash-verified), and `asm --version` shows the installed version. To uninstall, remove both:
`rm ~/.local/bin/asm ~/.local/share/asm/asm.mjs`.

The CLI stores tokens in the OS keychain: on macOS in the Keychain (`security`), on Linux via
`secret-tool` (libsecret, e.g. package `libsecret-tools`). If neither is available (e.g. on a
server without a desktop session), `asm --insecure-store login …` stores the tokens in a file with
permissions 0600 instead.

For developers – build from the repo:

```sh
pnpm install
pnpm --filter @asm/shared build && pnpm --filter @asm/cli build
ln -s "$PWD/apps/cli/dist/index.js" ~/.local/bin/asm     # directory must be on the PATH
```

The build is plain JavaScript (no `tsx`, no type stripping); `node apps/cli/dist/index.js` works
too. `pnpm --filter @asm/cli bundle` creates the single-file bundle `apps/cli/dist-bundle/asm.mjs` (+ `asm.json`),
which a locally started server serves automatically under `/cli/` (otherwise set `ASM_CLI_DIR`).

Usage:

```sh
asm login https://asm.example.com          # pair device (approve in browser), tokens in the OS keychain
asm search github                           # metadata only
asm run --grant grt_… -- npm run deploy     # value only for this process, as an env variable
asm run --secret sec_… --reason "Deploy" -- ./deploy.sh   # request, wait for approval, run
asm write --grant grt_… .env                # write to a dotenv file (0600, merged)
asm set --new --title "Stripe Key" --description "Stripe live API (payments)" --env STRIPE_KEY \
  --reason "new project" --from-env STRIPE_KEY
asm set sec_… --reason "Key rotated" --from-stdin --wait   # propose a change (needs approval)
asm archive sec_… --reason "replaced by sec_…"
```

The project defaults to the name of the Git repo or folder (`--project` overrides it).

### Notes on dotenv files (`asm write`)

- Values are wrapped in double quotes; `\`, `"`, `$` and `` ` `` are escaped with `\`.
- Line breaks are written as a literal `\n`. When sourced via `sh` (`set -a; . ./.env`), this becomes
  a backslash followed by `n`, not a line break.
- The npm package `dotenv` converts `\n` into a line break but keeps `\$` and `` \` `` literally.
  For values containing these characters, prefer `asm run`.

## Development

Requirements: Node.js ≥ 24 (LTS), pnpm 11 (version from `packageManager` in `package.json`).

```sh
pnpm install
pnpm test          # unit and integration tests for all packages (vitest)
pnpm typecheck
pnpm build         # shared → dist, server → dist (incl. SQL migrations), web → dist, cli → dist
pnpm e2e           # Playwright against the built server (once: pnpm exec playwright install chromium)
```

Server in dev mode (TypeScript directly, `@asm/shared` from source via the `development` export condition):

```sh
cd apps/server
ASM_PUBLIC_URL=http://localhost:5173 ASM_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  ASM_DATA_DIR=./.data pnpm dev
```

Web UI with Vite: `pnpm --filter @asm/web dev` (port 5173). Vite proxies `/api`, `/oauth`, `/.well-known` and
`/mcp` to `http://localhost:8080` (different server: `ASM_DEV_SERVER`). For this, the server must run with
`ASM_PUBLIC_URL=http://localhost:5173`, otherwise the origin check and passkeys fail.

`pnpm --filter @asm/server start` starts the built server (`node dist/main.js`).

## CI & releases

GitHub Actions (`.github/workflows/`):

- **CI** (`ci.yml`) – on every push to `main` and every pull request: typecheck, unit tests, web build,
  CLI bundle, then Playwright e2e (report/traces as an artifact on failure). Newer PR pushes cancel
  running runs.
- **Docker** (`docker.yml`) – builds `ghcr.io/eltomato89/asm` for `linux/amd64` and pushes it to the
  GitHub Container Registry:
  - after successful CI on `main` → `edge` and `sha-<short>`
  - on tag `vX.Y.Z` (tests run first in the same workflow) → `X.Y.Z`, `X.Y`, `latest`
  - manually via "Run workflow" (`workflow_dispatch`) – only from `main` or a `v*` tag
  - prerelease tags (`v1.0.0-rc.1`) only get `1.0.0-rc.1`, no `X.Y`/`latest`
- **Dependabot** – weekly updates for Actions and npm (minor/patch grouped).

No additional secrets needed: the push uses the automatic `GITHUB_TOKEN` (`packages: write`).

New GHCR packages are private by default. The label `org.opencontainers.image.source` links the package
to the repo (access permissions are inherited from the repo, visibility is not). The server therefore has to log in before
pulling – with a personal access token (classic) with scope `read:packages`:

```sh
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
docker pull ghcr.io/eltomato89/asm:latest
```

Alternatively, make the package public in its settings on GitHub ("Package settings" → "Change visibility").

Release:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

Note: Actions minutes are limited for private repos; only `linux/amd64` is built (the build cache via `type=gha`
speeds up subsequent builds). For arm64, add it to `platforms` in `docker.yml` and re-add
`docker/setup-qemu-action`.

## Backup

- Back up `/data/asm.db` (while running, e.g. with `sqlite3 /data/asm.db ".backup /backup/asm.db"`,
  since SQLite runs in WAL mode).
- Back up the master key **separately**. The database is worthless without the key, and so is the key without the database.

## Limitations (v1)

- **Single instance only.** Live events (SSE), in-progress OAuth authorizations and WebAuthn challenges are kept in
  memory; no horizontal scaling, and a restart aborts pairings in progress.
- **Projects are global.** Project names (slugs) are shared by all users of the instance. Merging two projects
  changes the mapping for everyone: the old name then points to the target project, including for
  other users' agents that use the same name. Merging is only possible if you can see all affected
  usages.
- **Hash chain with a gap at the end.** The hash chain detects modified or deleted entries in the middle of the
  log, but not the deletion of the *last* entries: anyone with write access to the database can cut off the end
  without the chain check in the audit log noticing. For tamper-evident records, export the log regularly
  (CSV) or record the latest hash externally.
- **No push notifications.** Web Push (VAPID) and approving directly from the notification are coming in
  phase 2. Until then: keep the tab open (browser notifications can be enabled in the UI).
