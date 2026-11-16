import type { Command } from 'commander';
import { ApiError } from '@asm/shared/api-client';
import { readConfig, writeConfig } from '../auth-store.js';
import { CliError, DEVICE_CODE_GRANT, EXIT, normalizeServer, serverHost, type Runtime } from '../runtime.js';

const SLOW_DOWN_S = 5;

/** OAuth device flow (RFC 8628): shows the user code, polls the token endpoint, stores the tokens. */
export async function login(rt: Runtime, url: string): Promise<void> {
  const server = normalizeServer(url);
  const api = rt.publicApi(server);
  const da = await api.deviceAuthorization({ client_name: 'asm-cli', hostname: rt.deps.hostname });
  rt.stderr.write(`Open ${da.verification_uri} and enter code ${da.user_code}\n`);
  let interval = Math.max(1, da.interval || 5);
  let remainingMs = da.expires_in * 1000;
  for (;;) {
    if (remainingMs <= 0) throw new CliError(EXIT.denied, 'login code expired');
    await rt.sleep(interval * 1000);
    remainingMs -= interval * 1000;
    try {
      const t = await api.token({ grant_type: DEVICE_CODE_GRANT, device_code: da.device_code });
      await rt.store.set(serverHost(server), {
        url: server, accessToken: t.access_token, refreshToken: t.refresh_token, expiresAt: Date.now() + t.expires_in * 1000,
      });
      writeConfig(rt.deps.configDir, { ...readConfig(rt.deps.configDir), defaultServer: server });
      rt.stderr.write(`Logged in to ${server}\n`);
      return;
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'authorization_pending') continue;
      if (err.code === 'slow_down') {
        interval += SLOW_DOWN_S;
        continue;
      }
      if (err.code === 'expired_token') throw new CliError(EXIT.denied, 'login code expired');
      if (err.code === 'access_denied') throw new CliError(EXIT.denied, 'login denied');
      throw err;
    }
  }
}

export function registerLogin(program: Command, rt: (o?: { insecureStore?: boolean }) => Runtime): void {
  program
    .command('login')
    .description('Pair this machine with an ASM server (device flow)')
    .argument('<url>', 'server URL, e.g. https://asm.example.com')
    .option('--insecure-store', 'store the tokens in ~/.config/asm/credentials.json (0600) instead of the OS keyring')
    .action(async (url: string, o: { insecureStore?: boolean }) => login(rt(o.insecureStore ? { insecureStore: true } : {}), url));
}
