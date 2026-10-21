import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { AddressInfo } from 'net';
import { checkForUpdate, compareVersions, platformAssetSuffix } from '../update.js';

// --- compareVersions ---
describe('compareVersions', () => {
  it('orders simple semver', () => {
    expect(compareVersions('0.8.0', '0.7.0')).toBeGreaterThan(0);
    expect(compareVersions('0.7.0', '0.8.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.7.0', '0.7.0')).toBe(0);
  });

  it('handles different segment counts and missing parts as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0);
    expect(compareVersions('2', '1.9.9')).toBeGreaterThan(0);
  });
});

describe('platformAssetSuffix', () => {
  it('matches the release.yml asset naming', () => {
    const suffix = platformAssetSuffix();
    expect(suffix).toMatch(/^(linux|macos|win)-(x64|arm64)$/);
  });
});

// --- checkForUpdate against a stub GitHub API ---
describe('checkForUpdate', () => {
  let server: http.Server;
  let apiUrl: string;
  const originalFetch = globalThis.fetch;

  const releasePayload = {
    tag_name: 'v0.9.0',
    html_url: 'https://github.com/deda-ca/llama-cpp-config-gui/releases/tag/v0.9.0',
    published_at: '2026-10-21T00:00:00Z',
    assets: [
      { name: 'llama-cpp-config-gui-v0.9.0-linux-x64.zip', browser_download_url: 'https://example.com/linux.zip' },
      { name: 'llama-cpp-config-gui-v0.9.0-macos-arm64.zip', browser_download_url: 'https://example.com/mac.zip' },
    ],
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/latest') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(releasePayload));
      } else if (req.url === '/notfound') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: 'Not Found' }));
      } else {
        res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  function stubFetchTo(path: string) {
    globalThis.fetch = ((input: any, init: any) => {
      const url = typeof input === 'string' ? input : String(input);
      const mapped = url.replace('https://api.github.com/repos/deda-ca/llama-cpp-config-gui/releases/latest', apiUrl + path);
      return originalFetch(mapped, init);
    }) as typeof fetch;
  }

  it('reports an update as available with the matching platform asset', async () => {
    stubFetchTo('/latest');
    const check = await checkForUpdate('0.7.0');
    expect(check.available).toBe(true);
    expect(check.latest).toBe('0.9.0');
    expect(check.current).toBe('0.7.0');
    expect(check.releaseUrl).toContain('/releases/tag/v0.9.0');
    expect(check.assetName).toContain(platformAssetSuffix());
    expect(check.assetUrl).toMatch(/^https:\/\//);
    expect(check.publishedAt).toBe('2026-10-21T00:00:00Z');
  });

  it('reports no update when current equals latest', async () => {
    stubFetchTo('/latest');
    const check = await checkForUpdate('0.9.0');
    expect(check.available).toBe(false);
    expect(check.assetName).toBeNull();
    expect(check.assetUrl).toBeNull();
  });

  it('reports no update when current is ahead of latest', async () => {
    stubFetchTo('/latest');
    const check = await checkForUpdate('1.0.0');
    expect(check.available).toBe(false);
  });

  it('throws on API error status', async () => {
    stubFetchTo('/notfound');
    await expect(checkForUpdate('0.7.0')).rejects.toThrow(/404/);
  });

  it('asset selection prefers the current platform', async () => {
    stubFetchTo('/latest');
    const check = await checkForUpdate('0.7.0');
    expect(check.assetName).toContain(platformAssetSuffix());
  });
});
