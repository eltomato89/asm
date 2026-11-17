# ASM – Agent Secrets Manager

Website: <https://eltomato89.github.io/asm/> · English: [README.md](README.md)

Selbst gehosteter Secrets-Manager für mehrere Nutzer, gebaut für KI-Agenten wie Claude Code.
Agenten finden Secrets über MCP, fordern sie mit Projekt und Grund an, und du gibst jede Anfrage im
Browser frei. Den Wert bekommt standardmäßig nicht der Agent, sondern nur der Prozess, den er startet.

<p align="center"><img src="apps/site/src/assets/demo.gif" width="880" alt="Demo: Claude Code fordert NPM_TOKEN über ASM an; eine Push-Mitteilung auf dem Handy öffnet die Freigabeseite, die Anfrage wird mit Face ID freigegeben, und asm run übergibt den Token an npm publish, ohne dass der Wert im Chat erscheint"></p>

- **Server** (`apps/server`): Fastify-API, OAuth 2.1 für MCP-Clients, MCP-Endpunkt `/mcp`, liefert die Web-UI aus. SQLite.
- **Web-UI** (`apps/web`): Anfragen freigeben, Secrets, Tresore, Geräte, Audit-Log.
- **CLI** (`apps/cli`, Befehl `asm`): übergibt freigegebene Secrets an Befehle oder `.env`-Dateien.

## Sicherheitsmodell

- **Hybrid-Übergabe.** Der Agent fordert ein Secret per MCP an (`request_secret`, Standard `delivery: "cli"`).
  Nach der Freigabe erhält er nur eine Grant-ID und ruft `asm run --grant <id> -- <befehl>` auf: Die CLI holt
  den Wert und setzt ihn als Umgebungsvariable nur für diesen Prozess. Der Wert landet so weder im
  Gesprächsverlauf noch beim Modellanbieter. Grants gelten 15 Minuten und standardmäßig für eine Nutzung.
- **Klartext ist Opt-in pro Secret.** `delivery: "plaintext"` geht nur, wenn beim Secret „Klartext an Agenten
  erlauben“ aktiv ist (Standard: aus). Ein Klartext-Wert steht danach im Transkript, in Logs und beim
  Modellanbieter – nur für unkritische Werte verwenden. Agenten können diese Einstellung nie ändern.
- **Freigaben.** Jede Anfrage (Abruf oder Änderung) wartet auf deine Entscheidung (`A` / `D` in der UI) und
  verfällt nach 5 Minuten. Der **Auto-Modus** gibt für eine begrenzte Zeit (Standard 30 min, maximal
  `ASM_AUTO_MODE_MAX_MIN`) und für gewählte Tresore automatisch frei – jede Auto-Freigabe steht im Audit-Log.
- **Dauerfreigabe pro Gerät.** Einem einzelnen Gerät für Tage statt Minuten vertrauen (Geräte → „Dauerfreigabe…“):
  bis zu einem Datum deiner Wahl (höchstens `ASM_STANDING_APPROVAL_MAX_DAYS`, Standard 90), für alle Secrets oder
  eine Auswahl, optional inklusive der Secrets, die das Gerät selbst anlegt. Abrufe sind abgedeckt, Änderungen nur,
  wenn du sie zusätzlich erlaubst. Nach Ablauf fragt ASM entweder wieder jedes Mal, oder einmal – und deine Freigabe
  verlängert die Dauerfreigabe um eine voreingestellte Anzahl Tage. Jede automatische Freigabe steht als „per
  Dauerfreigabe“ im Audit-Log; Widerrufen des Geräts entfernt sie.
- **Was Agenten dürfen.** Secrets anlegen (sofort), ändern (nur mit Freigabe), archivieren (sofort, mit Grund).
  Nie löschen, nie reaktivieren.
- **Archiv statt Löschen.** Archivierte Secrets tauchen in Suchen nicht mehr auf und lassen sich weder abrufen
  noch ändern; offene Anfragen dazu werden verweigert. Ein Mensch kann sie reaktivieren.
- **Versionen.** Jede Änderung erzeugt eine neue Version mit Akteur, Projekt und Grund. Alte Werte bleiben
  einsehbar und lassen sich wiederherstellen.
- **Audit-Log** mit Hash-Kette: Jeder Eintrag enthält den Hash des vorigen, Manipulationen fallen auf
  (Grenzen siehe unten).
