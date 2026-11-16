# ASM – Agent Secrets Manager

Selbst gehosteter Secrets-Manager für mehrere Nutzer, gebaut für KI-Agenten wie Claude Code.
Agenten finden Secrets über MCP, fordern sie mit Projekt und Grund an, und du gibst jede Anfrage im
Browser frei. Den Wert bekommt standardmäßig nicht der Agent, sondern nur der Prozess, den er startet.

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
- **Was Agenten dürfen.** Secrets anlegen (sofort), ändern (nur mit Freigabe), archivieren (sofort, mit Grund).
  Nie löschen, nie reaktivieren.
- **Archiv statt Löschen.** Archivierte Secrets tauchen in Suchen nicht mehr auf und lassen sich weder abrufen
  noch ändern; offene Anfragen dazu werden verweigert. Ein Mensch kann sie reaktivieren.
- **Versionen.** Jede Änderung erzeugt eine neue Version mit Akteur, Projekt und Grund. Alte Werte bleiben
  einsehbar und lassen sich wiederherstellen.
- **Audit-Log** mit Hash-Kette: Jeder Eintrag enthält den Hash des vorigen, Manipulationen fallen auf.
- **Geräte.** Jede Kopplung (Claude Code, CLI) ist ein eigenes Gerät, das du im Browser freigibst und
  jederzeit widerrufen kannst. Refresh-Tokens rotieren; Wiederverwendung sperrt das Gerät.
- **Verschlüsselung.** AES-256-GCM, pro Secret ein eigener Schlüssel, der mit dem Master-Key verschlüsselt ist.
  Sensible Aktionen (Wert anzeigen, Gerät koppeln, Auto-Modus) verlangen eine Anmeldung, die höchstens
  10 Minuten alt ist. Anmeldung mit Passwort oder Passkey.

## Setup (Docker)

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
| `ASM_TRUST_PROXY` | `true` hinter einem Reverse Proxy. | `false` |
| `ASM_AUTO_MODE_MAX_MIN` | Maximale Dauer des Auto-Modus. | `240` |
| `ASM_DATA_DIR` | Datenverzeichnis (`asm.db`). | `/data` |
| `PORT` | HTTP-Port. | `8080` |

## Reverse Proxy

- TLS terminiert am Proxy; ASM selbst spricht nur HTTP. Beispiele für Traefik und Caddy stehen
  auskommentiert in `docker-compose.example.yml`.
- `ASM_PUBLIC_URL` muss genau der https-Origin sein, unter dem Browser und Agenten ASM erreichen
  (z. B. `https://asm.example.com`, ohne Pfad). http ist nur für `localhost` erlaubt.
- `ASM_TRUST_PROXY=true` setzen. Sonst sieht ASM nur die IP des Proxys, und die Rate-Limits pro IP treffen alle
  Nutzer gemeinsam. Den Container-Port dann nur für den Proxy erreichbar machen.
- Passkeys brauchen https und einen Domainnamen – eine IP-Adresse funktioniert nicht.
- Live-Anfragen (Server-Sent Events) und MCP-Long-Polls (bis ~50 s) nicht puffern und Timeouts ≥ 60 s lassen.

## Claude Code verbinden

```sh
claude mcp add --transport http asm https://asm.example.com/mcp
```

Beim ersten Aufruf öffnet Claude Code den Browser: anmelden, Kopplung prüfen, „Freigeben“. Danach kann Claude
Secrets suchen (`search_secrets`), anfordern (`request_secret` + `await_request`), anlegen, Änderungen
vorschlagen und archivieren. `asm mcp-config` gibt den passenden Befehl für deinen Server aus.

## CLI

Installation aus dem Repository (Node ≥ 22):

```sh
pnpm install
pnpm --filter @asm/shared build && pnpm --filter @asm/cli build
ln -s "$PWD/apps/cli/dist/index.js" ~/.local/bin/asm     # Verzeichnis muss im PATH liegen
```

Das Build ist reines JavaScript (kein `tsx`, kein Type-Stripping); `node apps/cli/dist/index.js` funktioniert
ebenso.

Nutzung:

```sh
asm login https://asm.example.com          # Gerät koppeln (Freigabe im Browser), Tokens im OS-Schlüsselbund
asm search github                           # nur Metadaten
asm run --grant grt_… -- npm run deploy     # Wert nur für diesen Prozess als ENV-Variable
asm run --secret sec_… --reason "Deploy" -- ./deploy.sh   # anfragen, auf Freigabe warten, ausführen
asm write --grant grt_… .env                # in eine dotenv-Datei schreiben (0600, zusammengeführt)
asm set --new --title "Stripe Key" --env STRIPE_KEY --reason "neues Projekt" --from-env STRIPE_KEY
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

## Backup

- `/data/asm.db` sichern (im laufenden Betrieb z. B. mit `sqlite3 /data/asm.db ".backup /backup/asm.db"`,
  da SQLite im WAL-Modus läuft).
- Den Master-Key **getrennt** davon sichern. Datenbank ohne Key ist wertlos, Key ohne Datenbank auch.

## Grenzen (v1)

- **Nur eine Instanz.** Live-Events (SSE), laufende OAuth-Autorisierungen und WebAuthn-Challenges liegen im
  Speicher; kein horizontales Skalieren, ein Neustart bricht laufende Kopplungen ab.
- **Keine Push-Benachrichtigungen.** Web Push (VAPID) und Freigeben direkt aus der Benachrichtigung kommen in
  Phase 2. Bis dahin: Tab offen lassen (Browser-Benachrichtigungen lassen sich in der UI aktivieren).
