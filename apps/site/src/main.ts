import './styles.css';
import darkDesktopMp4 from './assets/demo-dark-desktop.mp4';
import darkDesktopWebm from './assets/demo-dark-desktop.webm';
import darkMobileMp4 from './assets/demo-dark-mobile.mp4';
import darkMobileWebm from './assets/demo-dark-mobile.webm';
import lightDesktopMp4 from './assets/demo-light-desktop.mp4';
import lightDesktopWebm from './assets/demo-light-desktop.webm';
import lightMobileMp4 from './assets/demo-light-mobile.mp4';
import lightMobileWebm from './assets/demo-light-mobile.webm';

// Hero demo: the <picture> shows the still for the visitor's colour scheme and layout (also without
// JS and with reduced motion). The matching loop plays on top of it and fades in once it runs.
const DEMO = {
  light: { desktop: [lightDesktopMp4, lightDesktopWebm], mobile: [lightMobileMp4, lightMobileWebm] },
  dark: { desktop: [darkDesktopMp4, darkDesktopWebm], mobile: [darkMobileMp4, darkMobileWebm] },
} as const;
const dark = matchMedia('(prefers-color-scheme: dark)');
const mobile = matchMedia('(max-width: 599px)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const video = document.querySelector<HTMLVideoElement>('video[data-demo]');
let current = '';

function updateDemo() {
  if (!video) return;
  if (reducedMotion.matches) {
    video.pause();
    video.style.opacity = '0';
    return;
  }
  const [mp4, webm] = DEMO[dark.matches ? 'dark' : 'light'][mobile.matches ? 'mobile' : 'desktop'];
  if (mp4 !== current) {
    current = mp4;
    video.style.opacity = '0';
    video.replaceChildren(...([[mp4, 'video/mp4'], [webm, 'video/webm']] as const).map(([src, type]) => {
      const source = document.createElement('source');
      source.src = src;
      source.type = type;
      return source;
    }));
    video.load();
  }
  void video.play().catch(() => { /* autoplay refused: the still stays */ });
}
video?.addEventListener('playing', () => { video.style.opacity = '1'; });
updateDemo();
for (const q of [dark, mobile, reducedMotion]) q.addEventListener('change', updateDemo);

const year = document.querySelector('[data-year]');
if (year) year.textContent = String(new Date().getFullYear());

// Copy buttons on the code blocks (comment lines are left out).
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  button.hidden = !navigator.clipboard;
  button.addEventListener('click', async () => {
    const code = button.closest('figure')?.querySelector('code')?.textContent ?? '';
    const text = code.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n').trim();
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
}