- **Geräte.** Jede Kopplung (Claude Code, CLI) ist ein eigenes Gerät, das du im Browser freigibst und
  jederzeit widerrufen kannst. Refresh-Tokens rotieren; Wiederverwendung sperrt das Gerät.
- **Konten deaktivieren.** Admins können Konten in den Einstellungen deaktivieren (Offboarding): Die Person wird
  abgemeldet, kann sich nicht mehr anmelden, und alle ihre Geräte werden widerrufen.
- **Verschlüsselung.** AES-256-GCM, pro Secret ein eigener Schlüssel, der mit dem Master-Key verschlüsselt ist.
  Sensible Aktionen (Wert anzeigen, Gerät koppeln, Auto-Modus, Dauerfreigabe setzen) verlangen eine Anmeldung, die höchstens
  10 Minuten alt ist. Anmeldung mit Passwort oder Passkey.

## Setup (Docker)

Das Image basiert auf `node:24-alpine`. Ohne Docker braucht der Server Node.js ≥ 24 (LTS) und pnpm 11.

```sh
docker build -t asm .

# Master-Key erzeugen – getrennt von den Daten sichern! Ohne ihn sind alle Secrets verloren.
# Eigenes Verzeichnis (secrets/ ist in .gitignore und .dockerignore ausgeschlossen).
mkdir -p secrets && chmod 700 secrets
docker run --rm asm node apps/server/dist/scripts/generate-key.js > secrets/asm_master_key
chmod 600 secrets/asm_master_key
sudo chown 1000:1000 secrets/asm_master_key   # der Container läuft als User node (UID 1000) und muss die Datei lesen können
```

Den Key nie committen und nicht ins Image bauen. Am besten liegt er ganz außerhalb des Repos (dann den Pfad
unter `secrets.asm_master_key.file` in der Compose-Datei anpassen).

Dann `docker-compose.example.yml` kopieren, `ASM_PUBLIC_URL` anpassen und starten:

```sh
docker compose -f docker-compose.example.yml up -d
docker compose -f docker-compose.example.yml logs asm | grep "ASM setup token"
```

Öffne `ASM_PUBLIC_URL` im Browser, gib das Setup-Token aus dem Log ein und lege das erste Konto an (Admin).
Weitere Nutzer legst du unter „Einstellungen“ an. Einen Passkey fügst du dort ebenfalls hinzu.

| Variable | Bedeutung | Standard |
| --- | --- | --- |
| `ASM_PUBLIC_URL` | Öffentliche Adresse (Origin), Pflicht. Bestimmt Passkey-Domain, OAuth-Issuer, Origin-Prüfung. | – |
| `ASM_MASTER_KEY_FILE` / `ASM_MASTER_KEY` | Master-Key (base64, 32 Byte) als Datei bzw. direkt. Fehlt er, beendet sich der Server mit Fehler. | – |
| `ASM_TRUST_PROXY` | Hinter einem Reverse Proxy: Anzahl der Proxy-Hops (meist `1`) oder kommagetrennte IPs/CIDRs der Proxys. `true` vertraut jedem `X-Forwarded-For`-Eintrag (fälschbar, Warnung im Log) und ist zusammen mit `ASM_TRUSTED_NETWORKS` verboten. | `false` |
| `ASM_AUTO_MODE_MAX_MIN` | Maximale Dauer des Auto-Modus. | `240` |
| `ASM_STANDING_APPROVAL_MAX_DAYS` | Maximale Dauer einer Dauerfreigabe pro Gerät in Tagen (höchstens `3650`). Begrenzt auch Verlängerungen; ein kleinerer Wert verkürzt bestehende Dauerfreigaben. `0` schaltet die Funktion ab. | `90` |
| `ASM_DATA_DIR` | Datenverzeichnis (`asm.db`). | `/data` |
| `PORT` | HTTP-Port. | `8080` |
| `ASM_CLI_DIR` | Verzeichnis mit CLI-Bundle (`asm.mjs`, `asm.json`) für `/cli/install.sh`. | Image: `/app/cli` |
| `ASM_TRUSTED_NETWORKS` | Kommagetrennte IPv4/IPv6-CIDRs (z. B. `192.168.0.0/16,100.64.0.0/10`). Clients außerhalb erreichen nur die Freigabe-Seite (siehe „Push-Freigabe vom iPhone“), alles andere ist 404. Hinter einem Proxy nur mit `ASM_TRUST_PROXY=1` (bzw. Proxy-IPs) sinnvoll. Nie das Proxy- oder Docker-Netz eintragen – sonst gilt jede Anfrage über den Proxy als intern. | leer = keine Sperre |
| `ASM_VAPID_SUBJECT` | Kontakt für Web-Push-Dienste (`mailto:` oder `https:`). Eine echte Adresse wird empfohlen – Apple lehnt Platzhalter teils ab. | `mailto:asm@localhost` |

