# Agent Secrets Manager (ASM) – Design & Umsetzungsplan

## Kontext
Secrets (Passwörter, API-Tokens) für agentische Entwicklung mit Claude Code liegen heute als Klartext-Dateien in einem versteckten Ordner, und das auf mehreren Rechnern. Ziel ist ein selbst gehosteter, zentraler Secrets-Manager als Docker-Container. Agenten finden und fordern Secrets über MCP an, ein Mensch gibt die Anfrage frei (im Browser, später per Push) oder ein zeitlich begrenzter Auto-Modus übernimmt das. Jeder Zugriff landet mit Projekt und Begründung im Audit-Log.

**Entscheidungen des Nutzers:**
- Secret-Übergabe **hybrid**: Standard ist die Übergabe über das lokale CLI (`asm`), sodass Claude den Wert nie sieht. Klartext per MCP nur, wenn es pro Secret erlaubt ist.
- Hosting: **Heimnetz hinter vorhandenem Reverse Proxy** (eigene Domain, TLS am Proxy). Der Container spricht HTTP.
- Stack: **TypeScript/Node** für alles.
- Master-Schlüssel kommt aus **Key-Datei bzw. Env** (Docker-Secret), Server startet ohne Entsperren.
- **Mehrere Nutzer** mit **Tresoren und Mitgliedern** (persönlicher Tresor plus geteilte Tresore).
- **v1 ohne Push**, Web Push folgt in Phase 2.

Nicht-Ziele in v1: native Mobile-App, Secret-Rotation, Browser-Autofill, HSM/KMS.

## Architektur
pnpm-Monorepo im leeren Verzeichnis `/Volumes/Daten/Privat/AgentSecretsManager`:

```
apps/server   Fastify-API + MCP-Endpoint (/mcp) + OAuth-Server + liefert das Web-Build aus
apps/web      React + Vite + TanStack Query + Tailwind, als PWA vorbereitet
apps/cli      `asm`, Node-CLI (als Single-Binary bzw. npm-Paket)
packages/shared  zod-Schemas, Typen, API-Client
Dockerfile, docker-compose.example.yml
docs/superpowers/specs/2026-11-16-agent-secrets-manager-design.md  (dieses Design, beim Start abgelegt)
```

**Bibliotheken:**
- Fastify
- `@modelcontextprotocol/sdk` (Streamable HTTP)
- `@simplewebauthn/server` und `@simplewebauthn/browser`
- `argon2`
- `better-sqlite3` + Drizzle ORM, SQLite FTS5 für die Suche
- `pino` mit Redaction
- vitest, Playwright

## Datenmodell (SQLite, Volume `/data`)
- `users` (Name, argon2-Passwort-Hash, Admin-Flag) und `passkeys` (Credential-ID, Public Key, Counter)
- `vaults` und `vault_members` (Rolle `owner` oder `member`). Jeder Nutzer bekommt automatisch einen persönlichen Tresor.
- `secrets`: Tresor, Titel, Beschreibung, Tags, `env_name` (z.B. `GITHUB_TOKEN`), `allow_plaintext_to_agent` (Standard aus), `current_version`, angelegt von (Nutzer oder Gerät), Archiv-Status (`archived_at`, archiviert von, `archive_reason`, Projekt). Dazu eine FTS5-Tabelle über Titel, Beschreibung und Tags.
- `secret_versions`: eine Zeile pro Version mit Versionsnummer, Chiffrat und verschlüsseltem DEK (AAD = `secretId:version`), Metadaten-Schnappschuss, geändert von (Nutzer oder Gerät), Projekt, Grund und Zeitstempel. Die aktuelle Version ist immer die höchste.
- `devices`: Nutzer, Name, Typ (`mcp` oder `cli`), Status (`pending`, `approved`, `revoked`), Zeitpunkt der letzten Nutzung, Hostname
- `oauth_clients` und `tokens` (Hash, Ablauf, Gerät)
- `access_requests`: Secret, Gerät, Projekt, Grund, Status (`pending`, `approved`, `denied`, `expired`), Entscheider, `auto` (ja/nein), Übergabeart
- `grants`: aus der Freigabe entstandenes, einlösbares Recht (Ablauf 15 min, Nutzungen 1 bis n, gebunden an den Nutzer)
- `auto_mode`: pro Nutzer `enabled_until` und `default_duration_min`, optional auf Tresore beschränkt
- `audit_log`: nur Anhängen (append-only), hash-verkettet über `prev_hash` und `hash`, damit Manipulation erkennbar ist

