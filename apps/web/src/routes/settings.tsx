import { useQuery } from '@tanstack/react-query';
import { AdminUsers } from '../components/settings/AdminUsers';
import { PasskeySection } from '../components/settings/PasskeySection';
import { PasswordSection } from '../components/settings/PasswordSection';
import { PushSection } from '../components/settings/PushSection';
import { api, queryKeys } from '../lib/api';
import { useTheme, type ThemeMode } from '../lib/theme';

const THEMES: { mode: ThemeMode; label: string }[] = [
  { mode: 'system', label: 'System' },
  { mode: 'light', label: 'Hell' },
  { mode: 'dark', label: 'Dunkel' },
];

export function SettingsPage() {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const { mode, setMode } = useTheme();
  return (
    <>
      <div className="page-head">
        <h1>Einstellungen</h1>
        {me.data ? (
          <span className="meta">
            angemeldet als <span className="mono">{me.data.username}</span>
          </span>
        ) : null}
      </div>

      <section className="settings-sec" aria-labelledby="s-theme">
        <div className="settings-text">
          <h2 id="s-theme">Darstellung</h2>
          <p>Gilt für diesen Browser.</p>
        </div>
        <div className="seg" role="group" aria-label="Darstellung">
          {THEMES.map((t) => (
            <button key={t.mode} type="button" aria-pressed={mode === t.mode} onClick={() => setMode(t.mode)}>
              {t.label}
            </button>
          ))}
        </div>
      </section>

      <PasskeySection />
      <PasswordSection />
      <PushSection />
      {me.data?.isAdmin ? <AdminUsers /> : null}
    </>
  );
}
