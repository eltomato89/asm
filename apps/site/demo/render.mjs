#!/usr/bin/env node
// Renders apps/site/demo/index.html frame by frame (deterministic timeline) and encodes
//   apps/site/src/assets/demo.gif  (README, 880 px wide)
//   apps/site/src/assets/demo.mp4  (landing page, H.264)
//   apps/site/src/assets/demo.webm (landing page, VP9)
// Usage: node apps/site/demo/render.mjs [--fps 15] [--keep-frames]
// Needs Playwright's Chromium (root devDependency @playwright/test) and ffmpeg on PATH (or $FFMPEG).
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, '../src/assets');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const FPS = Number(opt('fps', 15));
const VIDEO_FPS = 30;
const SCALE = 2;
const W = 880, H = 500;
const ffmpeg = process.env.FFMPEG ?? 'ffmpeg';
const keep = args.includes('--keep-frames');

async function capture(dir, fps) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  await page.goto(`${pathToFileURL(join(here, 'index.html')).href}?static=1`);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.asmDemo.duration);
  const frames = Math.round(duration * fps);
  for (let i = 0; i < frames; i++) {
    await page.evaluate((t) => window.asmDemo.render(t), i / fps);
    await page.screenshot({ path: join(dir, `f${String(i).padStart(4, '0')}.png`), clip: { x: 0, y: 0, width: W, height: H } });
  }
  await browser.close();
  return frames;
}

const run = (...a) => execFileSync(ffmpeg, ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' });
const size = (f) => `${(statSync(f).size / 1024 / 1024).toFixed(2)} MB`;

const gifDir = mkdtempSync(join(tmpdir(), 'asm-demo-gif-'));
const vidDir = mkdtempSync(join(tmpdir(), 'asm-demo-vid-'));
try {
  const n = await capture(gifDir, FPS);
  console.log(`captured ${n} frames at ${FPS} fps`);
  const scale = `scale=${W}:-1:flags=lanczos`;
  run('-framerate', String(FPS), '-i', join(gifDir, 'f%04d.png'),
    '-vf', `${scale},split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle`,
    '-loop', '0', join(out, 'demo.gif'));
  console.log(`demo.gif ${size(join(out, 'demo.gif'))}`);

  await capture(vidDir, VIDEO_FPS);
  const vin = ['-framerate', String(VIDEO_FPS), '-i', join(vidDir, 'f%04d.png')];
  run(...vin, '-vf', 'scale=1760:-2:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'demo.mp4'));
  console.log(`demo.mp4 ${size(join(out, 'demo.mp4'))}`);
  run(...vin, '-vf', 'scale=1760:-2:flags=lanczos', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '34', '-row-mt', '1', join(out, 'demo.webm'));
  console.log(`demo.webm ${size(join(out, 'demo.webm'))}`);
} finally {
  if (keep) console.log(`frames kept in ${gifDir}`);
  else rmSync(gifDir, { recursive: true, force: true });
  rmSync(vidDir, { recursive: true, force: true });
}
