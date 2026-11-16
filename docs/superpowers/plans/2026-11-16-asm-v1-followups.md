# ASM v1 – offene Punkte nach dem Review (deferred)

Aus den Task-Reviews und der Abschlussprüfung; bewusst nicht vor dem Merge behoben (niedriges Risiko). Grundlage für die nächste Runde.

- Note N1 (Task 4): chain can't detect deletion of trailing rows — candidate hardening for final review (e.g. store tip seq/hash separately)
- Task 4: minor (deferred): AuditRow.event typed string; missing tests for limit clamp, tamper meta/prev_hash, empty chain, filtered visibility; key-based meta guard can't catch secrets in string values.
- Note N2 (Task 5): auth.login_failed (system actor) invisible via queryAudit → admins should see system events; consider in Task 7/13 audit routes
- Task 5: review 1 → Needs fixes (Imp: Origin bypass via %-encoded path; concurrent setup two admins; spec gap: validation only in routes). Fix round 1 dispatched (+minors: revoke old session on login, origin on login/setup, clearCookie attrs).
- Task 5: minor (deferred): fastify internal error codes echoed lowercased; 500s log no stack; setup-token tests weak (createSetupState w/ existing users, logged once); expired sessions never cleaned; failed-login username stored in audit.
- Task 6: minor (deferred, worth fixing in final wave): userHandle not checked on discoverable login; zod parse before takeChallenge (challenge not consumed on malformed body); requireUserVerification false (consider UV required for secrets manager); credential_exists 409 cross-user oracle; no audit for passkey add/remove; realWebAuthn untested; 127.0.0.1 can't be RP ID (doc).
- Task 7: minor (deferred): user-actor project touch creates orphan projects.
- Task 8: minor (deferred, PRIORITY for final wave): (1) open redirector via open DCR on authorize errors → return 400 instead of redirect for unconsented DCR clients; (2) rate-limit GET /oauth/authorize (pending FIFO eviction flood); (3) activate preview has user_code in URL query (logged) → POST body; (6) device_code polling counts against 20/min token limit (exempt; document TRUST_PROXY).
- Task 8: minor (deferred): auth-code reuse doesn't revoke issued tokens; refresh not bound to client_id; orphan approved MCP devices without tokens / unactivated cli devices / rotated token rows; old access token valid ≤1h after rotation; nits (double errors import, reqInfo imported from secrets/routes, approve audit lacks clientName, redirect_uri required at token even if omitted at authorize).
- Task 9: minor (deferred): SSE backpressure; buildApp mutates caller hooks object.
- Task 9: minor (deferred): waitForRequest executor throw leaks waiter slot (wrap try/catch); waiters map module-level; devices→requests import direction; SSE closes up to 25 s after logout.
- Task 10: minor (deferred, worth final wave): update await returns current not applied version; no test for auto-approved plaintext via request_secret; abort race before redeem (check signal.aborted); search used_by_this_project ranking after limit + cross-user usage; no-store header on hijacked /mcp; close() unhandled promises; circular import rateLimitOpts app↔mcp; denialCause audit scan; cross-user MCP test.
- Task 11: minor (deferred): symlinked .env replaced; dotenv duplicate/multiline merge + Node dotenv escape compatibility; approved-version race in cli wait.
- Task 11: minor (deferred): dotenv \$ \` escapes not understood by plain npm dotenv (document with R11); bidi/format chars not stripped.
- Task 11: minor (deferred): stale-break race (3 contenders) in lock.ts; refresh_timeout lacks re-login hint; release read-then-unlink race; writePrivateFile guard untested; real-SIGINT test may be slow on CI.
- Task 12: minor (deferred): Verlängern writes odd defaultDurationMin (server extendBy).
- Task 13: minor (deferred): audit table ARIA semantics; activity feed not refreshed on secret events.
- Task 13: minor (deferred, PRIORITY final wave): safeRedirect normalizes '/.//evil.com' → '//evil.com' (reject normalized '//' prefix).
- Task 13: minor (deferred): passkey rename double PATCH; SecretValue identity lacks updatedAt; SecretFilter no debounce/arrow keys; PasswordSection hasPassword hint.
- Task 14: minor (deferred): e2e server log deleted on exit; double rmSync; no packageManager field; cli SIGINT timing test flake once.
- Fix-wave re-review B (auth/offboarding/oauth): all addressed; minors: MCP long-poll delays shutdown up to 50 s; disable revokes denied devices (cosmetic).

## Bekannte Grenzen v1
- Single-Instance: SSE, offene OAuth-Anfragen, WebAuthn-Challenges, Refresh-Lock-Wartende im Speicher.
- Web Push (Phase 2) nicht enthalten.
- MCP-Long-Poll (≤50 s) kann graceful shutdown verzögern (Docker SIGKILL nach 10 s; keine Datenverluste).
