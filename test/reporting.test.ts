import { describe, expect, it } from 'vitest';
import { absoluteUrl, installedPlugins, Reporting, siteUrl, versionReportsEnabled, type ReportingSettings } from '../server/src/reporting';
import { pluginVersion } from '../server/src/version';
import { SDK_VERSION } from '../server/src/vendor/supertext-sdk/index';

/** The core store, in memory (Strapi serializes the value as JSON). */
function memoryStorage() {
  const box: { value: string | null } = { value: null };
  return {
    box,
    storage: {
      get: async () => (box.value === null ? null : JSON.parse(box.value)),
      set: async (value: unknown) => void (box.value = JSON.stringify(value)),
    },
  };
}

/** fetch for both Supertext (GET features) and the center (POST report). */
function fakeFetch(features = 200) {
  const reports: any[] = [];
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(String(url));
    if (String(url).endsWith('/features')) return new Response('{}', { status: features });
    reports.push(JSON.parse(String(init?.body)));
    return new Response('{"ok":true}', { status: 202 });
  };
  return { fetch: fetch as never, reports, calls };
}

const logger = { debug() {} };

function reporting(settings: ReportingSettings, f = fakeFetch(), storage = memoryStorage().storage) {
  return new Reporting({
    storage,
    settings: () => settings,
    strapiVersion: () => '5.57.0',
    apiPrefix: () => '/api',
    logger,
    reporterOverrides: { fetch: f.fetch, reportUrl: 'https://center.test/api/v1/report' },
    clientOverrides: { fetch: f.fetch, baseUrl: 'https://api.test/v1/' },
  });
}

describe('settings', () => {
  it('reports are on by default; versionReports: false and SUPERTEXT_VERSION_REPORTS=0 turn them off', () => {
    expect(versionReportsEnabled({}, undefined)).toBe(true);
    expect(versionReportsEnabled({ versionReports: true }, undefined)).toBe(true);
    expect(versionReportsEnabled({ versionReports: false }, undefined)).toBe(false);
    expect(versionReportsEnabled({ versionReports: true }, '0')).toBe(false);
    expect(versionReportsEnabled({}, 'off')).toBe(false);
  });

  it('takes the site URL from server.url if absolute, else from the request', () => {
    expect(absoluteUrl('https://cms.example.ch/')).toBe('https://cms.example.ch');
    expect(siteUrl('https://cms.example.ch/', 'http://10.0.0.1:1337')).toBe('https://cms.example.ch');
    expect(siteUrl('', 'https://cms.example.ch')).toBe('https://cms.example.ch');
    expect(siteUrl('/strapi', undefined)).toBeNull();
  });
});