## Kryptografie
- Der Master-Key (KEK, 32 Byte) kommt aus `ASM_MASTER_KEY_FILE` oder `ASM_MASTER_KEY`. Fehlt er, startet der Server nicht. Ein Hilfsbefehl erzeugt den Schlüssel.
- Envelope-Verschlüsselung: Jedes Secret hat einen eigenen zufälligen DEK und wird mit AES-256-GCM verschlüsselt (AAD = Secret-ID). Den DEK verschlüsselt der KEK. Dadurch ist eine spätere Schlüsselrotation möglich.
- Secret-Werte erscheinen nie in Logs, Fehlermeldungen oder im Audit-Log (pino-Redaction, eigene Fehlertypen).

## Authentifizierung
- **Web:** Passkey (WebAuthn, RP-ID aus `ASM_PUBLIC_URL`) oder Benutzername + Passwort. Den ersten Admin legt ein Setup-Token aus den Container-Logs an.
  - Sessions: httpOnly-Cookies, `Secure`, `SameSite=Strict`, Origin-Prüfung.
  - Für sensible Aktionen (Klartext anzeigen, Auto-Modus an, Gerät freigeben) ist eine erneute Authentifizierung nötig, wenn die letzte älter als 10 min ist.
- **MCP-Geräte:** OAuth 2.1 nach MCP-Spezifikation (Metadata-Endpunkte, Dynamic Client Registration, PKCE). Claude Code öffnet den Browser, der Nutzer meldet sich an und sieht „Gerät *X* möchte sich verbinden“ mit den Knöpfen **Freigeben** und **Verweigern**. Damit ist die gewünschte Geräte-Kopplung umgesetzt.
  - Access-Token: 1 h gültig. Refresh-Token: rotierend.
  - In der Oberfläche sichtbar und widerrufbar.
- **CLI:** `asm login https://asm.example` nutzt den OAuth Device Authorization Grant (RFC 8628): Das CLI zeigt einen Code, der in der Web-Oberfläche erscheint und freigegeben wird. Das Token liegt im OS-Keychain (macOS Keychain über `@napi-rs/keyring`).
- `trustProxy` ist konfigurierbar. Rate-Limits gelten für Login, Token und MCP.

## Ablauf eines Abrufs
1. **`search_secrets(query, vault?)`** (MCP) liefert nur Metadaten: ID, Titel, Beschreibung, Tags, Tresor, `env_name` und ob Klartext erlaubt ist. Die Suche wird protokolliert.
2. **`request_secret(secret_id, project, reason, delivery)`**: `project` und `reason` sind Pflichtfelder. `delivery` ist `cli` (Standard) oder `plaintext`, wobei `plaintext` nur erlaubt ist, wenn das Secret es zulässt.
   - Die Anfrage wird angelegt.
   - Der Server sendet sie per SSE live an alle offenen Web-Sitzungen des Geräte-Besitzers.
   - Ist der Auto-Modus aktiv und deckt den Tresor ab, wird sie sofort freigegeben (Audit-Eintrag `auto`).
