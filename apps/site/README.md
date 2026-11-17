# ASM website

The public single-page site, published with GitHub Pages at <https://eltomato89.github.io/asm/>.
Plain HTML (`index.html`) + Tailwind CSS 4 + a few lines of TypeScript (`src/main.ts`), built with Vite.
Colours and fonts follow the web UI (`apps/web/src/styles/tokens.css`, Geist Sans/Mono); light/dark follows the system.

```sh
pnpm --filter @asm/site dev                     # → http://localhost:5173/asm/
pnpm --filter @asm/site build                   # → apps/site/dist (base path /asm/)
SITE_BASE=/ pnpm --filter @asm/site build       # other base path (custom domain, preview at the root)
```

The site is not part of the root `pnpm build` (filtered out there), the CI build or the Docker image
(`apps/site` is in `.dockerignore`). `pnpm -r typecheck` does cover it.

## Deployment

`.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `apps/site/**`
(or the workflow), and on manual dispatch. One-time setup in the repository: Settings → Pages →
Source: **GitHub Actions**.

## Hero demo

The hero shows the demo from `demo/` in four variants, `src/assets/demo-{light,dark}-{desktop,mobile}`
(`.mp4`, `.webm` and a `.webp` still each). A `<picture>` picks the still by colour scheme and width
(mobile below 600 px), so it works without JavaScript and with reduced motion; `src/main.ts` plays the
matching loop on top of it and switches when the scheme or width changes.

## Screenshots

The images in `src/assets/screenshots/` are real screenshots of the web UI with sample data (no real
secrets). Regenerate them with:

```sh
pnpm exec playwright install chromium   # once
pnpm --filter @asm/site screenshots
```

`scripts/screenshots.ts` builds shared/server/web (`SITE_SHOTS_SKIP_BUILD=1` skips that) and starts the
built server on a temp data dir with a test-only master key as `https://asm.example.com`: a small HTTPS
proxy with a throwaway self-signed certificate (openssl) sits in front of it, and Chromium resolves
`asm.example.com` to that proxy (`--host-resolver-rules`). Ports 18766 and 18767, or `SITE_SHOTS_PORT`
and `SITE_SHOTS_PORT + 1`. While seeding, the server's clock (`Date.now`, through a preload controlled
over IPC) moves through the past day, so the UI shows realistic relative times and client IPs.

It creates the admin `alex` through the setup API, a second user, the shared vaults "Infrastructure"
and "Shop" and a few secrets, pairs two simulated Claude Code devices through the real OAuth flow and
lets them search, request, propose a change, create and archive secrets over MCP. Some requests are
approved or denied, two stay pending. It then captures the requests page, the secrets list and the
audit log at 1280×800 (2×) in light and dark and writes WebP; it fails if a page shows `localhost` or a
local port. `SITE_SHOTS_KEEP=1` keeps the server running.

## Checks

```sh
SITE_BASE=/asm/ pnpm --filter @asm/site build
pnpm --filter @asm/site preview --port 4321 &
node apps/site/scripts/verify.ts http://localhost:4321/asm/ /tmp
```

`scripts/verify.ts` loads the page in Chromium (light/dark, 1440 px and 390 px) and fails on console
errors, failed requests, broken images, dangling `#anchors`, horizontal scrolling, images without
`alt` or more than 2 MiB transferred; it writes full-page screenshots to the given folder.