## Reverse Proxy

- TLS terminiert am Proxy; ASM selbst spricht nur HTTP. Beispiele für Traefik und Caddy stehen
  auskommentiert in `docker-compose.example.yml`.
- `ASM_PUBLIC_URL` muss genau der https-Origin sein, unter dem Browser und Agenten ASM erreichen
  (z. B. `https://asm.example.com`, ohne Pfad). http ist nur für `localhost` erlaubt.
- `ASM_TRUST_PROXY=1` setzen (ein Proxy-Hop; bei mehreren Proxys deren Anzahl oder die Proxy-IPs/CIDRs). Sonst sieht ASM nur die IP des Proxys, und die Rate-Limits pro IP treffen alle
  Nutzer gemeinsam. Den Container-Port dann nur für den Proxy erreichbar machen.
- Passkeys brauchen https und einen Domainnamen – eine IP-Adresse funktioniert nicht.
- Live-Anfragen (Server-Sent Events) und MCP-Long-Polls (bis ~50 s) nicht puffern und Timeouts ≥ 60 s lassen.

## Push-Freigabe vom iPhone

Wartet eine Anfrage auf Freigabe, schickt ASM eine Push-Benachrichtigung an deine Geräte. Tippen öffnet eine
kleine Freigabe-Seite: „Freigeben“ (mit Face ID) oder „Verweigern“. Das geht auch unterwegs, obwohl ASM nicht
öffentlich erreichbar ist – nach außen ist nur die Freigabe-Seite offen.

**Einrichten (einmalig, im Heimnetz/VPN):**

1. ASM in Safari öffnen (`ASM_PUBLIC_URL`), anmelden, Teilen → „Zum Home-Bildschirm“ (iOS ≥ 16.4).
2. ASM über das neue Symbol starten, Einstellungen → „Benachrichtigungen“ → „Aktivieren“ und erlauben.
3. „Test senden“ prüft die Zustellung. Für die Freigabe braucht dein Konto einen Passkey (Face ID).

Die VAPID-Schlüssel erzeugt ASM beim ersten Start selbst (privater Schlüssel mit dem Master-Key verschlüsselt in der DB).

**Öffentliche Pfade:** `/approve/`, `/api/approve/`, `/assets/`, `/favicon.svg`, `/theme-init.js`, `/sw.js`,
`/manifest.webmanifest`, `/icons/icon-180.png`, `/icons/icon-192.png`, `/icons/icon-512.png`. Alles andere nur aus
dem Heimnetz/VPN. Ein Hostname für innen und außen, damit derselbe Passkey gilt.

**Nginx Proxy Manager – Variante A (Oberfläche):**

- *Access Lists* → neue Liste „Heimnetz“: unter *Access* `allow 192.168.0.0/16` (und ggf. VPN-Netz), Rest `deny`,
  keine Benutzer, „Satisfy Any“.
- *Proxy Host* `asm.example.de` → `http://asm:8080`, SSL aktiv, *Access List* = „Heimnetz“.
- *Custom Locations* ohne Access List, gleiches Ziel (`asm`, `8080`): `/approve/`, `/api/approve/`, `/assets/`,
  `/favicon.svg`, `/theme-init.js`, `/sw.js`, `/manifest.webmanifest`, `/icons/`. Bei `/approve/` und `/api/approve/`
  im Zahnrad-Feld `access_log off;` eintragen (die Links enthalten Einmal-Tokens).
- Per Mobilfunk testen: `https://asm.example.de/` muss 403 liefern, ein Freigabe-Link muss funktionieren. Greift die
  Access List in deiner NPM-Version auch für die Custom Locations, Variante B nehmen.

**Variante B (Tab *Advanced* des Proxy Hosts, keine Access List am Host):**

