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

`src/assets/demo.mp4` / `demo.webm` (and `demo.gif` for the README) come from `demo/`. The page shows
`src/assets/demo-poster.webp` before the video plays and, with reduced motion, instead of it. After
changing the demo, regenerate the poster (needs ffmpeg; `DEMO_POSTER_AT=<seconds>` picks the frame,
default shortly before the end):

```sh
pnpm --filter @asm/site poster
```

## Screenshots

The images in `src/assets/screenshots/` are real screenshots of the web UI with sample data (no real
secrets). Regenerate them with:

```sh
pnpm exec playwright install chromium   # once
pnpm --filter @asm/site screenshots
```

`scripts/screenshots.ts` builds shared/server/web (`SITE_SHOTS_SKIP_BUILD=1` skips that), starts the
built server on a temp data dir with a test-only master key (port 18766 or `SITE_SHOTS_PORT`), creates
the admin `alex` through the setup API, a second user, the shared vaults "Infrastructure" and "Shop"
and a few secrets, pairs two simulated Claude Code devices through the real OAuth flow and lets them
search, request, propose a change, create and archive secrets over MCP. Some requests are approved or
denied, two stay pending. It then captures the requests page, the secrets list and the audit log at
1280×800 (2×) in light and dark and writes WebP. `SITE_SHOTS_KEEP=1` keeps the server running.

## Checks

```sh
SITE_BASE=/asm/ pnpm --filter @asm/site build
pnpm --filter @asm/site preview --port 4321 &
node apps/site/scripts/verify.ts http://localhost:4321/asm/ /tmp
```

`scripts/verify.ts` loads the page in Chromium (light/dark, 1440 px and 390 px) and fails on console
errors, failed requests, broken images, dangling `#anchors`, horizontal scrolling, images without
`alt` or more than 2 MiB transferred; it writes full-page screenshots to the given folder.
