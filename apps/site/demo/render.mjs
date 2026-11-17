#!/usr/bin/env node
// Renders apps/site/demo/index.html frame by frame (deterministic timeline) in every variant and encodes, into
// apps/site/src/assets/:
//   demo-{light,dark}-{desktop,mobile}.mp4   H.264, 2x resolution, 30 fps (landing page)
//   demo-{light,dark}-{desktop,mobile}.webm  VP9, same
//   demo-{light,dark}-{desktop,mobile}.webp  poster: the approve page moment
//   demo.gif                                  light desktop, 880 px wide, 15 fps (README)
// Usage: node apps/site/demo/render.mjs [--only light-desktop,dark-mobile] [--keep-frames]
// Needs Playwright's Chromium (root devDependency @playwright/test) and ffmpeg on PATH (or $FFMPEG).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/assets');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const FPS = 30; // video frame rate; the GIF takes every second frame
const GIF_FPS = 15;
const SCALE = 2;
const POSTER_T = 7.0; // approve page open, request waiting
const LAYOUTS = { desktop: { w: 880, h: 580 }, mobile: { w: 390, h: 750 } };
const VARIANTS = ['light-desktop', 'dark-desktop', 'light-mobile', 'dark-mobile'];
const only = opt('only', null)?.split(',');
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const keep = args.includes('--keep-frames');

const run = (...a) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
const size = (f) => `${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`;

/** Captures all frames of one variant as PNGs (2x) and writes its WebP poster. */
async function capture(browser, theme, layout, dir, posterFile) {
  const { w, h } = LAYOUTS[layout];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: SCALE });
  await page.goto(`${pathToFileURL(join(here, 'index.html')).href}?static=1&theme=${theme}&layout=${layout}`);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.asmDemo.duration);
  const frames = Math.round(duration * FPS);
  const clip = { x: 0, y: 0, width: w, height: h };
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.asmDemo.render(t), i / FPS);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`), clip });
  }
  // Poster: Chromium's canvas encodes WebP, so no extra image tooling is needed.
  await page.evaluate((t) => window.asmDemo.render(t), POSTER_T);
  const png = (await page.screenshot({ clip })).toString('base64');
  const webp = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    return c.toDataURL('image/webp', 0.82).split(',')[1];
  }, png);
  writeFileSync(posterFile, Buffer.from(webp, 'base64'));
  await page.close();
  return frames;
}

const browser = await chromium.launch();
try {
  for (const variant of VARIANTS.filter((v) => !only || only.includes(v))) {
    const [theme, layout] = variant.split('-');
    const name = `demo-${variant}`;
    const dir = mkdtempSync(join(tmpdir(), `asm-${name}-`));
    try {
      const n = await capture(browser, theme, layout, dir, join(out, `${name}.webp`));
      const vin = ['-framerate', String(FPS), '-i', join(dir, 'f%04d.png')];
      run(...vin, '-c:v', 'libx264', '-preset', 'slow', '-crf', '22', '-tune', 'animation', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, `${name}.mp4`));
      run(...vin, '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '42', '-deadline', 'good', '-cpu-used', '2', '-row-mt', '1', '-pix_fmt', 'yuv420p', join(out, `${name}.webm`));
      console.log(`${name}: ${n} frames, mp4 ${size(join(out, `${name}.mp4`))}, webm ${size(join(out, `${name}.webm`))}, poster ${size(join(out, `${name}.webp`))}`);

      if (variant === 'light-desktop') {
        run(...vin, '-vf', `fps=${GIF_FPS},scale=${LAYOUTS.desktop.w}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
          '-loop', '0', join(out, 'demo.gif'));
        console.log(`demo.gif ${size(join(out, 'demo.gif'))}`);
      }
    } finally {
      if (keep) console.log(`frames kept in ${dir}`);
      else rmSync(dir, { recursive: true, force: true });
    }
  }
} finally {
  await browser.close();
}
