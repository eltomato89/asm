# CLI-Verteilung über den ASM-Server – Design

## Ziel
Ein neuer Rechner bekommt die `asm`-CLI mit einem Befehl, ohne GitHub-Zugang oder npm-Token:

```bash
curl -fsSL https://asm.example/cli/install.sh | sh
asm login https://asm.example
```

Die CLI-Version passt immer zur Server-Version. Voraussetzung auf dem Client: Node ≥ 22.

## Entscheidungen (vom Nutzer gewählt: Option 1)
- **Ein Bundle:** `apps/cli` + `@asm/shared` werden mit esbuild zu einer einzigen ESM-Datei `asm.mjs` (Shebang `#!/usr/bin/env node`, Version als Build-Konstante) gebündelt. Daneben ein Manifest `asm.json` `{ version, sha256, size }`.
- **Keine nativen Module in der CLI:** `@napi-rs/keyring` wird ersetzt durch OS-Werkzeuge:
  - macOS: `security` (Keychain). Werte werden **nie** als Argument übergeben (sonst in `ps` sichtbar), sondern über `security -i` per stdin.
  - Linux: `secret-tool` (libsecret); `store` liest das Secret von stdin.
  - Fehlt beides → klare Fehlermeldung mit Hinweis auf `--insecure-store` (Datei 0600, wie bisher).
  - Bestehende Speicherorte bleiben kompatibel: Service `asm`, Account = Server-Host, Inhalt JSON `{accessToken, refreshToken, expiresAt}`.
- **Server-Routen (öffentlich, ohne Login – die CLI ist nicht geheim):**
  - `GET /cli/install.sh` – POSIX-sh-Skript, Server-URL (`ASM_PUBLIC_URL`) eingesetzt. Prüft Node ≥ 22, lädt `asm.mjs`, prüft SHA-256 gegen `/cli/asm.json`, installiert nach `${ASM_INSTALL_DIR:-$HOME/.local/bin}/asm` (chmod 755), gibt PATH-Hinweis und nächsten Schritt `asm login <url>` aus.
  - `GET /cli/asm.mjs` – das Bundle (`text/javascript`, `cache-control: no-cache`, ETag).
  - `GET /cli/asm.json` – Manifest.
  - Fehlt das Bundle (Dev/Tests) → 404 `{error:'cli_not_available'}`; Pfade unter `/cli/` fallen nicht in den SPA-Fallback.
  - Bundle-Verzeichnis per `ASM_CLI_DIR` (Default: im Image `/app/cli`, lokal `apps/cli/dist-bundle` falls vorhanden).
- **`asm update`:** lädt Bundle + Manifest vom Default-Server, prüft SHA-256, ersetzt die eigene Datei atomar (temp + rename). `asm --version` zeigt die Version.
- **Docker:** Build-Stage baut das Bundle; Runtime-Image enthält nur `asm.mjs` + `asm.json` unter `/app/cli`.
- **README:** Abschnitt „CLI installieren“ auf den neuen Weg umstellen; Build aus dem Repo bleibt als Entwickler-Option.

## Nicht-Ziele
Standalone-Binary ohne Node, Windows, npm-Veröffentlichung, Signaturen über SHA-256 hinaus.

## Verifikation
- CLI-Tests: Keychain-Backends mit gefaktem `security`/`secret-tool` (Wert nie in argv), Fallback-Meldung, `update` mit Fake-Server (Hash-Fehler → keine Änderung).
- Server-Tests: Routen, eingesetzte URL, 404 ohne Bundle, kein SPA-Fallback für `/cli/*`.
- End-to-End: Image bauen, `curl …/cli/install.sh | ASM_INSTALL_DIR=<tmp> sh`, dann `<tmp>/asm --version` und `asm login` gegen den lokalen Container.
