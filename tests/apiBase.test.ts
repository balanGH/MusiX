/**
 * Where backend requests go, and what they carry.
 *
 * The defaults must stay exactly what the desktop app has always used —
 * same-origin `/api`, no headers — and a server chosen in Settings must reach
 * every kind of request, including the media URLs that cannot send headers.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiHeaders,
  apiMediaUrl,
  apiRoot,
  apiUrl,
  configureServer,
  hasCustomServer,
  normalizeServerUrl,
} from '@core/net/apiBase';
import { probeServer } from '@core/net/serverStatus';

afterEach(() => {
  configureServer({ url: '', token: '' });
  vi.unstubAllGlobals();
});

describe('apiBase', () => {
  it('defaults to same-origin /api with no auth header', () => {
    expect(hasCustomServer()).toBe(false);
    expect(apiRoot()).toBe('/api');
    expect(apiUrl('/health')).toBe('/api/health');
    expect(apiMediaUrl('/jobs/a/stems/vocals')).toBe('/api/jobs/a/stems/vocals');
    expect(apiHeaders()).toEqual({});
    expect(apiHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('uses a configured server and token', () => {
    configureServer({ url: 'http://192.168.1.5:8000/', token: ' s3cret ' });
    expect(hasCustomServer()).toBe(true);
    expect(apiUrl('/health')).toBe('http://192.168.1.5:8000/api/health');
    expect(apiHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer s3cret',
    });
  });

  it('puts the token in the query string for media URLs', () => {
    configureServer({ url: '192.168.1.5:8000', token: 'a b&c' });
    expect(apiMediaUrl('/jobs/j/stems/drums')).toBe(
      'http://192.168.1.5:8000/api/jobs/j/stems/drums?token=a%20b%26c',
    );
    expect(apiMediaUrl('/x?y=1')).toBe('http://192.168.1.5:8000/api/x?y=1&token=a%20b%26c');
  });

  it('sends a token to the default server too', () => {
    configureServer({ url: '', token: 'local' });
    expect(apiUrl('/jobs')).toBe('/api/jobs');
    expect(apiHeaders()).toEqual({ Authorization: 'Bearer local' });
  });

  it('normalises what people type', () => {
    expect(normalizeServerUrl('  ')).toBe('');
    expect(normalizeServerUrl('192.168.1.5:8000')).toBe('http://192.168.1.5:8000');
    expect(normalizeServerUrl('http://pc.local:8000/api/')).toBe('http://pc.local:8000');
    expect(normalizeServerUrl('https://example.com//')).toBe('https://example.com');
  });
});

describe('probeServer', () => {
  const respond = (status: number, body: unknown) =>
    vi.fn(async () =>
      typeof body === 'string'
        ? new Response(body, { status })
        : new Response(JSON.stringify(body), { status }),
    );

  it('reports ok with the version, sending the token', async () => {
    configureServer({ url: 'http://pc:8000', token: 't' });
    const fetchMock = respond(200, { status: 'ok', version: '1.0.0', auth: 'required' });
    vi.stubGlobal('fetch', fetchMock);
    expect(await probeServer()).toEqual({ state: 'ok', version: '1.0.0' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://pc:8000/api/health');
    expect(init.headers).toEqual({ Authorization: 'Bearer t' });
  });

  it('tells a wrong password from a missing one', async () => {
    configureServer({ url: 'http://pc:8000', token: 'bad' });
    vi.stubGlobal('fetch', respond(401, { detail: 'Wrong password' }));
    expect((await probeServer()).state).toBe('wrong-token');

    configureServer({ url: 'http://pc:8000', token: '' });
    vi.stubGlobal('fetch', respond(200, { status: 'ok', auth: 'required' }));
    expect((await probeServer()).state).toBe('needs-token');
  });

  it('reports an unreachable server and a non-MusiX answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    expect((await probeServer()).state).toBe('unreachable');

    vi.stubGlobal('fetch', respond(200, '<!doctype html><html></html>'));
    expect((await probeServer()).state).toBe('not-musix');
  });
});
