import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
// The low-level Server (not McpServer) gives full control over argument validation and error payloads.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { rateLimitOpts, type ModuleDeps } from '../app.js';
import { HttpError } from '../errors.js';
import { bearerAuth } from '../oauth/bearer.js';
import { MAX_WAIT_MS } from '../requests/service.js';
import { reqInfo } from '../secrets/routes.js';
import { callTool, toolList, type ToolContext } from './tools.js';

/** Long-poll of await_request: below common client/proxy timeouts (60 s). */
export const MCP_AWAIT_TIMEOUT_MS = Math.min(MAX_WAIT_MS, 50_000);
export const MCP_RATE_LIMIT_PER_MIN = 120;

const INSTRUCTIONS =
  'ASM (Agent Secrets Manager) gives you access to the user\'s secrets with their approval. Search with search_secrets, request access with ' +
  'request_secret (prefer delivery "cli") and wait with await_request. Always pass the git repo / working-folder name as project and a concrete reason. ' +
  'Never print, log or commit secret values.';

export type McpDeps = ModuleDeps & { mcpAwaitTimeoutMs?: number };

export function createMcpServer(t: ToolContext): Server {
  const server = new Server({ name: 'asm', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: toolList() }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const res = await callTool(t, req.params.name, req.params.arguments);
    if (!res) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${req.params.name}`);
    return res;
  });
  return server;
}

export async function registerMcpRoutes(app: FastifyInstance, deps: McpDeps): Promise<void> {
  const { ctx, config } = deps;
  const publicOrigin = config.publicUrl.origin;
  const awaitTimeoutMs = deps.mcpAwaitTimeoutMs ?? MCP_AWAIT_TIMEOUT_MS;
  // preHandler hook: runs after bearerAuth so the limit is keyed by device.
  await app.register(rateLimit, { ...rateLimitOpts, hook: 'preHandler' });

  // DNS-rebinding protection: browsers always send Origin; it must be ours.
  const checkOrigin = async (req: FastifyRequest) => {
    if (req.headers.origin !== undefined && req.headers.origin !== publicOrigin) throw new HttpError(403, 'bad_origin');
  };

  app.post(
    '/mcp',
    {
      preHandler: [checkOrigin, bearerAuth({ db: ctx.db, clock: ctx.clock, publicOrigin })],
      config: {
        rateLimit: { max: MCP_RATE_LIMIT_PER_MIN, timeWindow: '1 minute', keyGenerator: (req: FastifyRequest) => req.device?.id ?? req.ip },
      },
    },
    async (req, reply) => {
      const abort = new AbortController();
      const server = createMcpServer({ ctx, device: req.device!, info: reqInfo(req), signal: abort.signal, awaitTimeoutMs, log: req.log });
      // Stateless: a fresh server + transport per POST, plain JSON responses (no SSE stream).
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      reply.hijack();
      const res = reply.raw;
      // ServerResponse 'close' also fires when the client disconnects early (IncomingMessage 'close' fires once the body is read).
      res.on('close', () => {
        if (!res.writableFinished) abort.abort();
        void transport.close();
        void server.close();
      });
      try {
        await server.connect(transport);
        await transport.handleRequest(req.raw, res, req.body);
      } catch (err) {
        req.log.error({ errName: (err as Error)?.name }, 'mcp request failed');
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: ErrorCode.InternalError, message: 'internal' }, id: null }));
        }
      }
    },
  );

  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) => reply.status(405).header('allow', 'POST').send({ error: 'method_not_allowed' });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