```nginx
location ~ ^/(api/)?approve/ {
  access_log off;        # Links enthalten Einmal-Tokens
  include conf.d/include/proxy.conf;
}
location ~ ^/(assets/|favicon\.svg$|theme-init\.js$|sw\.js$|manifest\.webmanifest$|icons/icon-(180|192|512)\.png$) {
  include conf.d/include/proxy.conf;
}
location / {
  allow 192.168.0.0/16;
  allow 100.64.0.0/10;   # z. B. Tailscale
  deny all;
  proxy_buffering off;   # Live-Anfragen (SSE)
  proxy_read_timeout 120s;
  include conf.d/include/proxy.conf;
}
```

Zusätzlich `ASM_TRUST_PROXY=1` und `ASM_TRUSTED_NETWORKS=192.168.0.0/16,100.64.0.0/10` setzen: Dann sperrt auch
ASM selbst alle anderen Pfade für fremde IPs (zweite Sicherung, falls der Proxy falsch konfiguriert ist). Mit
`ASM_TRUST_PROXY=1` zählt nur der vom Proxy angehängte `X-Forwarded-For`-Eintrag – vom Client mitgeschickte Einträge
werden ignoriert. Das Proxy- bzw. Docker-Netz (z. B. `172.16.0.0/12`) gehört **nicht** in `ASM_TRUSTED_NETWORKS`.

**Sicherheit:**

- Der Text der Benachrichtigung ist neutral („Neue Anfrage wartet auf Freigabe“), ohne Secret, Projekt oder Grund.
  Der Inhalt ist Ende-zu-Ende verschlüsselt (Web Push), Apple sieht nur Ziel und Zeitpunkt.
- Jeder Link enthält ein Einmal-Token (nur als SHA-256 gespeichert). Es gilt nur für diese Anfrage, nur solange sie
  offen ist, und ist nach einer Entscheidung – egal ob per Link oder im Dashboard – wertlos.
- „Freigeben“ verlangt einen Passkey des Besitzers mit Nutzerverifikation (Face ID/Geräte-PIN). „Verweigern“ geht
  ohne. Keine Session, kein Cookie, keine Secret-Werte; 30 Aufrufe pro Minute und IP.
- Push-Abos werden nur für bekannte Push-Dienste angenommen (Apple, Google FCM, Mozilla, Windows).
- ASM schreibt die Tokens nicht in sein Log. Access-Logs des Proxys enthalten die Links jedoch – für `/approve/` und
  `/api/approve/` abschalten (siehe oben).
- Entscheidungen erscheinen im Audit-Log wie gewohnt (`request.approved`/`request.denied`) mit `via: push`.

## Claude Code verbinden

```sh
claude mcp add --transport http asm https://asm.example.com/mcp
```

Beim ersten Aufruf öffnet Claude Code den Browser: anmelden, Kopplung prüfen, „Freigeben“. Danach kann Claude
Secrets suchen (`search_secrets`), anfordern (`request_secret` + `await_request`), anlegen, Änderungen
vorschlagen und archivieren. `asm mcp-config` gibt den passenden Befehl für deinen Server aus.

## CLI

Installation direkt vom eigenen ASM-Server (Voraussetzung: Node ≥ 22.12, dazu `curl` oder `wget`; kein sudo,
kein GitHub- oder npm-Zugang nötig):

```sh
curl -fsSL https://asm.example.com/cli/install.sh | sh
# ohne curl:  wget -qO- https://asm.example.com/cli/install.sh | sh
asm login https://asm.example.com
```

Das Skript lädt das CLI-Bundle (`/cli/asm.mjs`), prüft SHA-256 und Größe gegen `/cli/asm.json` (dafür wird
`sha256sum`, `shasum` oder `openssl` benötigt) und installiert es nach `~/.local/share/asm/asm.mjs`
(anderer Ort: `ASM_HOME`). Der Befehl `~/.local/bin/asm` (anderes Verzeichnis: `ASM_INSTALL_DIR`) wird als
Symlink darauf angelegt; die Endung `.mjs` sorgt dafür, dass Node die Datei immer als ES-Modul lädt. Ein
vorhandenes `asm` – auch ein Symlink auf einen Repo-Build – wird ersetzt. Liegt das Verzeichnis nicht im
`PATH`, gibt das Skript einen Hinweis aus. Beispiel mit eigenen Pfaden:

```sh
curl -fsSL https://asm.example.com/cli/install.sh | ASM_HOME=/opt/asm ASM_INSTALL_DIR=$HOME/bin sh
```

Die CLI-Version passt so immer zur Server-Version; `asm update` holt später das aktuelle Bundle vom Server
(ebenfalls mit Hash-Prüfung), `asm --version` zeigt die installierte Version. Deinstallieren: beide entfernen,
`rm ~/.local/bin/asm ~/.local/share/asm/asm.mjs`.