3. **`await_request(request_id)`**: Long-Poll bis 60 s, der Agent ruft wiederholt auf. Nach 5 min verfällt die Anfrage.
4. **Bei Freigabe:**
   - **`cli`**: Antwort mit `grant_id` und fertigem Befehl, z.B. `asm run --grant g_123 -- npm test` (Variable `GITHUB_TOKEN`) oder `asm write --grant g_123 .env`. Das CLI löst den Grant mit seinem eigenen Geräte-Token desselben Nutzers ein. Claude sieht den Wert nie.
   - **`plaintext`**: Der Wert kommt direkt in der Tool-Antwort zurück.
5. **Weitere MCP-Tools:** `list_vaults` und `whoami`. Die MCP-Tool-Beschreibungen erklären dem Agenten den bevorzugten CLI-Weg.

**CLI-Befehle:** `asm login | logout | search | request | run --grant | run --secret ID[=ENV] -- cmd | write --grant FILE | mcp-config` (`mcp-config` gibt den Befehl `claude mcp add --transport http asm https://…/mcp` aus).

**Sicherheitsdetails:**
- `asm run` setzt die Variable nur im Kindprozess.
- `asm write` legt Dateien mit Rechten 0600 an und warnt, wenn die Datei nicht in `.gitignore` steht.

## Projekte
- **Pflichtfeld `project` bei allen MCP-Tools** außer `await_request` (das erbt das Projekt der Anfrage). Die Tool-Beschreibungen weisen an, den Namen des Git-Repos bzw. des Arbeitsordners zu verwenden. Das CLI setzt `--project` standardmäßig auf den Namen des Git-Repos bzw. des aktuellen Ordners.
- **Normalisierung:** Der Server macht aus dem Namen einen Slug (Kleinbuchstaben, Bindestriche, z.B. `AgentSecretsManager` → `agent-secrets-manager`; CamelCase wird getrennt) und legt ein Projekt beim ersten Auftauchen automatisch an (`first_seen`, `last_seen`).
- **Zusammenführen:** In der Web-Oberfläche lassen sich zwei Projekte zusammenführen. Das Audit-Log bleibt unverändert, die Zuordnung wird über `merged_into` aufgelöst.
- **Ansichten:**
  - Seite „Projekte“: je Projekt die genutzten Secrets, Geräte und letzten Zugriffe
  - im Secret-Panel „Genutzt von“: Projekte mit letztem Zugriff
- **Suche:** Secrets, die das anfragende Projekt bereits genutzt hat, stehen weiter oben.

## Agent-Schreibzugriff und Versionshistorie
- **Anlegen ohne Rückfrage:** `create_secret` (MCP) bzw. `asm set --new` (CLI) mit Titel, Beschreibung (wofür das Secret ist), Tags, ENV-Name, optional Tresor (Standard: persönlicher Tresor des Gerätebesitzers, sonst muss der Besitzer Mitglied sein), `project` und `reason` als Pflichtfelder. Audit-Eintrag; das Dashboard zeigt „Neu von Agent angelegt“ live an.
- **Ändern mit Freigabe:** `update_secret` erzeugt eine Anfrage der Art `update` mit der vorgeschlagenen Änderung, verschlüsselt gespeichert. Sie läuft über denselben Weg wie Abrufe: Karte im Dashboard mit Metadaten-Diff und dem Hinweis „Wert wird geändert“, oder automatisch im Auto-Modus. Erst nach Freigabe entsteht die neue Version.
- **Wege für den Wert** (beide erlaubt):
  - direkt als `value` im MCP-Aufruf. Der Wert steht dann im Transkript, die Tool-Beschreibung weist darauf hin.
  - `generate: { length, alphabet }`: Der Server erzeugt den Wert, und der Agent sieht ihn nie.
  - `asm set <id|--new> --from-stdin | --from-env VAR | --from-file F | --generate`: Der Wert läuft am Agent-Kontext vorbei.
