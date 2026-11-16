import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscriptionDto } from '../../lib/push-types';
import { T0 } from '../../test/fixtures';
import { mockFetch } from '../../test/utils';
import { renderWithProviders } from '../../test/utils';
import { PushSection } from './PushSection';

const ENDPOINT = 'https://push.example/sub/abc';
const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15';

const sub = (over: Partial<PushSubscriptionDto> = {}): PushSubscriptionDto => ({ id: 'psh_1', deviceName: 'iPhone', createdAt: T0, lastUsedAt: null, ...over });

/** Fake browser push stack: Notification, PushManager and a service worker registration. */
function fakePush(opts: { permission?: NotificationPermission; subscribed?: boolean } = {}) {
  const browserSub = {
    endpoint: ENDPOINT,
    options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer },
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p256-key', auth: 'auth-key' } }),
    unsubscribe: vi.fn(async () => {
      current = null;
      return true;
    }),
  };
  let current: typeof browserSub | null = opts.subscribed ? browserSub : null;
  const pushManager = {
    getSubscription: vi.fn(async () => current),
    subscribe: vi.fn(async (_o: PushSubscriptionOptionsInit) => {
      current = browserSub;
      return browserSub;
    }),
  };
  const reg = { pushManager };
  const sw = { register: vi.fn(async () => reg), getRegistration: vi.fn(async () => reg), ready: Promise.resolve(reg) };
  const requestPermission = vi.fn(async () => (opts.permission === 'denied' ? 'denied' : 'granted') as NotificationPermission);
  vi.stubGlobal('Notification', { permission: opts.permission ?? 'default', requestPermission });
  vi.stubGlobal('PushManager', class {});
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
  return { browserSub, pushManager, sw, requestPermission };
}

const setUA = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);

afterEach(() => {
  delete (navigator as { serviceWorker?: unknown }).serviceWorker;
  vi.restoreAllMocks();
});

const toasts = () => document.querySelector('.toasts') as HTMLElement;

describe('PushSection', () => {
  it('explains when the browser has no push support and still lists subscriptions', async () => {
    mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [sub({ deviceName: 'Mac', lastUsedAt: T0 })] } } : undefined));
    renderWithProviders(<PushSection />);
    expect(await screen.findByText('Dieser Browser unterstützt keine Push-Benachrichtigungen.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Benachrichtigungen aktivieren' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Geräte mit Benachrichtigungen' });
    expect(list).toHaveTextContent('Mac');
    expect(list).toHaveTextContent('zuletzt');
  });

  it('on iPhone outside the home-screen app shows the install hint', async () => {
    setUA(UA_IPHONE);
    fakePush();
    mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [] } } : undefined));
    renderWithProviders(<PushSection />);
    expect(await screen.findByText('Auf dem iPhone zuerst über Teilen → Zum Home-Bildschirm installieren und von dort öffnen.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Benachrichtigungen aktivieren' })).toBeNull();
  });

  it('subscribes on click: permission → VAPID key → pushManager.subscribe → POST', async () => {
    setUA(UA_MAC);
    const push = fakePush();
    let items: PushSubscriptionDto[] = [];
    const { calls } = mockFetch((c) => {
      if (c.path === '/api/push/subscriptions' && c.method === 'GET') return { body: { items } };
      if (c.path === '/api/push/vapid-key') return { body: { publicKey: 'AQID' } };
      if (c.path === '/api/push/subscriptions' && c.method === 'POST') {
        items = [sub({ id: 'psh_9', deviceName: (c.body as { deviceName: string }).deviceName })];
        return { status: 201, body: items[0] };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    expect(await screen.findByText('Noch kein Gerät erhält Benachrichtigungen.')).toBeInTheDocument();
    expect(push.requestPermission).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Gerätename');
    expect(name).toHaveValue('Mac');
    await u.clear(name);
    await u.type(name, 'MacBook');
    await u.click(screen.getByRole('button', { name: 'Benachrichtigungen aktivieren' }));

    await waitFor(() => expect(within(toasts()).getByText('Benachrichtigungen für „MacBook“ aktiviert.')).toBeInTheDocument());
    expect(push.requestPermission).toHaveBeenCalledTimes(1);
    expect(push.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(calls.find((c) => c.path === '/api/push/subscriptions' && c.method === 'POST')?.body).toEqual({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p256-key', auth: 'auth-key' } },
      deviceName: 'MacBook',
    });
    const list = await screen.findByRole('list', { name: 'Geräte mit Benachrichtigungen' });
    expect(list).toHaveTextContent('MacBook · dieser Browser');
    expect(list).toHaveTextContent('noch nie benutzt');
    expect(screen.getByText('Dieser Browser erhält Benachrichtigungen.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('asm-push-sub')!)).toEqual({ id: 'psh_9', endpoint: ENDPOINT });
  });

  it('a refused permission sends nothing to the server', async () => {
    setUA(UA_MAC);
    const push = fakePush({ permission: 'denied' });
    const { calls } = mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [] } } : undefined));
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    await u.click(await screen.findByRole('button', { name: 'Benachrichtigungen aktivieren' }));
    await waitFor(() => expect(within(toasts()).getByText('Benachrichtigungen wurden nicht erlaubt.')).toBeInTheDocument());
    expect(push.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'POST' || c.path === '/api/push/vapid-key')).toBe(false);
    expect(screen.getByText(/Benachrichtigungen sind für diese Seite blockiert/)).toBeInTheDocument();
  });

  it('removing this browser’s subscription also unsubscribes locally', async () => {
    setUA(UA_MAC);
    const push = fakePush({ permission: 'granted', subscribed: true });
    localStorage.setItem('asm-push-sub', JSON.stringify({ id: 'psh_1', endpoint: ENDPOINT }));
    let items = [sub({ deviceName: 'Mac' }), sub({ id: 'psh_2', deviceName: 'iPhone' })];
    const { calls } = mockFetch((c) => {
      if (c.path === '/api/push/subscriptions' && c.method === 'GET') return { body: { items } };
      if (c.path.startsWith('/api/push/subscriptions/') && c.method === 'DELETE') {
        items = items.filter((s) => `/api/push/subscriptions/${s.id}` !== c.path);
        return { body: {} };
      }
      return undefined;
    });
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    expect(await screen.findByText('· dieser Browser', { exact: false })).toBeInTheDocument();

    // Another device: only the server-side entry goes.
    await u.click(screen.getByRole('button', { name: 'iPhone entfernen' }));
    await waitFor(() => expect(within(toasts()).getByText('„iPhone“ erhält keine Benachrichtigungen mehr.')).toBeInTheDocument());
    expect(push.browserSub.unsubscribe).not.toHaveBeenCalled();

    await u.click(screen.getByRole('button', { name: 'Mac entfernen' }));
    await waitFor(() => expect(push.browserSub.unsubscribe).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/push/subscriptions/psh_2', '/api/push/subscriptions/psh_1']);
    expect(localStorage.getItem('asm-push-sub')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Benachrichtigungen aktivieren' })).toBeInTheDocument();
  });

  it('sends a test notification and reports the count', async () => {
    const { calls } = mockFetch((c) => {
      if (c.path === '/api/push/subscriptions') return { body: { items: [sub(), sub({ id: 'psh_2', deviceName: 'Mac' })] } };
      if (c.path === '/api/push/test' && c.method === 'POST') return { body: { sent: 2 } };
      return undefined;
    });
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    await u.click(await screen.findByRole('button', { name: 'Test senden' }));
    await waitFor(() => expect(within(toasts()).getByText('Test an 2 Geräte gesendet.')).toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/api/push/test')).toHaveLength(1);
  });
});
