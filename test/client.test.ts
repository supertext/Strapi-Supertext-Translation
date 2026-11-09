import { describe, expect, it } from 'vitest';
import { REVIEW_URL, SupertextClient, USER_AGENT } from '../server/src/supertext/client';
import pluginConfig from '../server/src/config';

type Call = { method: string; url: string; body?: FormData };

type Init = RequestInit & { headers?: Record<string, string> };

const fakeFetch = (handler: (call: Call) => Response) => {
  const calls: (Call & { headers: Headers })[] = [];
  const fn = (async (url: string, init: Init) => {
    const headers = new Headers(init.headers);
    // The SDK builds the multipart body itself; read it back as FormData.
    const type = headers.get('content-type') ?? '';
    const body = type.startsWith('multipart/form-data')
      ? await new Response(init.body as BodyInit, { headers: { 'content-type': type } }).formData()
      : undefined;
    const call = { method: init.method ?? 'GET', url, body, headers };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
};

describe('SupertextClient', () => {
  it('submits, polls, downloads and deletes', async () => {
    let polls = 0;
    const { fn, calls } = fakeFetch(({ method, url }) => {
      if (method === 'POST') return Response.json({ file_id: 'f1' });
      if (url.endsWith('/status')) return Response.json({ status: ++polls < 2 ? 'running' : 'done' });
      if (url.endsWith('/translation')) return new Response('<div data-st-id="0">Hallo</div>');
      return Response.json({});
    });
    const client = new SupertextClient({ apiKey: 'k', endpoint: 'https://api.test/v1', pollIntervalMs: 1, fetch: fn });
    const html = await client.translateDocument('<div>Hi</div>', { targetLanguage: 'de-CH', sourceLanguage: 'en', politeness: 'more' });

    expect(html).toContain('Hallo');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.test/v1/', '')}`)).toEqual([
      'POST translate/ai/file',
      'GET translate/ai/file/f1/status',
      'GET translate/ai/file/f1/status',
      'GET translate/ai/file/f1/translation',
      'DELETE translate/ai/file/f1',
    ]);
    const form = calls[0].body!;
    expect(form.get('target_lang')).toBe('de-CH');
    expect(form.get('source_lang')).toBe('en');
    expect(form.get('politeness')).toBe('more');
    expect((form.get('file') as File).type).toBe('text/html');
  });

  it('explains authentication errors and still deletes nothing it never created', async () => {
    const { fn, calls } = fakeFetch(() => new Response('{"detail":"bad key"}', { status: 401 }));
    const client = new SupertextClient({ apiKey: 'wrong', fetch: fn });
    await expect(client.translateDocument('<p>x</p>', { targetLanguage: 'fr' })).rejects.toThrow(/Authentication failed.*bad key/);
    await expect(client.validate()).rejects.toMatchObject({ code: 'authFailed', values: { detail: expect.stringContaining('bad key') } });
    expect(calls).toHaveLength(2);
  });

  it('stops on limit_exceeded and cleans up', async () => {
    const { fn, calls } = fakeFetch(({ method, url }) =>
      method === 'POST' ? Response.json({ file_id: 'f2' }) : url.endsWith('/status') ? Response.json({ status: 'limit_exceeded' }) : Response.json({})
    );
    const client = new SupertextClient({ apiKey: 'k', fetch: fn });
    await expect(client.translateDocument('<p>x</p>', { targetLanguage: 'fr' })).rejects.toThrow(/limit is exceeded/);
    expect(calls.at(-1)?.method).toBe('DELETE');
  });

  it('maps an unsupported language pair to its own code', async () => {
    const { fn } = fakeFetch(() => new Response('{"error_code":"INVALID_LANGUAGE_PAIR","source_lang":"en","target_lang":"xx"}', { status: 400 }));
    await expect(new SupertextClient({ apiKey: 'k', fetch: fn }).translateDocument('<p>x</p>', { targetLanguage: 'xx', sourceLanguage: 'en' })).rejects.toMatchObject({
      code: 'invalidLanguagePair',
    });
  });

  it('refuses to start without an API key', () => {
    expect(() => new SupertextClient({ apiKey: '' })).toThrow(/No Supertext API key/);
  });
});

describe('API key', () => {
  it('accepts the key with or without the Supertext-Auth-Key prefix', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({}));
    await new SupertextClient({ apiKey: ' Supertext-Auth-Key abc+/= ', fetch: fn }).validate();
    await new SupertextClient({ apiKey: 'abc+/=', fetch: fn }).validate();
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(['Supertext-Auth-Key abc+/=', 'Supertext-Auth-Key abc+/=']);
  });
});