- **Rechtegrenze:** Agenten können `allow_plaintext_to_agent` weder setzen noch ändern; das darf nur ein Mensch in der Web-Oberfläche. Agenten können keine Secrets löschen.
- **Archivieren statt Löschen:** Agenten (und Menschen) können ein Secret **ohne Freigabe** archivieren, mit Pflichtangaben `reason` (z.B. „ausgetauscht durch sec_…“, „Service abgeräumt“) und `project`. Ein archiviertes Secret:
  - erscheint in Suchen nur mit `include_archived` und ist in der Web-Oberfläche filterbar (Aktiv / Archiviert / Alle), mit Badge und Grund
  - kann nicht mehr abgerufen oder geändert werden (`409 secret_archived`); offene Anfragen dazu werden verweigert, ausgestellte Grants ungültig
  - bleibt mit allen Versionen erhalten; der Verlauf zeigt das Archivieren als Ereignis
  - **Reaktivieren darf nur ein Mensch** in der Web-Oberfläche (Annahme: Reaktivieren gibt einen Zugang wieder frei und gehört deshalb in Menschenhand).
- **Historie:** Jede Änderung (durch Mensch oder Agent) erzeugt eine neue Version, alte Versionen bleiben unbegrenzt erhalten. In der Web-Oberfläche hat jedes Secret einen Reiter „Verlauf“: Versionen mit Zeit, Akteur, Projekt, Grund und Metadaten-Diff. Alte Werte lassen sich nach erneuter Authentifizierung anzeigen, und ein Mensch kann eine alte Version wiederherstellen (das legt eine neue Version an).

## Web-Oberfläche (React)
- **Dashboard:** offene Anfragen (Projekt, Grund, Gerät, Secret) mit den Knöpfen **Freigeben** und **Verweigern**, live per SSE, mit Browser-Benachrichtigung bei offenem Tab.
- **Auto-Modus:** Schalter mit Restlaufzeit-Countdown und einstellbarer Dauer (Standard 30 min, Maximum vom Admin festgelegt).
- **Secrets:** Liste und Suche, Anlegen und Bearbeiten (Titel, Beschreibung, Tags, ENV-Name, Klartext-Erlaubnis), Wert anzeigen und kopieren nach erneuter Authentifizierung, Reiter „Verlauf“ mit allen Versionen und Wiederherstellen. Kennzeichnung „von Agent angelegt“.
- **Tresore:** Mitglieder verwalten.
- **Projekte:** Liste mit letztem Zugriff, Detailseite mit Secrets und Geräten, Zusammenführen.
- **Geräte:** offene Kopplungen freigeben oder verweigern, Geräte umbenennen und widerrufen.
- **Audit-Log:** Filter nach Agent bzw. Gerät, Secret, Projekt, Zeitraum und Ergebnis. Anzeige von Projekt und Grund. CSV-Export und Prüfung der Hash-Kette.
- **Einstellungen:** Passkeys verwalten, Passwort ändern. Für Admins zusätzlich die Nutzerverwaltung.

