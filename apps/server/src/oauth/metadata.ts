import type { FastifyInstance } from 'fastify';
import type { ModuleDeps } from '../app.js';

/** The protected resource (MCP endpoint) served by this instance. */
export const mcpResource = (origin: string): string => `${origin}/mcp`;

export const protectedResourceMetadataUrl = (origin: string): string => `${origin}/.well-known/oauth-protected-resource`;

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    device_authorization_endpoint: `${origin}/oauth/device_authorization`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:device_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [] as string[],
  };
}

export function registerMetadataRoutes(app: FastifyInstance, deps: ModuleDeps): void {
  const origin = deps.config.publicUrl.origin;
  const asMeta = authorizationServerMetadata(origin);
  const prMeta = { resource: mcpResource(origin), authorization_servers: [origin], bearer_methods_supported: ['header'] };
  app.get('/.well-known/oauth-authorization-server', async () => asMeta);
  app.get('/.well-known/oauth-protected-resource', async () => prMeta);
  // RFC 9728 §3.1: path-suffixed location for the resource `${origin}/mcp`.
  app.get('/.well-known/oauth-protected-resource/mcp', async () => prMeta);
}
