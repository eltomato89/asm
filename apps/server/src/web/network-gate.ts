import { BlockList, isIPv4 } from 'node:net';
import type { FastifyInstance } from 'fastify';
import type { Cidr } from '../config.js';

/**
 * Paths reachable from outside ASM_TRUSTED_NETWORKS: the approval page and its API, the bundled assets it loads,
 * and health. Matched against the raw path (no query), so dot segments or percent-encoding never match.
 */
const PUBLIC_PATHS = [
  /^\/approve\/[A-Za-z0-9_-]{1,128}\/?$/,
  /^\/api\/approve\/[A-Za-z0-9_-]{1,128}(?:\/options|\/decision)?$/,
  /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/,
  /^\/(?:favicon\.svg|theme-init\.js|healthz|sw\.js|manifest\.webmanifest|icons\/icon-(?:180|192|512)\.png)$/,
];

export function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some((re) => re.test(path));
}

/** Client address as an IPv4/IPv6 pair; IPv4-mapped IPv6 (::ffff:a.b.c.d) is treated as IPv4. */
function normalizeIp(ip: string): { address: string; family: 'ipv4' | 'ipv6' } {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') && isIPv4(lower.slice(7))) return { address: lower.slice(7), family: 'ipv4' };
  return isIPv4(ip) ? { address: ip, family: 'ipv4' } : { address: ip, family: 'ipv6' };
}

export function createTrustedMatcher(networks: Cidr[]): (ip: string) => boolean {
  const list = new BlockList();
  for (const n of networks) list.addSubnet(n.address, n.prefix, n.family);
  return (ip) => {
    try {
      const { address, family } = normalizeIp(ip);
      return list.check(address, family);
    } catch {
      return false;
    }
  };
}

/** Untrusted clients (by req.ip, which honours ASM_TRUST_PROXY) only reach the public paths; everything else is a 404. */
export function installNetworkGate(app: FastifyInstance, networks: Cidr[]): void {
  const trusted = createTrustedMatcher(networks);
  app.addHook('onRequest', async (req, reply) => {
    if (trusted(req.ip)) return;
    const path = req.url.split('?')[0] ?? '/';
    if (isPublicPath(path)) return;
    if (path === '/api' || path.startsWith('/api/')) return reply.status(404).send({ error: 'not_found' });
    return reply.status(404).type('text/plain; charset=utf-8').send('Not Found');
  });
}
