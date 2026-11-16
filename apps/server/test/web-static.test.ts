import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createTestApp } from './helpers/testApp.js';

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function makeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asm-web-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>ASM</title><div id="root"></div>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'console.log(1)');
  writeFileSync(join(dir, 'theme-init.js'), '/* theme */');
  return dir;
}

function expectHtmlHeaders(res: { headers: Record<string, unknown> }) {
  expect(res.headers['content-security-policy']).toBe(CSP);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(String(res.headers['cache-control'])).toContain('no-cache');
  expect(String(res.headers['content-type'])).toContain('text/html');
}

describe('web UI static serving', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await createTestApp({ webDistDir: makeDist() }));
  });
  afterEach(async () => app.close());

  it('serves index.html at / with security headers and no-cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<div id="root">');
    expectHtmlHeaders(res);
  });

  it('falls back to index.html for client-side routes', async () => {
    for (const url of ['/login', '/setup', '/secrets?selected=sec_1', '/connect?req=abc', '/audit/deep/link']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toContain('<div id="root">');
      expectHtmlHeaders(res);
    }
  });

  it('serves hashed assets with a long immutable cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/assets/index-abc123.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves non-hashed root files without long cache', async () => {
    const res = await app.inject({ method: 'GET', url: '/theme-init.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('serves /index.html directly with the same headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/index.html' });
    expect(res.statusCode).toBe(200);
    expectHtmlHeaders(res);
  });

  it('never falls back for API, OAuth, well-known, MCP and health paths', async () => {
    for (const url of ['/api/does-not-exist', '/api', '/oauth/nope', '/.well-known/nope', '/mcp/nope', '/healthz/x', '/assets/missing.js']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'not_found' });
    }
  });

  it('keeps API routes working', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ needsSetup: true });
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    expect(health.json()).toEqual({ status: 'ok' });
  });

  it('does not fall back for non-GET methods', async () => {
    const res = await app.inject({ method: 'POST', url: '/login' });
    expect(res.statusCode).toBe(404);
  });
});

describe('web UI static serving without a build', () => {
  it('starts without error when the dist folder is missing', async () => {
    const { app } = await createTestApp({ webDistDir: join(tmpdir(), 'asm-web-missing-dir-xyz') });
    const res = await app.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('is disabled by default in tests', async () => {
    const { app } = await createTestApp();
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
    await app.close();
  });
});