describe('Reporting', () => {
  it('checks the key, reports the installation once and keeps the state in the store', async () => {
    const f = fakeFetch();
    const { storage, box } = memoryStorage();
    const r = reporting({ apiKey: 'k1' }, f, storage);
    const first = await r.run('onRequest', 'https://cms.example.ch');
    expect(first?.event).toBe('installed');
    expect(first?.check?.status).toBe('ok');
    expect(f.reports[0]).toMatchObject({
      schema: 1,
      event: 'installed',
      site_url: 'https://cms.example.ch',
      plugin: { name: 'Strapi-Supertext-Translation', version: pluginVersion() },
      system: { name: 'Strapi', version: '5.57.0' },
      runtime: { name: 'Node.js' },
      sdk_version: SDK_VERSION,
      api_key_configured: true,
      api_key_check: { status: 'ok', http_status: 200 },
      callback: { url: 'https://cms.example.ch/api/supertext/ping' },
    });
    expect(JSON.stringify(f.reports)).not.toContain('k1');
    expect(box.value).toContain('"reportedKeyStatus":"ok"');
    expect(box.value).not.toContain('k1');
    // Nothing changed: no second report, no second key check.
    const second = await r.run('onRequest', 'https://cms.example.ch');
    expect(second?.event).toBeNull();
    expect(f.reports).toHaveLength(1);
    expect(f.calls.filter((u) => u.endsWith('/features'))).toHaveLength(1);
    expect((await r.lastCheck())?.status).toBe('ok');
  });

  it('checks again when the key changed', async () => {
    const f = fakeFetch();
    const { storage } = memoryStorage();
    await reporting({ apiKey: 'k1' }, f, storage).run('onRequest', 'https://cms.example.ch');
    await reporting({ apiKey: 'k2' }, f, storage).run('onRequest', 'https://cms.example.ch');
    expect(f.calls.filter((u) => u.endsWith('/features'))).toHaveLength(2);
  });

  it('marks the key invalid after a 401 and reports the change once', async () => {
    const f = fakeFetch();
    const r = reporting({ apiKey: 'k1' }, f);
    await r.run('onRequest', 'https://cms.example.ch');
    await r.run('authenticationFailed', 'https://cms.example.ch', 401);
    await r.run('authenticationFailed', 'https://cms.example.ch', 401);
    expect(f.reports.map((x) => x.event)).toEqual(['installed', 'api_key_check']);
    expect(f.reports[1].api_key_check).toMatchObject({ status: 'invalid', http_status: 401 });
  });

  it('Test connection checks the key every time', async () => {
    const f = fakeFetch(403);
    const r = reporting({ apiKey: 'k1' }, f);
    expect((await r.run('testConnection', 'https://cms.example.ch'))?.check?.status).toBe('invalid');
    expect((await r.run('testConnection', 'https://cms.example.ch'))?.check?.status).toBe('invalid');
    expect(f.calls.filter((u) => u.endsWith('/features'))).toHaveLength(2);
  });

  it('a missing key is "missing" and nothing is sent to Supertext', async () => {
    const f = fakeFetch();
    const result = await reporting({}, f).run('testConnection', 'https://cms.example.ch');
    expect(result?.check?.status).toBe('missing');
    expect(f.calls.filter((u) => u.endsWith('/features'))).toHaveLength(0);
  });

  it('sends nothing with reports off, but still checks the key', async () => {
    const f = fakeFetch();
    const r = reporting({ apiKey: 'k1', versionReports: false }, f);
    expect((await r.run('onRequest', 'https://cms.example.ch'))?.check?.status).toBe('ok');
    expect(f.reports).toHaveLength(0);
    expect(r.enabled).toBe(false);
    expect(r.ping('abcdefghijklmnop1234').status).toBe(404);
  });

  it('does nothing without a site URL', async () => {
    const f = fakeFetch();
    expect(await reporting({ apiKey: 'k1' }, f).run('onRequest', null)).toBeNull();
    expect(f.calls).toHaveLength(0);
  });

  it('answers the ping only for a valid challenge', () => {
    const r = reporting({});
    const ok = r.ping('abcdefghijklmnop1234');
    expect(ok.status).toBe(200);
    expect(ok.headers).toMatchObject({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    expect(JSON.parse(ok.body)).toEqual({ ok: true, plugin: 'Strapi-Supertext-Translation', challenge: 'abcdefghijklmnop1234' });
    expect(r.ping('short').status).toBe(400);
    expect(r.ping(['abcdefghijklmnop1234']).status).toBe(400);
    expect(r.ping('<script>alert(1)</script>xx').body).toBe('{"ok":false}');
  });

  it('never throws when the store fails', async () => {
    const broken = { get: async () => { throw new Error('db down'); }, set: async () => { throw new Error('db down'); } };
    const r = reporting({ apiKey: 'k1' }, fakeFetch(), broken);
    await expect(r.run('onRequest', 'https://cms.example.ch')).resolves.toBeNull();
    await expect(r.lastCheck()).resolves.toBeNull();
  });
});

describe('Send configuration to Supertext', () => {
  it('lists the installed plugins without Strapi’s own and this one', () => {
    expect(
      installedPlugins({
        i18n: { packageInfo: { name: '@strapi/i18n', version: '5.57.0' } },
        supertext: { packageInfo: { name: 'strapi-supertext-translation', version: '1.0.0' } },
        seo: { packageInfo: { name: '@strapi-community/plugin-seo', version: '2.1.0' } },
        local: {},
      })
    ).toEqual([
      { name: '@strapi-community/plugin-seo', version: '2.1.0', active: true, type: 'plugin' },
      { name: 'local', version: null, active: true, type: 'plugin' },
    ]);
    expect(installedPlugins(undefined)).toEqual([]);
  });

  it('sends the plugins and the language mapping in one extensions report', async () => {
    const f = fakeFetch();
    const r = reporting({ apiKey: 'k1' }, f);
    const result = await r.sendConfiguration(
      'https://cms.example.ch',
      [{ name: '@strapi-community/plugin-seo', version: '2.1.0', active: true, type: 'plugin' }],
      [{ code: 'de-CH', supertext: 'de-CH' }, { code: 'en-IE', supertext: null }]
    );
    expect(result?.sent).toBe(true);
    expect(f.reports).toHaveLength(1);
    expect(f.reports[0]).toMatchObject({
      event: 'extensions',
      extensions: [{ name: '@strapi-community/plugin-seo', version: '2.1.0' }],
      languages: [{ code: 'de-CH', supertext: 'de-CH' }, { code: 'en-IE', supertext: null }],
    });
    expect(JSON.stringify(f.reports[0])).not.toContain('k1');
  });

  it('sends nothing with reports off', async () => {
    const f = fakeFetch();
    const r = reporting({ apiKey: 'k1', versionReports: false }, f);
    await expect(r.sendConfiguration('https://cms.example.ch', [], [{ code: 'de', supertext: 'de-DE' }])).resolves.toBeNull();
    expect(f.reports).toEqual([]);
  });
});
