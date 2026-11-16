// Loads public/sw.js into a fake ServiceWorkerGlobalScope and drives its event handlers.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const SOURCE = readFileSync(resolve(__dirname, '../public/sw.js'), 'utf8');
const ORIGIN = 'https://asm.example.de';

type Client = { url: string; focus: ReturnType<typeof vi.fn>; navigate: ReturnType<typeof vi.fn> };

function loadWorker(clients: Client[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = fn;
    },
    skipWaiting: vi.fn(),
    registration: { showNotification: vi.fn(async () => undefined) },
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clients),
      openWindow: vi.fn(async () => null),
    },
  };
  runInNewContext(SOURCE, { self, URL, Promise });

  async function dispatch(type: string, init: Record<string, unknown>) {
    const pending: Promise<unknown>[] = [];
    handlers[type]!({ ...init, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  }
  const push = (payload: unknown) =>
    dispatch('push', { data: payload === null ? null : { text: () => (typeof payload === 'string' ? payload : JSON.stringify(payload)) } });
  const click = (data: unknown) => {
    const notification = { data, close: vi.fn() };
    return dispatch('notificationclick', { notification }).then(() => notification);
  };
  return { self, handlers, push, click };
}

const client = (url: string): Client => ({
  url,
  focus: vi.fn(async function (this: Client) {
    return this;
  }),
  navigate: vi.fn(async () => null),
});

describe('service worker', () => {
  it('registers push, notificationclick, install and activate handlers only (no fetch/caching)', () => {
    const { handlers } = loadWorker();
    expect(Object.keys(handlers).sort()).toEqual(['activate', 'install', 'notificationclick', 'push']);
  });

  it('shows the notification from the JSON payload with tag, icon and target URL', async () => {
    const w = loadWorker();
    await w.push({ title: 'ASM', body: 'Neue Anfrage wartet auf Freigabe', url: '/approve/tok_1', tag: 'req_1' });
    expect(w.self.registration.showNotification).toHaveBeenCalledWith('ASM', {
      body: 'Neue Anfrage wartet auf Freigabe',
      icon: '/icons/icon-192.png',
      tag: 'req_1',
      data: { url: '/approve/tok_1' },
    });
  });

  it.each([null, 'not json', { title: 42 }])('falls back to neutral text for payload %j', async (payload) => {
    const w = loadWorker();
    await w.push(payload);
    expect(w.self.registration.showNotification).toHaveBeenCalledWith('ASM', { body: 'Neue Benachrichtigung', icon: '/icons/icon-192.png', data: { url: '/' } });
  });

  it.each(['https://evil.example/approve/x', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', '/.//evil.example', 'approve/x'])(
    'only accepts same-origin relative URLs (%s → /)',
    async (url) => {
      const w = loadWorker();
      await w.push({ title: 'ASM', body: 'x', url });
      expect(w.self.registration.showNotification).toHaveBeenCalledWith('ASM', expect.objectContaining({ data: { url: '/' } }));
    },
  );

  it('notificationclick focuses an open ASM window and navigates it', async () => {
    const other = client('https://other.example/');
    const mine = client(`${ORIGIN}/settings`);
    const w = loadWorker([other, mine]);
    const n = await w.click({ url: '/approve/tok_1' });
    expect(n.close).toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
    expect(mine.focus).toHaveBeenCalled();
    expect(mine.navigate).toHaveBeenCalledWith('/approve/tok_1');
    expect(w.self.clients.openWindow).not.toHaveBeenCalled();
  });

  it('notificationclick opens a new window without an open client', async () => {
    const w = loadWorker([]);
    await w.click({ url: '/approve/tok_1' });
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('/approve/tok_1');
  });

  it('falls back to openWindow when navigating the client fails, and sanitizes the URL', async () => {
    const mine = client(`${ORIGIN}/`);
    mine.navigate.mockRejectedValueOnce(new TypeError('not controlled'));
    const w = loadWorker([mine]);
    await w.click({ url: 'https://evil.example/' });
    expect(mine.navigate).toHaveBeenCalledWith('/');
    expect(w.self.clients.openWindow).toHaveBeenCalledWith('/');
  });
});
