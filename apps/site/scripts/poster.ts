// Still frame of the hero demo (src/assets/demo.mp4) as src/assets/demo-poster.webp. The page shows it
// before the video plays and instead of it with reduced motion. Rerun after the demo changes:
//   pnpm --filter @asm/site poster        (needs ffmpeg; DEMO_POSTER_AT=<seconds> picks the frame)
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const assets = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/assets');
const video = path.join(assets, 'demo.mp4');
const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video], { encoding: 'utf8' }));
// Default: shortly before the end, where the demo has reached its final state.
const at = Number(process.env.DEMO_POSTER_AT ?? Math.max(0, duration - 0.6));
const png = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'], { maxBuffer: 64 * 1024 * 1024 });
await sharp(png).webp({ quality: 82, effort: 6 }).toFile(path.join(assets, 'demo-poster.webp'));
console.log(`wrote src/assets/demo-poster.webp (frame at ${at.toFixed(1)} s of ${duration.toFixed(1)} s)`);
