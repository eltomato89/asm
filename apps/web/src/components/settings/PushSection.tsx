import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { t } from '../../i18n';
import { api, queryKeys } from '../../lib/api';
import { errorText } from '../../lib/errors';
import {
  currentSubscription,
  guessDeviceName,
  loadLocalSubscription,
  pushSupport,
  saveLocalSubscription,
  subscribeBrowser,
  unsubscribeBrowser,
  type LocalSubscription,
} from '../../lib/push';
import type { PushSubscriptionDto } from '@asm/shared';
import { RelativeTime } from '../RelativeTime';
import { Button, IconButton } from '../ui/Button';
import { Input } from '../ui/Input';
import { Skeleton } from '../ui/Skeleton';
import { useToast } from '../ui/Toast';

class PermissionDenied extends Error {
  constructor() {
    super('permission_denied');
    this.name = 'PermissionDenied';
  }
}

function enableError(e: unknown): string {
  if (e instanceof PermissionDenied) return t.settings.push.notAllowed;
  if (e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'AbortError')) return t.settings.push.notAllowed;
  return errorText(e, t.settings.push.enableFailed);
}

/** The local record only counts while this browser still holds a subscription with the same endpoint. */
async function activeLocal(): Promise<LocalSubscription | null> {
  const local = loadLocalSubscription();
  if (!local) return null;
  try {
    const sub = await currentSubscription();
    return sub && sub.endpoint === local.endpoint ? local : null;
  } catch {
    return null;
  }
}

/** Settings → Notifications: enable Web Push for this browser, list and remove subscriptions, send a test. */
export function PushSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const support = pushSupport();
  const subs = useQuery({ queryKey: queryKeys.pushSubscriptions, queryFn: api.pushSubscriptions });
  const [deviceName, setDeviceName] = useState(guessDeviceName);
  const [local, setLocal] = useState<LocalSubscription | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(() => ('Notification' in window ? Notification.permission : null));

  useEffect(() => {
    let alive = true;
    void activeLocal().then((l) => alive && setLocal(l));
    return () => {
      alive = false;
    };
  }, []);

  const enable = useMutation({
    mutationFn: async ({ name, permission: asked }: { name: string; permission: Promise<NotificationPermission> }) => {
      const result = await asked;
      setPermission(result);
      if (result !== 'granted') throw new PermissionDenied();
      const { publicKey } = await api.pushVapidKey();
      const subscription = await subscribeBrowser(publicKey);
      const dto = await api.addPushSubscription({ subscription, deviceName: name });
      return { dto, endpoint: subscription.endpoint };
    },
    onSuccess: ({ dto, endpoint }) => {
      const l = { id: dto.id, endpoint };
      saveLocalSubscription(l);
      setLocal(l);
      void qc.invalidateQueries({ queryKey: queryKeys.pushSubscriptions });
      toast(t.settings.push.enabled(dto.deviceName), 'ok');
    },
    onError: (e) => toast(enableError(e), 'danger'),
  });

  const remove = useMutation({
    mutationFn: async (s: PushSubscriptionDto) => {
      await api.deletePushSubscription(s.id);
      if (local?.id === s.id) {
        saveLocalSubscription(null);
        setLocal(null);
        await unsubscribeBrowser().catch(() => {});
      }
    },
    onSuccess: (_v, s) => {
      void qc.invalidateQueries({ queryKey: queryKeys.pushSubscriptions });
      toast(t.settings.push.removed(s.deviceName), 'ok');
    },
    onError: (e) => toast(errorText(e, t.settings.push.removeFailed), 'danger'),
  });

  const test = useMutation({
    mutationFn: api.pushTest,
    onSuccess: ({ sent }) =>
      toast(sent === 0 ? t.settings.push.noneSent : t.settings.push.testSent(sent), sent === 0 ? 'info' : 'ok'),
    onError: (e) => toast(errorText(e, t.settings.push.testFailed), 'danger'),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const name = deviceName.trim();
    if (!name) return;
    // Ask synchronously inside the click: Safari only shows the prompt during the user gesture.
    enable.mutate({ name, permission: Notification.requestPermission() });
  };

  const items = subs.data?.items ?? [];
  const thisBrowserActive = local !== null && items.some((s) => s.id === local.id);

  return (
    <section className="settings-sec" aria-labelledby="s-push">
      <div className="settings-text">
        <h2 id="s-push">{t.settings.push.title}</h2>
        <p>{t.settings.push.lede}</p>
      </div>
      <div className="settings-body">
        {subs.isPending ? (
          <Skeleton width="100%" height={40} />
        ) : subs.isError ? (
          <p className="faint">{t.settings.push.loadFailed}</p>
        ) : items.length === 0 ? (
          <p className="faint">{t.settings.push.empty}</p>
        ) : (
          <ul className="mini-list" aria-label={t.settings.push.listLabel}>
            {items.map((s) => (
              <li key={s.id}>
                <span>
                  {s.deviceName}
                  {local?.id === s.id ? <span className="faint">{t.settings.push.thisBrowser}</span> : null}
                </span>
                <span className="faint">
                  {t.settings.push.addedAt}
                  <RelativeTime ts={s.createdAt} />
                </span>
                <span className="faint">
                  {s.lastUsedAt ? (
                    <>
                      {t.settings.push.lastUsed}
                      <RelativeTime ts={s.lastUsedAt} />
                    </>
                  ) : (
                    t.settings.push.neverUsed
                  )}
                </span>
                <IconButton label={t.settings.push.removeLabel(s.deviceName)} className="icon-btn-sm" disabled={remove.isPending} onClick={() => remove.mutate(s)}>
                  <Trash className="icon icon-sm" strokeWidth={1.5} aria-hidden />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        {support === 'ios-install' ? (
          <p className="help">{t.settings.push.iosInstall}</p>
        ) : support === 'unsupported' ? (
          <p className="help">{t.settings.push.unsupported}</p>
        ) : thisBrowserActive ? (
          <p className="help">{t.settings.push.active}</p>
        ) : (
          <>
            <form className="inline-form" onSubmit={submit}>
              <Input label={t.settings.push.deviceName} maxLength={100} value={deviceName} onChange={(e) => setDeviceName(e.target.value)} />
              <Button type="submit" disabled={enable.isPending || !deviceName.trim()}>
                {t.settings.push.enable}
              </Button>
            </form>
            {permission === 'denied' ? (
              <p className="help">{t.settings.push.blocked}</p>
            ) : null}
          </>
        )}

        {items.length > 0 ? (
          <div>
            <Button onClick={() => test.mutate()} disabled={test.isPending}>
              {t.settings.push.sendTest}
            </Button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