Tokens speichert die CLI im OS-Schlüsselbund: unter macOS in der Keychain (`security`), unter Linux über
`secret-tool` (libsecret, z. B. Paket `libsecret-tools`). Steht keins davon zur Verfügung (etwa auf einem
Server ohne Desktop-Session), speichert `asm --insecure-store login …` die Tokens stattdessen in einer Datei mit
Rechten 0600.

Für Entwickler – aus dem Repo bauen:

```sh
pnpm install
pnpm --filter @asm/shared build && pnpm --filter @asm/cli build
ln -s "$PWD/apps/cli/dist/index.js" ~/.local/bin/asm     # Verzeichnis muss im PATH liegen
```

Das Build ist reines JavaScript (kein `tsx`, kein Type-Stripping); `node apps/cli/dist/index.js` funktioniert
ebenso. `pnpm --filter @asm/cli bundle` erzeugt das Einzeldatei-Bundle `apps/cli/dist-bundle/asm.mjs` (+ `asm.json`),
das ein lokal gestarteter Server automatisch unter `/cli/` ausliefert (sonst `ASM_CLI_DIR` setzen).

Nutzung:

```sh
asm login https://asm.example.com          # Gerät koppeln (Freigabe im Browser), Tokens im OS-Schlüsselbund
asm search github                           # nur Metadaten
asm run --grant grt_… -- npm run deploy     # Wert nur für diesen Prozess als ENV-Variable
asm run --secret sec_… --reason "Deploy" -- ./deploy.sh   # anfragen, auf Freigabe warten, ausführen
asm write --grant grt_… .env                # in eine dotenv-Datei schreiben (0600, zusammengeführt)
asm set --new --title "Stripe Key" --description "Stripe Live-API (Zahlungen)" --env STRIPE_KEY \
  --reason "neues Projekt" --from-env STRIPE_KEY
asm set sec_… --reason "Key rotiert" --from-stdin --wait   # Änderung vorschlagen (braucht Freigabe)
asm archive sec_… --reason "ersetzt durch sec_…"
```

Projekt ist standardmäßig der Name des Git-Repos bzw. Ordners (`--project` überschreibt das).

### Hinweise zu dotenv-Dateien (`asm write`)

- Werte werden in doppelte Anführungszeichen gesetzt; `\`, `"`, `$` und `` ` `` werden mit `\` escaped.
- Zeilenumbrüche werden als literales `\n` geschrieben. Beim Einlesen per `sh` (`set -a; . ./.env`) entsteht
  daraus ein Backslash gefolgt von `n`, kein Zeilenumbruch.
- Das npm-Paket `dotenv` wandelt `\n` in einen Zeilenumbruch um, behält aber `\$` und `` \` `` wörtlich bei.
  Für Werte mit diesen Zeichen besser `asm run` verwenden.

## Entwicklung

Voraussetzungen: Node.js ≥ 24 (LTS), pnpm 11 (Version aus `packageManager` in `package.json`).

```sh
pnpm install
pnpm test          # Unit- und Integrationstests aller Pakete (vitest)
pnpm typecheck
pnpm build         # shared → dist, server → dist (inkl. SQL-Migrationen), web → dist, cli → dist
pnpm e2e           # Playwright gegen den gebauten Server (einmalig: pnpm exec playwright install chromium)
```

Server im Dev-Modus (TypeScript direkt, `@asm/shared` aus dem Quellcode über die Export-Bedingung `development`):

```sh
cd apps/server
ASM_PUBLIC_URL=http://localhost:5173 ASM_MASTER_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  ASM_DATA_DIR=./.data pnpm dev
```

Web-UI mit Vite: `pnpm --filter @asm/web dev` (Port 5173). Vite leitet `/api`, `/oauth`, `/.well-known` und
`/mcp` an `http://localhost:8080` weiter (anderer Server: `ASM_DEV_SERVER`). Der Server muss dafür mit
`ASM_PUBLIC_URL=http://localhost:5173` laufen, sonst scheitern Origin-Prüfung und Passkeys.

`pnpm --filter @asm/server start` startet den gebauten Server (`node dist/main.js`).

## CI & Releases

GitHub Actions (`.github/workflows/`):

