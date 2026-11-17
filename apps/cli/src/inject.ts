import { ApiError, type ApiClient } from '@asm/shared/api-client';
import { CliError, EXIT, type Runtime } from './runtime.js';
import { stripControl } from './sanitize.js';

/** Same rule as the server's EnvNameSchema. */
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export type Mapping = { id: string; env?: string };
export type EnvVar = { name: string; value: string };

/** Parses `<id>[=ENV]`. */
export function parseMapping(spec: string, what: 'grant' | 'secret'): Mapping {
  const eq = spec.indexOf('=');
  const id = (eq < 0 ? spec : spec.slice(0, eq)).trim();
  const env = eq < 0 ? undefined : spec.slice(eq + 1).trim();
  const prefix = what === 'grant' ? 'grt_' : 'sec_';
  if (!id.startsWith(prefix) || id.length > 100) throw new CliError(EXIT.usage, `invalid --${what}: ${spec}`);
  if (env !== undefined && !ENV_NAME_RE.test(env)) throw new CliError(EXIT.usage, `invalid env name in --${what} ${spec}`);
  return { id, env };
}

/** Env names from the server are re-validated before they reach a process env or a dotenv file. */
function checkServerName(name: string): void {
  if (!ENV_NAME_RE.test(name)) throw new CliError(EXIT.api, 'invalid_env_name');
}

function assertUnique(names: string[]): void {
  const seen = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) throw new CliError(EXIT.usage, `duplicate env name ${n}; map one of them with =OTHER_NAME`);
    seen.add(n);
  }
}

/**
 * Redeems one grant. A grant of a linked device group (a Claude Code device with its attached CLIs) can only be redeemed
 * by that group's CLI: the server answers 403 `wrong_device_group`, which gets an explanation instead of the bare code
 * (same exit code as every other API error).
 */
async function redeem(api: ApiClient, grantId: string, hostname: string) {
  try {
    return await api.redeemGrant(grantId, hostname);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'wrong_device_group') {
      throw new CliError(
        EXIT.api,
        `wrong_device_group: grant ${grantId} belongs to another device group, so this CLI cannot redeem it. ` +
          'Link this CLI to that Claude Code device in ASM → Devices, or run the command from the CLI attached to it.',
      );
    }
    throw err;
  }
}

const noEnvName = (secretId: string, flag: string) =>
  new CliError(EXIT.usage, `secret ${secretId} has no env name; map it with ${flag}=ENV_NAME`);

/**
 * Collects env vars from grants (`--grant`) and from new requests (`--secret`, waits for approval).
 * Values only ever end up in the returned list (never printed).
 */
export async function collectEnv(
  rt: Runtime,
  input: { grants: string[]; secrets: string[]; project?: string; reason?: string },
): Promise<EnvVar[]> {
  const grants = input.grants.map((g) => parseMapping(g, 'grant'));
  const secrets = input.secrets.map((s) => parseMapping(s, 'secret'));
  if (grants.length + secrets.length === 0) throw new CliError(EXIT.usage, 'give at least one --grant or --secret');
  if (secrets.length > 0 && (input.reason === undefined || input.reason.trim() === '')) throw new CliError(EXIT.usage, '--secret requires --reason');

  const api = rt.api();
  const project = secrets.length > 0 ? rt.project(input.project) : '';
  const created = [];
  for (const s of secrets) {
    const dto = await api.createRequest({ secretId: s.id, project, reason: input.reason! });
    const name = s.env ?? dto.secret.envName;
    if (!name) throw noEnvName(s.id, `--secret ${s.id}`);
    checkServerName(name);
    created.push({ s, dto, name });
  }
  // Names known before anything is redeemed (explicit mappings, env names of the requested secrets).
  assertUnique([...grants.flatMap((g) => (g.env ? [g.env] : [])), ...created.map((c) => c.name)]);

  const fromRequests: Mapping[] = [];
  for (const { s, dto } of created) {
    const done = await rt.awaitDecision(dto);
    if (!done.grantId) throw new CliError(EXIT.api, `request ${stripControl(done.id)}: grant_gone`);
    fromRequests.push({ id: done.grantId, env: s.env });
  }

  const vars: EnvVar[] = [];
  for (const g of [...grants, ...fromRequests]) {
    const { secrets: redeemed } = await redeem(api, g.id, rt.deps.hostname);
    for (const r of redeemed) {
      const name = g.env ?? r.envName;
      if (!name) throw noEnvName(stripControl(r.secretId), `--grant ${g.id}`);
      checkServerName(name);
      vars.push({ name, value: r.value });
    }
  }
  assertUnique(vars.map((v) => v.name));
  return vars;
}
