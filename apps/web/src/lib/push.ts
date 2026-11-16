// Browser side of Web Push: service worker registration, support detection and the subscribe/unsubscribe steps.

export const SW_URL = '/sw.js';
const LOCAL_KEY = 'asm-push-sub';

/** Registers /sw.js for the whole origin; silently does nothing where service workers are unavailable. */
export function registerServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // The public approve page (reachable from outside) needs no worker; registering there would be pointless traffic.
  if (window.location.pathname.startsWith('/approve/')) return;
  navigator.serviceWorker.register(SW_URL, { scope: '/' }).catch(() => {
    // Not fatal: push is optional (e.g. blocked by the browser or served without https).
  });
}

export const isIOS = (): boolean => {
  const ua = navigator.userAgent;
  // iPadOS reports a Mac user agent; touch points tell them apart.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
};

const isStandalone = (): boolean =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);

export type PushSupport = 'supported' | 'ios-install' | 'unsupported';

/** iOS only offers Web Push to home-screen apps; elsewhere the three APIs must exist. */
export function pushSupport(): PushSupport {
  if (isIOS() && !isStandalone()) return 'ios-install';
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return 'supported';
}

/** Default device name for a new subscription ("iPhone", "Mac", …). */
export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'Browser';
}

/** base64url → bytes (VAPID public key for applicationServerKey). */
export function base64UrlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const sameBytes = (a: ArrayBuffer | null | undefined, b: Uint8Array): boolean => {
  if (!a || a.byteLength !== b.length) return false;
  const x = new Uint8Array(a);
  return x.every((v, i) => v === b[i]);
};

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration('/');
  if (!existing) await navigator.serviceWorker.register(SW_URL, { scope: '/' });
  return navigator.serviceWorker.ready;
}

/** This browser's current push subscription, or null. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'supported') return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Subscribes this browser with the server's VAPID key (reuses a subscription made with the same key). */
export async function subscribeBrowser(publicKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } }> {
  const reg = await registration();
  const key = base64UrlToBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameBytes(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error('incomplete_subscription');
  return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
}

export async function unsubscribeBrowser(): Promise<void> {
  const sub = await currentSubscription();
  if (sub) await sub.unsubscribe();
}

/** Which server-side subscription belongs to this browser (the DTO carries no endpoint). */
export type LocalSubscription = { id: string; endpoint: string };

export function loadLocalSubscription(): LocalSubscription | null {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    const v: unknown = raw ? JSON.parse(raw) : null;
    if (v && typeof v === 'object' && typeof (v as LocalSubscription).id === 'string' && typeof (v as LocalSubscription).endpoint === 'string') return v as LocalSubscription;
  } catch {
    // ignore
  }
  return null;
}

export function saveLocalSubscription(v: LocalSubscription | null): void {
  try {
    if (v) localStorage.setItem(LOCAL_KEY, JSON.stringify(v));
    else localStorage.removeItem(LOCAL_KEY);
  } catch {
    // ignore
  }
}
