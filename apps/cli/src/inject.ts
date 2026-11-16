import { CliError, EXIT, type Runtime } from './runtime.js';

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
  const fromRequests: Mapping[] = [];
  const created = [];
  for (const s of secrets) {
    const dto = await api.createRequest({ secretId: s.id, project, reason: input.reason! });
    if (!s.env && !dto.secret.envName) throw noEnvName(s.id, `--secret ${s.id}`);
    created.push({ s, dto });
  }
  for (const { s, dto } of created) {
    const done = await rt.awaitDecision(dto);
    if (!done.grantId) throw new CliError(EXIT.api, `request ${done.id}: grant_gone`);
    fromRequests.push({ id: done.grantId, env: s.env });
  }

  const vars: EnvVar[] = [];
  for (const g of [...grants, ...fromRequests]) {
    const { secrets: redeemed } = await api.redeemGrant(g.id, rt.deps.hostname);
    for (const r of redeemed) {
      const name = g.env ?? r.envName;
      if (!name) throw noEnvName(r.secretId, `--grant ${g.id}`);
      vars.push({ name, value: r.value });
    }
  }
  return vars;
}