## Visuelles Design: hochwertiges SaaS-UI ohne „AI-Slop“
**Recherche auf Mobbin (Web).** Vorbilder mit dem, was wir übernehmen:
- [WorkOS – API Keys](https://mobbin.com/screens/15940c03-778f-4c3a-8f90-ca04a73a7739): ruhige Seitenleiste mit gruppierten Bereichen, kleine Schrift, Keys als Mono-Chips mit maskiertem Wert
- [PlanetScale – Audit log](https://mobbin.com/screens/350460dd-4eba-4197-9f8e-f18d0e96cfef): jeder Eintrag als lesbarer Satz plus Mono-Event-Code (`deploy_request.approved`), IP-Adresse und Datum in Fett-Grau
- [Customer.io – Audit Logs](https://mobbin.com/screens/5e4f44d9-4c65-4381-8681-d2921df2591e) und [Cloudflare – Audit logs](https://mobbin.com/screens/fa5520ff-fda8-435f-b65b-bf910991fab4): aufklappbare Zeilen mit Detailansicht, Filterleiste über der Tabelle, CSV-Export
- [Railway – Variables](https://mobbin.com/screens/6dedaaac-55c5-49b4-8a73-d31f5e15dfed): Dunkelmodus, ENV-Namen in Mono, maskierte Werte, Detail als seitliches Panel
- [GitHub-OAuth (AWS Amplify)](https://mobbin.com/screens/cd7d1e70-3699-4bed-8a36-4105e1bdae6c): Zustimmungsseite für die Gerätekopplung (zwei Symbole mit Verbindungslinie, Liste der Rechte, „Weiterleitung an …“)
- [1Password](https://mobbin.com/screens/229f946c-def1-463e-8be3-8c67da56e663) und [Proton Pass](https://mobbin.com/screens/b5502f74-9ae1-45d3-9d83-b740672774b6): Tresor-Auswahl oben links, dreispaltige Ansicht für Secrets

**Gestaltungsrichtung „Ops-Konsole“, präzise und ruhig:**
- **Farben:** warme Neutraltöne (Stone bzw. Zinc), hell und dunkel gleichwertig. Genau **eine** Signalfarbe, Bernstein, für „wartet auf Freigabe“ und den aktiven Auto-Modus. Grün und Rot nur für Ergebnisse. Keine lila Verläufe, kein Glassmorphism, keine Emoji-Icons, keine Gradient-Hero-Karten.
- **Typografie:** Geist Sans und Geist Mono, selbst gehostet. Mono für alles Technische: ENV-Namen, Secret-IDs, Event-Codes, Hostnamen. Text 13–14 px, dichte Tabellen, Zahlen mit festen Ziffernbreiten (tabular numerals).
- **Linien und Flächen:** 1-px-Haarlinien statt Schatten. Schatten nur bei Overlays (Dialoge, ⌘K-Palette). Radius 6 px.
- **Bedienung:**
  - ⌘K-Befehlspalette für Secrets, Seiten und „Auto-Modus 30 min“
  - Tastatur-Kürzel `A` zum Freigeben und `D` zum Verweigern in der Anfragen-Liste
  - Toasts unten rechts
  - Lade-Skelette statt Spinnern
- **Signatur-Element:** Jede offene Anfrage erscheint als Karte mit einem Satz: „**claude@macbook-pro** möchte `GITHUB_TOKEN` für **agent-secrets-manager**. *Grund: Release-Workflow pushen.*“ Dazu ein schmaler, ablaufender Zeitbalken (5 min). Der Auto-Modus läuft als Bernstein-Pille mit Countdown im Kopfbereich, immer sichtbar.
- **Umsetzung:** Tailwind v4 mit Design-Tokens (CSS-Variablen), Radix-Primitives (shadcn/ui als Basis, aber umgestaltet, nicht im Standard-Look), lucide-Icons mit Strichstärke 1.5. Bei der Umsetzung wird der Skill `frontend-design` geladen.

```
┌ ASM ▾ Persönlich ──────────────────────────────── [● Auto 12:41] ⌘K  (JK) ┐
│ Übersicht    │  Anfragen  2 offen                                          │
│ Anfragen   2 │  ┌──────────────────────────────────────────────────────┐   │
│ Secrets      │  │ claude@mbp-office möchte GITHUB_TOKEN                │   │
│ Tresore      │  │ Projekt agent-secrets-manager · via CLI-Übergabe     │   │
│ Geräte       │  │ „Release-Workflow pushen“         [Verweigern D] [Freigeben A] │
│ Audit-Log    │  │ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░  3:12        │   │
│ ──────────   │  └──────────────────────────────────────────────────────┘   │
│ Einstellungen│  Letzte Aktivität                                           │
│              │  claude@mbp-home erhielt OPENAI_KEY · auto · request.auto_approved  10:02 │
└──────────────┴─────────────────────────────────────────────────────────────┘
```

Vor der Umsetzung der Seiten werden 2–3 klickbare Mockups für Dashboard, Audit-Log und Kopplungsseite im Browser gezeigt, damit du die Optik freigeben kannst.

## Audit-Ereignisse
- Anmeldung (erfolgreich und fehlgeschlagen)
- Gerät: Kopplung angefragt, freigegeben, verweigert, widerrufen
- Suche
- Anfrage gestellt, freigegeben, verweigert, automatisch freigegeben, verfallen
- Grant eingelöst (Gerät und Hostname)
- Klartext an Agent übergeben
- Secret angelegt (auch durch Agent), Änderung angefragt, freigegeben, verweigert, automatisch freigegeben, geändert, gelöscht, in der Oberfläche angezeigt
- Alte Version angezeigt oder wiederhergestellt
- Secret archiviert (mit Grund) und reaktiviert
- Auto-Modus an und aus

Jeder Eintrag enthält Akteur (Nutzer oder Gerät), Secret, Projekt, Grund, IP und Zeitstempel.

## Docker
- Multi-Stage-Build auf `node:22-alpine`, läuft als Nicht-Root-Nutzer, Port 8080, Volume `/data`, Healthcheck.
- Umgebungsvariablen: `ASM_PUBLIC_URL`, `ASM_MASTER_KEY_FILE`, `ASM_TRUST_PROXY`, `ASM_AUTO_MODE_MAX_MIN`.
- `docker-compose.example.yml` enthält ein Beispiel für Docker-Secrets und Labels für Traefik bzw. Caddy.

## Phase 2: Web Push (nicht in v1)
- VAPID-Schlüssel, Push-Abos pro Gerät bzw. Browser, Service Worker mit den Aktionen „Genehmigen“ und „Verweigern“.
- Einschränkung: **iOS-Safari zeigt keine Aktions-Buttons.** Dort öffnet ein Tipp auf die Benachrichtigung die PWA direkt auf der Freigabe-Seite.
- Freigaben aus der Benachrichtigung heraus sind über ein kurzlebiges, signiertes Einmal-Token pro Anfrage abgesichert.

## Umsetzungsreihenfolge
1. Monorepo-Gerüst, Design-Dokument nach `docs/superpowers/specs/` ablegen, `git init`
2. Krypto-Modul und DB-Schema mit Migrationen (zuerst Tests: Verschlüsselung hin und zurück, Manipulation am Chiffrat wird erkannt)
3. Web-Auth: Setup-Admin, Passwort, Passkeys, Sessions
4. Tresore, Secrets, FTS-Suche, Audit-Log mit Hash-Kette
5. OAuth-Server (MCP-Kopplung und Device Grant) und Geräteverwaltung
6. MCP-Endpoint mit Tools, Anfrage- und Freigabe-Logik, SSE, Auto-Modus, Grants
7. CLI `asm`
8. React-Oberfläche
9. Dockerfile, Compose-Datei, README
10. Phase 2: Push

## Verifikation
- **vitest:** Krypto, Freigabe-Zustandsautomat (inkl. Ablauf und Auto-Modus-Fenster), Rechteprüfung über Tresore (ein Gerät von Nutzer A darf keine Secrets aus fremden Tresoren sehen), Hash-Kette, Klartext-Verbot ohne Flag
- **Integrationstests mit Fastify `inject`:** kompletter OAuth-Ablauf und Ablauf von der Anfrage bis zum eingelösten Grant
- **Playwright:** Login mit virtuellem WebAuthn-Authenticator, Freigabe im Dashboard, Auto-Modus-Countdown
- **End-to-End:**
  1. `docker compose up`, Setup-Admin anlegen
  2. `claude mcp add --transport http asm https://…/mcp` ausführen und die Kopplung im Browser freigeben
  3. In Claude Code ein Secret suchen und anfordern, im Browser freigeben, mit `asm run --grant … -- env | grep VAR` prüfen
  4. Im Audit-Log Projekt und Grund kontrollieren
  5. Prüfen, dass der Wert nicht im Transkript unter `~/.claude/projects/…` steht
- MCP Inspector gegen `/mcp`
