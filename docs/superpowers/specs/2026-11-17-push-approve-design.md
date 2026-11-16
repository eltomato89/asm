# Push-Freigabe vom iPhone – Design (Phase 2)

## Ziel
Ein Agent fordert ein Secret an → das iPhone bekommt eine Push-Benachrichtigung → Tippen öffnet eine kleine Freigabe-Seite → „Freigeben“ mit Face ID (Passkey) bzw. „Verweigern“. Das funktioniert unterwegs, obwohl ASM selbst **nicht** öffentlich erreichbar ist: Nach außen ist nur die Freigabe-Seite freigegeben.

## Netzwerk (Nginx Proxy Manager des Nutzers)
- Ein Hostname, z. B. `asm.example.de` (= `ASM_PUBLIC_URL`, https am Proxy). Dadurch gilt **derselbe Passkey** intern und extern.
- Im Proxy: alles nur aus dem Heimnetz/VPN erlaubt, von außen nur die öffentlichen Pfade:
  - `/approve/` (Seite), `/api/approve/` (API), `/assets/` (gebündeltes JS/CSS der Seite), `/favicon.svg`.
- Zweite Sicherung im Server: `ASM_TRUSTED_NETWORKS` (CIDR-Liste, z. B. `192.168.0.0/16,100.64.0.0/10`). Anfragen von anderen IPs (echte Client-IP über `ASM_TRUST_PROXY`) bekommen nur die öffentlichen Pfade, sonst 404. Ohne Variable: Verhalten wie bisher (alles erlaubt).

## Web Push
- Standard Web Push (VAPID, RFC 8291 – Inhalt Ende-zu-Ende verschlüsselt; Apple sieht nichts). Bibliothek `web-push`.
- VAPID-Schlüssel werden beim ersten Start erzeugt und in der DB gespeichert (privater Schlüssel mit dem Master-Key verschlüsselt). `GET /api/push/vapid-key` liefert den öffentlichen Schlüssel.
- Abos pro Nutzer und Browser: `POST /api/push/subscriptions` (Endpoint + Keys + Gerätename), `GET` Liste, `DELETE /:id`. Ungültige Abos (404/410 vom Push-Dienst) werden automatisch gelöscht.
- iPhone: ASM einmal im Heimnetz über „Zum Home-Bildschirm“ installieren (iOS ≥ 16.4), dann in den Einstellungen „Benachrichtigungen aktivieren“. Dafür bekommt die Web-App ein Manifest (`/manifest.webmanifest`) und einen Service Worker (`/sw.js`).
- Auslöser: neue Anfrage mit Status `pending` (nicht bei Auto-Modus-Freigabe) → Push an alle Abos des Gerätebesitzers.
- Inhalt der Benachrichtigung bewusst neutral (Sperrbildschirm): Titel „ASM“, Text „Neue Anfrage wartet auf Freigabe“. Keine Secret-Namen, Projekte oder Gründe. Payload enthält nur die Freigabe-URL.

## Einmal-Token
- Pro Anfrage und Abo-Versand ein Token: 32 Zufallsbytes base64url, in der DB nur als SHA-256 (`approve_tokens`: token_hash, request_id, user_id, expires_at = Anfrage-Ablauf, used_at).
- URL: `/approve/<token>`. Gültig nur für diese Anfrage, nur solange sie offen ist, wird bei Entscheidung (egal über welchen Weg) wertlos.

## Öffentliche Freigabe-Seite und API
- `GET /api/approve/:token` → Zusammenfassung: Gerätename, Secret-Titel/ENV-Name, Projekt, Grund, Art (Abruf/Änderung), Ablaufzeit. Ungültiger/abgelaufener/benutzter Token → 404 (einheitlich, ohne Unterscheidung). Rate-Limit 30/min/IP.
- `POST /api/approve/:token/options` → WebAuthn-Optionen nur mit den Passkeys des Besitzers, `userVerification: 'required'`, Challenge an den Token gebunden (5 min, einmalig).
- `POST /api/approve/:token/decision` `{ decision: 'approve'|'deny', response? }`:
  - `approve` verlangt eine gültige Passkey-Assertion **mit User-Verification** (Face ID) eines Passkeys des Besitzers. Dann gleicher Pfad wie die Freigabe im Dashboard (`decideRequest`), alle bestehenden Prüfungen (Tresor-Zugriff, Klartext-Flag, Gerät aktiv, Ablauf) greifen.
  - `deny` ohne Passkey möglich.
  - Token wird verbraucht; Audit wie bisher (`request.approved`/`request.denied`, Akteur = Nutzer) mit `meta.via = 'push'`.
- Keine Session, kein Cookie, keine Secret-Werte. Antworten mit `cache-control: no-store`.
- Seite `/approve/:token`: eigenständige, schlanke Ansicht im bestehenden Design (gleiche Tokens, hell/dunkel), ohne App-Shell; funktioniert ohne Login. Zustände: offen, entschieden, abgelaufen/ungültig, Fehler.

## Web-App
- Einstellungen → „Benachrichtigungen“: aktivieren (Berechtigung anfragen nur per Knopfdruck), Liste der eigenen Abos mit Gerätename, entfernen, „Test senden“.
- Hinweis, wenn nicht als Home-Bildschirm-App geöffnet (iOS erlaubt Push nur dort).

## Nicht-Ziele
Buttons direkt in der Benachrichtigung (iOS unterstützt das für Web Push nicht), native App, Telegram/Pushover, Push für andere Ereignisse.

## Verifikation
Server-Tests (Token-Lebenszyklus, UV-Pflicht, falscher Nutzer/Passkey, Netzwerk-Sperre per `ASM_TRUSTED_NETWORKS`, Push-Versand mit gemocktem `web-push`, Aufräumen ungültiger Abos), Web-Tests (Freigabe-Seite, Einstellungen), E2E mit virtuellem Authenticator; README mit Nginx-Proxy-Manager-Anleitung (Custom Locations bzw. Advanced-Config mit `allow`/`deny`).