- **CI** (`ci.yml`) – bei jedem Push auf `main` und jedem Pull Request: Typecheck, Unit-Tests, Web-Build,
  CLI-Bundle, danach Playwright-e2e (Report/Traces als Artefakt bei Fehlern). Neuere PR-Pushes brechen
  laufende Runs ab.
- **Docker** (`docker.yml`) – baut `ghcr.io/eltomato89/asm` für `linux/amd64` und pusht in die
  GitHub Container Registry:
  - nach erfolgreicher CI auf `main` → `edge` und `sha-<kurz>`
  - bei Tag `vX.Y.Z` (Tests laufen vorher im selben Workflow) → `X.Y.Z`, `X.Y`, `latest`
  - manuell über „Run workflow“ (`workflow_dispatch`) – nur von `main` oder einem `v*`-Tag aus
  - Prerelease-Tags (`v1.0.0-rc.1`) bekommen nur `1.0.0-rc.1`, kein `X.Y`/`latest`
- **Website** (`pages.yml`) – baut die Landingpage (`apps/site`, siehe dortige README) und veröffentlicht sie auf GitHub
  Pages bei Pushes auf `main`, die `apps/site/**` ändern. Einmalig: Settings → Pages → Source: GitHub Actions.
- **Dependabot** – wöchentliche Updates für Actions und npm (Minor/Patch gruppiert).

Keine zusätzlichen Secrets nötig: Der Push nutzt das automatische `GITHUB_TOKEN` (`packages: write`).

Neue GHCR-Packages sind standardmäßig privat. Das Label `org.opencontainers.image.source` verknüpft das Package
mit dem Repo (Zugriffsrechte werden vom Repo übernommen, die Sichtbarkeit nicht). Der Server muss sich daher vor dem
Pull anmelden – mit einem Personal Access Token (classic) mit Scope `read:packages`:

```sh
echo "$GHCR_PAT" | docker login ghcr.io -u <github-user> --password-stdin
docker pull ghcr.io/eltomato89/asm:latest
```

Alternativ das Package in seinen Einstellungen auf GitHub („Package settings“ → „Change visibility“) öffentlich
machen.

Release:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

Hinweis: Actions-Minuten sind bei privaten Repos begrenzt; gebaut wird nur `linux/amd64` (Build-Cache über `type=gha`
beschleunigt Folge-Builds). Für arm64 `platforms` in `docker.yml` ergänzen und `docker/setup-qemu-action` wieder
aufnehmen.

## Backup

- `/data/asm.db` sichern (im laufenden Betrieb z. B. mit `sqlite3 /data/asm.db ".backup /backup/asm.db"`,
  da SQLite im WAL-Modus läuft).
- Den Master-Key **getrennt** davon sichern. Datenbank ohne Key ist wertlos, Key ohne Datenbank auch.

## Grenzen (v1)

- **Nur eine Instanz.** Live-Events (SSE), laufende OAuth-Autorisierungen und WebAuthn-Challenges liegen im
  Speicher; kein horizontales Skalieren, ein Neustart bricht laufende Kopplungen ab.
- **Projekte sind global.** Projektnamen (Slugs) gelten für alle Nutzer der Instanz gemeinsam. Wer zwei Projekte
  zusammenführt, ändert damit die Zuordnung für alle: Der alte Name zeigt danach auf das Zielprojekt, auch für
  Agenten anderer Nutzer, die denselben Namen verwenden. Zusammenführen ist nur möglich, wenn du alle betroffenen
  Nutzungen sehen kannst.
- **Hash-Kette mit Lücke am Ende.** Die Hash-Kette erkennt geänderte oder gelöschte Einträge in der Mitte des
  Logs, aber nicht das Löschen der *letzten* Einträge: Wer Schreibzugriff auf die Datenbank hat, kann das Ende
  abschneiden, ohne dass die Kettenprüfung im Audit-Log anschlägt. Für Revisionssicherheit das Log regelmäßig exportieren
  (CSV) oder den letzten Hash extern festhalten.

## Lizenz

Lizenziert unter der [Apache License, Version 2.0](LICENSE). Copyright 2026 Jens Köhler.

Drittanbieter-Lizenzen: `THIRD_PARTY_NOTICES` im Docker-Image (`/app/THIRD_PARTY_NOTICES`) und neben dem CLI-Bundle (`/cli/THIRD_PARTY_NOTICES`, wird mit `asm.mjs` installiert); die Web-Oberfläche liefert ihre eigene unter `/THIRD_PARTY_NOTICES.txt` aus. Sie werden beim Build erzeugt.
