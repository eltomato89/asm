import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PushSubscriptionDto } from '@asm/shared';
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
    expect(await screen.findByText("This browser doesn't support push notifications.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
    const list = await screen.findByRole('list', { name: 'Devices with notifications' });
    expect(list).toHaveTextContent('Mac');
    expect(list).toHaveTextContent('last');
  });

  it('on iPhone outside the home-screen app shows the install hint', async () => {
    setUA(UA_IPHONE);
    fakePush();
    mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [] } } : undefined));
    renderWithProviders(<PushSection />);
    expect(await screen.findByText('On iPhone/iPad (iOS 16.4 or later), first install via Share → Add to Home Screen and open it from there.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enable notifications' })).toBeNull();
  });

  it('on iPhone as home-screen app (standalone) shows the subscribe form', async () => {
    setUA(UA_IPHONE);
    fakePush();
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
    try {
      mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [] } } : undefined));
      renderWithProviders(<PushSection />);
      expect(await screen.findByRole('button', { name: 'Enable notifications' })).toBeInTheDocument();
      expect(screen.getByLabelText('Device name')).toHaveValue('iPhone');
      expect(screen.queryByText(/Add to Home Screen/)).toBeNull();
    } finally {
      delete (navigator as { standalone?: boolean }).standalone;
    }
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
    expect(await screen.findByText('No device receives notifications yet.')).toBeInTheDocument();
    expect(push.requestPermission).not.toHaveBeenCalled();
    const name = screen.getByLabelText('Device name');
    expect(name).toHaveValue('Mac');
    await u.clear(name);
    await u.type(name, 'MacBook');
    await u.click(screen.getByRole('button', { name: 'Enable notifications' }));

    await waitFor(() => expect(within(toasts()).getByText('Notifications enabled for “MacBook”.')).toBeInTheDocument());
    expect(push.requestPermission).toHaveBeenCalledTimes(1);
    expect(push.pushManager.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) });
    expect(calls.find((c) => c.path === '/api/push/subscriptions' && c.method === 'POST')?.body).toEqual({
      subscription: { endpoint: ENDPOINT, keys: { p256dh: 'p256-key', auth: 'auth-key' } },
      deviceName: 'MacBook',
    });
    const list = await screen.findByRole('list', { name: 'Devices with notifications' });
    expect(list).toHaveTextContent('MacBook · this browser');
    expect(list).toHaveTextContent('never used');
    expect(screen.getByText('This browser receives notifications.')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('asm-push-sub')!)).toEqual({ id: 'psh_9', endpoint: ENDPOINT });
  });

  it('a refused permission sends nothing to the server', async () => {
    setUA(UA_MAC);
    const push = fakePush({ permission: 'denied' });
    const { calls } = mockFetch((c) => (c.path === '/api/push/subscriptions' ? { body: { items: [] } } : undefined));
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    await u.click(await screen.findByRole('button', { name: 'Enable notifications' }));
    await waitFor(() => expect(within(toasts()).getByText('Notifications were not allowed.')).toBeInTheDocument());
    expect(push.pushManager.subscribe).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === 'POST' || c.path === '/api/push/vapid-key')).toBe(false);
    expect(screen.getByText(/Notifications are blocked for this site/)).toBeInTheDocument();
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
    expect(await screen.findByText('· this browser', { exact: false })).toBeInTheDocument();

    // Another device: only the server-side entry goes.
    await u.click(screen.getByRole('button', { name: 'Remove iPhone' }));
    await waitFor(() => expect(within(toasts()).getByText('“iPhone” no longer receives notifications.')).toBeInTheDocument());
    expect(push.browserSub.unsubscribe).not.toHaveBeenCalled();

    await u.click(screen.getByRole('button', { name: 'Remove Mac' }));
    await waitFor(() => expect(push.browserSub.unsubscribe).toHaveBeenCalledTimes(1));
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual(['/api/push/subscriptions/psh_2', '/api/push/subscriptions/psh_1']);
    expect(localStorage.getItem('asm-push-sub')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Enable notifications' })).toBeInTheDocument();
  });

  it('sends a test notification and reports the count', async () => {
    const { calls } = mockFetch((c) => {
      if (c.path === '/api/push/subscriptions') return { body: { items: [sub(), sub({ id: 'psh_2', deviceName: 'Mac' })] } };
      if (c.path === '/api/push/test' && c.method === 'POST') return { body: { sent: 2 } };
      return undefined;
    });
    const u = userEvent.setup();
    renderWithProviders(<PushSection />);
    await u.click(await screen.findByRole('button', { name: 'Send test' }));
    await waitFor(() => expect(within(toasts()).getByText('Test sent to 2 devices.')).toBeInTheDocument());
    expect(calls.filter((c) => c.path === '/api/push/test')).toHaveLength(1);
  });
});
