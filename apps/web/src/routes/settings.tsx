import { useQuery } from '@tanstack/react-query';
import { AdminUsers } from '../components/settings/AdminUsers';
import { PasskeySection } from '../components/settings/PasskeySection';
import { PasswordSection } from '../components/settings/PasswordSection';
import { PushSection } from '../components/settings/PushSection';
import { changeLocale, LOCALES, storedLocale, t, type Locale } from '../i18n';
import { api, queryKeys } from '../lib/api';
import { useTheme, type ThemeMode } from '../lib/theme';

const THEME_MODES: ThemeMode[] = ['system', 'light', 'dark'];

export function SettingsPage() {
  const me = useQuery({ queryKey: queryKeys.me, queryFn: api.me });
  const { mode, setMode } = useTheme();
  const themeLabel: Record<ThemeMode, string> = { system: t.settings.appearance.system, light: t.settings.appearance.light, dark: t.settings.appearance.dark };
  // Language names stay untranslated; "System" follows the browser language (no stored choice).
  const languages: { id: Locale | null; label: string }[] = [{ id: null, label: t.settings.language.system }, ...LOCALES];
  const chosen = storedLocale();
  return (
    <>
      <div className="page-head">
        <h1>{t.settings.title}</h1>
        {me.data ? (
          <span className="meta">
            {t.settings.signedInAs}
            <span className="mono">{me.data.username}</span>
          </span>
        ) : null}
      </div>

      <section className="settings-sec" aria-labelledby="s-theme">
        <div className="settings-text">
          <h2 id="s-theme">{t.settings.appearance.title}</h2>
          <p>{t.settings.appearance.help}</p>
        </div>
        <div className="seg" role="group" aria-label={t.settings.appearance.title}>
          {THEME_MODES.map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {themeLabel[m]}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-sec" aria-labelledby="s-language">
        <div className="settings-text">
          <h2 id="s-language">{t.settings.language.title}</h2>
          <p>{t.settings.language.help}</p>
        </div>
        <div className="seg" role="group" aria-label={t.settings.language.title}>
          {languages.map((l) => (
            <button key={l.id ?? 'system'} type="button" aria-pressed={chosen === l.id} onClick={() => chosen !== l.id && changeLocale(l.id)}>
              {l.label}
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