describe('rate limiting', () => {
  it('retries after HTTP 429 and then succeeds', async () => {
    let limited = 2;
    const { fn } = fakeFetch(({ method, url }) => {
      if (method === 'POST') return limited-- > 0 ? new Response('rate limit', { status: 429 }) : Response.json({ file_id: 'f3' });
      if (url.endsWith('/status')) return Response.json({ status: 'done' });
      if (url.endsWith('/translation')) return new Response('<div data-st-id="0">Hallo</div>');
      return Response.json({});
    });
    const waits: number[] = [];
    const client = new SupertextClient({ apiKey: 'k', fetch: fn, sleep: async (ms) => void waits.push(ms) });
    expect(await client.translateDocument('<div>Hi</div>', { targetLanguage: 'de-CH' })).toContain('Hallo');
    expect(waits).toHaveLength(2);
  });

  it('gives up after a few retries', async () => {
    const { fn, calls } = fakeFetch(() => new Response('rate limit', { status: 429 }));
    const client = new SupertextClient({ apiKey: 'k', fetch: fn, sleep: async () => undefined });
    await expect(client.validate()).rejects.toThrow(/Too many requests/);
    expect(calls).toHaveLength(5);
  });

  it('honours Retry-After', async () => {
    const { retryDelayMs } = await import('../server/src/vendor/supertext-sdk/v1/index');
    expect(retryDelayMs(0, '3')).toBe(3000);
    expect(retryDelayMs(1, null)).toBeGreaterThanOrEqual(2000);
  });

  describe('Translation review', () => {
    const roundTrip = () =>
      fakeFetch(({ method, url }) => {
        if (method === 'POST') return Response.json({ file_id: 'f1' });
        if (url.endsWith('/status')) return Response.json({ status: 'done' });
        if (url.endsWith('/translation')) return new Response('<div data-st-id="0">Hallo</div>');
        return Response.json({});
      });
    const calls = (list: { method: string; url: string }[]) => list.map((c) => `${c.method} ${c.url}`);

    it('sends a review locale through the review service (all four calls) and the others directly', async () => {
      const { fn, calls: made } = roundTrip();
      const client = new SupertextClient({ apiKey: 'k', endpoint: 'https://api.test/v1', reviewEndpoint: 'https://review.test/v1/', pollIntervalMs: 1, fetch: fn });
      expect(client.forReview(false)).toBe(client);
      const review = client.forReview(true);
      expect(review).not.toBe(client);
      expect(client.forReview(true)).toBe(review); // one review client

      await review.translateDocument('<div data-st-id="0">Hi</div>', { targetLanguage: 'de-CH' });
      expect(calls(made)).toEqual([
        'POST https://review.test/v1/translate/ai/file',
        'GET https://review.test/v1/translate/ai/file/f1/status',
        'GET https://review.test/v1/translate/ai/file/f1/translation',
        'DELETE https://review.test/v1/translate/ai/file/f1',
      ]);
      // Same key and User-Agent as the direct client.
      expect(made.every((c) => c.headers.get('authorization') === 'Supertext-Auth-Key k')).toBe(true);
      expect(made[0].headers.get('user-agent')).toContain(USER_AGENT);

      made.length = 0;
      await client.translateDocument('<div data-st-id="0">Hi</div>', { targetLanguage: 'fr-CH' });
      expect(made.every((c) => c.url.startsWith('https://api.test/v1/'))).toBe(true);
      expect(made).toHaveLength(4);
    });

    it('is off with an empty review URL or the same URL as the API', () => {
      expect(new SupertextClient({ apiKey: 'k', reviewEndpoint: '' }).forReview(true)).toBeInstanceOf(SupertextClient);
      const off = new SupertextClient({ apiKey: 'k', reviewEndpoint: '' });
      expect(off.forReview(true)).toBe(off);
      const same = new SupertextClient({ apiKey: 'k', endpoint: 'https://api.test/v1', reviewEndpoint: 'https://api.test/v1/' });
      expect(same.forReview(true)).toBe(same);
    });

    it('defaults to Supertext’s review service (SUPERTEXT_REVIEW_URL overrides it)', () => {
      const before = process.env.SUPERTEXT_REVIEW_URL;
      try {
        delete process.env.SUPERTEXT_REVIEW_URL;
        expect(pluginConfig.default().reviewUrl).toBe(REVIEW_URL);
        expect(REVIEW_URL).toBe('https://localizationreview-production.up.railway.app/v1/');
        process.env.SUPERTEXT_REVIEW_URL = 'http://localhost:3000/v1/';
        expect(pluginConfig.default().reviewUrl).toBe('http://localhost:3000/v1/');
      } finally {
        if (before === undefined) delete process.env.SUPERTEXT_REVIEW_URL;
        else process.env.SUPERTEXT_REVIEW_URL = before;
      }
      expect(() => pluginConfig.validator({ locales: { de: { review: 'yes' as never } } })).toThrow(/review/);
      expect(() => pluginConfig.validator({ reviewUrl: 3 as never })).toThrow(/reviewUrl/);
    });

    it('names the plugin and its version in the User-Agent', () => {
      expect(USER_AGENT).toMatch(/^Strapi-Supertext-Translation\/\d+\.\d+\.\d+/);
    });
  });
});
