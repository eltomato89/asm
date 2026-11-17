import './styles.css';

// Hero demo (src/assets/demo.mp4/.webm, poster demo-poster.webp): a short muted loop. With reduced
// motion it stops on the poster, which shows the finished run.
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const demo = document.querySelector<HTMLVideoElement>('video[data-demo]');
function applyMotion() {
  if (!demo) return;
  if (reducedMotion.matches) {
    demo.pause();
    demo.removeAttribute('autoplay');
    demo.controls = true;
  } else {
    demo.controls = false;
    void demo.play().catch(() => { /* autoplay refused: the poster stays */ });
  }
}
applyMotion();
reducedMotion.addEventListener('change', applyMotion);

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
