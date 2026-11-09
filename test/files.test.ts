import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import controller from '../server/src/controllers/translate';
import files, { formatReference, MAX_UPLOAD_BYTES, parseReference, type ImportResult } from '../server/src/services/files';
import translator from '../server/src/services/translator';
import { TranslationFiles } from '../server/src/vendor/supertext-sdk/index';

const UID = 'api::article.article';

const contentTypes = {
  [UID]: {
    pluginOptions: { i18n: { localized: true } },
    attributes: {
      title: { type: 'string' },
      slug: { type: 'uid', targetField: 'title' },
      subtitle: { type: 'string' },
      sku: { type: 'string', pluginOptions: { i18n: { localized: false } } },
      body: { type: 'blocks' },
      seo: { type: 'component', component: 'shared.seo' },
    },
  },
  'api::tag.tag': { attributes: { name: { type: 'string' } } },
};
const components = { 'shared.seo': { attributes: { metaTitle: { type: 'string' } } } };

type Doc = Record<string, unknown>;
let docs: Map<string, Doc>;
let updates: Array<{ documentId: string; locale: string; data: Doc }>;

const fakeStrapi = () => {
  const services: Record<string, unknown> = {};
  const strapi = {
    config: { get: () => ({ apiKey: '', endpoint: 'https://api.supertext.com/v1/', locales: {}, contentTypes: [] }) },
    contentTypes,
    components,
    log: { debug() {}, warn() {}, error() {} },
    documents: () => ({
      findOne: async ({ documentId, locale }: { documentId: string; locale: string }) =>
        structuredClone(docs.get(`${documentId}|${locale}`) ?? null),
      update: async ({ documentId, locale, data }: { documentId: string; locale: string; data: Doc }) => {
        updates.push({ documentId, locale, data: structuredClone(data) });
        docs.set(`${documentId}|${locale}`, { ...(docs.get(`${documentId}|${locale}`) ?? {}), ...structuredClone(data) });
      },
    }),
    db: {
      query: () => ({
        findMany: async ({ where }: { where: { documentId: string } }) =>
          [...docs.keys()].filter((k) => k.startsWith(`${where.documentId}|`)).map((k) => ({ locale: k.split('|')[1] })),
      }),
    },
    plugin: (name: string) => ({
      service: (service: string) => {
        if (name === 'i18n') return { find: async () => ['en', 'de-CH', 'fr', 'de-LI'].map((code) => ({ code })) };
        if (name === 'content-manager') return { generateUIDField: async ({ data }: { data: Doc }) => `slug-${String(data.title).toLowerCase().replace(/\W+/g, '-')}` };
        return services[service];
      },
    }),
  };
  services.translator = translator({ strapi } as never);
  services.files = files({ strapi } as never);
  services.settings = { mapping: async () => ({ fr: { code: 'fr-CH' } }) };
  return { strapi, service: services.files as ReturnType<typeof files> };
};

const source = (): Doc => ({
  id: 1,
  documentId: 'doc1',
  locale: 'en',
  title: 'Swiss chocolate',
  slug: 'swiss-chocolate',
  subtitle: 'Fresh daily',
  sku: 'CH-1',
  body: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'bold', bold: true }, { type: 'text', text: ' world' }] }],
  seo: { id: 3, metaTitle: 'Buy chocolate' },
});

const translateXliff = (xliff: string, fn: (source: string, id: string) => string | null) =>
  xliff.replace(/<trans-unit id="([^"]+)"([^>]*)>\s*<source>([\s\S]*?)<\/source>/g, (all, id: string, attrs: string, src: string) => {
    const target = fn(src, id);
    return target === null ? all : `<trans-unit id="${id}"${attrs}>\n<source>${src}</source><target>${target}</target>`;
  });

const allow = () => true;

beforeEach(() => {
  docs = new Map([['doc1|en', source()]]);
  updates = [];
});

describe('references', () => {
  it('round-trips the content type, entry and locales', () => {
    const ref = { uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocale: 'de-CH' };
    expect(formatReference(ref)).toBe('entry:api%3A%3Aarticle.article:doc1:en:de-CH');
    expect(parseReference(formatReference(ref))).toEqual(ref);
  });

  it.each(['', 'page:12', 'entry:x:doc1:en', 'entry::doc1:en:fr', 'entry:%E0:doc1:en:fr'])('refuses %j', (ref) => {
    expect(parseReference(ref)).toBeNull();
  });
});

describe('export', () => {
  it('exports XLIFF with the extraction keys and the mapped languages', async () => {
    const { service } = fakeStrapi();
    const file = await service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: ['fr', 'de-LI'], format: 'xliff' });
    expect(file.filename).toBe('strapi-article-doc1.xlf');
    expect(file.contentType).toBe('application/x-xliff+xml');
    const read = TranslationFiles.read(file.body);
    expect(read.map((f) => [f.plugin, f.reference, f.sourceLanguage, f.targetLanguage])).toEqual([
      ['Strapi-Supertext-Translation', 'entry:api%3A%3Aarticle.article:doc1:en:fr', 'en', 'fr-CH'],
      // No Supertext language for de-LI: the Strapi code, so the file can still go to a translator.
      ['Strapi-Supertext-Translation', 'entry:api%3A%3Aarticle.article:doc1:en:de-LI', 'en', 'de-LI'],
    ]);
    expect(read[0].units.map((u) => u.key)).toEqual(['title', 'subtitle', 'body.0', 'seo.metaTitle']);
  });

  it('exports HTML for exactly one target and says when there is nothing to translate', async () => {
    const { service } = fakeStrapi();
    const html = await service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: ['de-CH'], format: 'html' });
    expect(html.filename).toBe('strapi-article-doc1-de-CH.html');
    expect(html.contentType).toBe('text/html; charset=utf-8');
    await expect(
      service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: ['de-CH', 'fr'], format: 'html' })
    ).rejects.toMatchObject({ code: 'fileHtmlOneLocale' });

    docs.set('doc2|en', { documentId: 'doc2', title: '', sku: 'x' });
    await expect(
      service.exportEntry({ uid: UID, documentId: 'doc2', sourceLocale: 'en', targetLocales: ['fr'], format: 'xliff' })
    ).rejects.toMatchObject({ code: 'fileNothing', status: 422 });
  });
});

describe('import', () => {
  const exportXliff = async (service: ReturnType<typeof files>, targets = ['fr']) =>
    (await service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: targets, format: 'xliff' })).body;

  it('writes translations with the API write-back (new locale gets a slug, structure kept)', async () => {
    const { service } = fakeStrapi();
    const file = translateXliff(await exportXliff(service, ['fr', 'de-CH']), (s) => `[t] ${s}`);
    const results = await service.importFile({ content: file, includeChanged: false, canEdit: allow });
    expect(results).toEqual([
      { uid: UID, documentId: 'doc1', targetLocale: 'fr', imported: 4, sourceChanged: 0, untranslated: 0, invalid: 0, missing: 0 },
      { uid: UID, documentId: 'doc1', targetLocale: 'de-CH', imported: 4, sourceChanged: 0, untranslated: 0, invalid: 0, missing: 0 },
    ]);
    const fr = docs.get('doc1|fr')!;
    expect(fr.title).toBe('[t] Swiss chocolate');
    expect(fr.slug).toBe('slug--t-swiss-chocolate');
    expect(fr).not.toHaveProperty('sku');
    expect((fr.seo as Doc).metaTitle).toBe('[t] Buy chocolate');
    expect((fr.body as any)[0].children).toEqual([
      { type: 'text', text: '[t] Hello ' },
      { type: 'text', text: 'bold', bold: true },
      { type: 'text', text: ' world' },
    ]);
    expect(docs.get('doc1|en')!.title).toBe('Swiss chocolate');
  });

  it('writes texts whose source changed only with the option', async () => {
    const { service } = fakeStrapi();
    const file = translateXliff(await exportXliff(service), (s) => `FR ${s}`);
    docs.set('doc1|en', { ...source(), title: 'Swiss chocolate, new' });

    const skipped = await service.importFile({ content: file, includeChanged: false, canEdit: allow });
    expect(skipped[0]).toMatchObject({ imported: 3, sourceChanged: 1 });
    // fr had no title yet: like an API translation, the untranslated place gets the source text.
    expect(docs.get('doc1|fr')!.title).toBe('Swiss chocolate, new');

    const included = await service.importFile({ content: file, includeChanged: true, canEdit: allow });
    expect(included[0]).toMatchObject({ imported: 4, sourceChanged: 0 });
    expect(docs.get('doc1|fr')!.title).toBe('FR Swiss chocolate');
  });

  it("doesn't write untranslated, invalid or missing texts and keeps the target's own", async () => {
    docs.set('doc1|fr', { documentId: 'doc1', locale: 'fr', title: 'Chocolat suisse', subtitle: 'Frais', slug: 'chocolat', body: [{ type: 'paragraph', children: [{ type: 'text', text: 'Bonjour' }] }] });
    const { service } = fakeStrapi();
    const file = translateXliff(await exportXliff(service), (s, id) =>
      id === 'title' ? null : id === 'body.0' ? 'Salut <bpt id="9">&lt;i&gt;</bpt>x<ept id="9">&lt;/i&gt;</ept>' : `FR ${s}`
    ).replace(/<trans-unit id="subtitle"[\s\S]*?<\/trans-unit>/, '');
    const results = await service.importFile({ content: file, includeChanged: false, canEdit: allow });
    expect(results[0]).toMatchObject({ imported: 1, untranslated: 1, invalid: 1, missing: 1, sourceChanged: 0 });
    const fr = docs.get('doc1|fr')!;
    expect(fr.title).toBe('Chocolat suisse');
    expect(fr.subtitle).toBe('Frais');
    expect(fr.slug).toBe('chocolat'); // an existing translation keeps its URL
    expect((fr.body as any)[0].children).toEqual([{ type: 'text', text: 'Bonjour' }]);
    expect((fr.seo as Doc).metaTitle).toBe('FR Buy chocolate');
  });

  it('imports HTML; markup the source lacks is refused', async () => {
    const { service } = fakeStrapi();
    const { body } = await service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: ['de-CH'], format: 'html' });
    const ok = await service.importFile({
      content: body.replace('>Swiss chocolate<', '>Schweizer Schokolade<').replace('<strong>bold</strong>', '<strong>fett</strong>'),
      includeChanged: false,
      canEdit: allow,
    });
    expect(ok[0]).toMatchObject({ imported: 4, invalid: 0 });
    expect(docs.get('doc1|de-CH')!.title).toBe('Schweizer Schokolade');

    const bad = await service.importFile({ content: body.replace(/>Hello .*? world</, '>Hallo <script>alert(1)</script> Welt<'), includeChanged: false, canEdit: allow });
    expect(bad[0]).toMatchObject({ imported: 3, invalid: 1 });
    expect(JSON.stringify(docs.get('doc1|de-CH'))).not.toContain('alert');
  });

  it('refuses files of other systems, unknown entries, missing locales and missing permissions', async () => {
    const { service } = fakeStrapi();
    const job = (plugin: string, reference: string) => ({
      plugin,
      reference,
      sourceLanguage: 'en',
      targetLanguage: 'fr-CH',
      segments: [{ key: 'title', text: 'Swiss chocolate' }],
    });
    const ref = (uid: string, documentId: string, target: string) => formatReference({ uid, documentId, sourceLocale: 'en', targetLocale: target });
    const file = translateXliff(
      TranslationFiles.exportXliff([
        job('Payload-Supertext-Translation', 'x'),
        job('Strapi-Supertext-Translation', 'page:12'),
        job('Strapi-Supertext-Translation', ref(UID, 'gone', 'fr')),
        job('Strapi-Supertext-Translation', ref('api::tag.tag', 'doc1', 'fr')),
        job('Strapi-Supertext-Translation', ref(UID, 'doc1', 'it')),
        job('Strapi-Supertext-Translation', ref(UID, 'doc1', 'de-CH')),
        job('Strapi-Supertext-Translation', ref(UID, 'doc1', 'fr')),
      ]),
      (s) => `FR ${s}`
    );
    const results = await service.importFile({ content: file, includeChanged: false, canEdit: (_uid, _s, target) => target !== 'de-CH' });
    expect(results.map((r: ImportResult) => r.code ?? `imported ${r.imported}`)).toEqual([
      'fileOtherSystem',
      'fileNotFound',
      'fileNotFound',
      'fileNotFound',
      'fileNoLanguage',
      'forbiddenEdit',
      'imported 1',
    ]);
    expect(results[0].values).toEqual({ plugin: 'Payload-Supertext-Translation' });
    expect(results[4].values).toEqual({ language: 'it' });
    expect(updates.map((u) => u.locale)).toEqual(['fr']);
  });

  it('reports unreadable files with their codes', async () => {
    const { service } = fakeStrapi();
    await expect(service.importFile({ content: 'hello', includeChanged: false, canEdit: allow })).rejects.toMatchObject({ code: 'fileInvalid', status: 422 });
    await expect(
      service.importFile({ content: '<!DOCTYPE html><html><head></head><body></body></html>', includeChanged: false, canEdit: allow })
    ).rejects.toMatchObject({ code: 'fileMissingMetadata' });
  });
});

describe('controller', () => {
  const ctx = (extra: Record<string, unknown>) => {
    const c: Record<string, any> = {
      query: {},
      state: { userAbility: {} },
      body: undefined,
      status: 200,
      headers: {},
      set(h: Record<string, string>) {
        Object.assign(c.headers, h);
      },
      forbidden(message: string) {
        c.status = 403;
        c.body = { error: { message } };
      },
      badRequest(message: string) {
        c.status = 400;
        c.body = { error: { message } };
      },
      ...extra,
    };
    return c;
  };
  const withPermissions = (canUpdate: boolean) => {
    const { strapi } = fakeStrapi();
    const plugin = strapi.plugin;
    (strapi as any).plugin = (name: string) =>
      name === 'content-manager'
        ? {
            service: (s: string) =>
              s === 'permission-checker'
                ? { create: () => ({ cannot: { read: () => false, update: () => !canUpdate, create: () => !canUpdate } }) }
                : plugin(name).service(s),
          }
        : plugin(name);
    return controller({ strapi } as never);
  };

  it('sends the export as a download and checks the permissions', async () => {
    const c = ctx({ query: { model: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: 'fr', format: 'html' }, request: {} });
    await withPermissions(true).exportFile(c as never);
    expect(c.status).toBe(200);
    expect(c.headers['Content-Disposition']).toBe('attachment; filename="strapi-article-doc1-fr.html"');
    expect(String(c.body)).toContain('supertext:reference');

    const denied = ctx({ query: { model: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: 'fr' }, request: {} });
    await withPermissions(false).exportFile(denied as never);
    expect(denied.status).toBe(403);
  });

  it('imports an upload, deletes the temporary file and refuses files over 10 MB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'supertext-'));
    const { service } = fakeStrapi();
    const content = translateXliff(
      (await service.exportEntry({ uid: UID, documentId: 'doc1', sourceLocale: 'en', targetLocales: ['fr'], format: 'xliff' })).body,
      (s) => `FR ${s}`
    );
    const path = join(dir, 'upload');
    writeFileSync(path, content);
    const c = ctx({ request: { files: { file: { filepath: path, size: content.length } }, body: { includeChanged: '0' } } });
    await withPermissions(true).importFile(c as never);
    expect(c.body.results[0]).toMatchObject({ imported: 4, targetLocale: 'fr' });
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, 'x');
    const big = ctx({ request: { files: { file: { filepath: path, size: MAX_UPLOAD_BYTES + 1 } }, body: {} } });
    await withPermissions(true).importFile(big as never);
    expect(big.status).toBe(413);
    expect(big.body.error.details.code).toBe('fileTooLarge');
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, content);
    const denied = ctx({ request: { files: { file: { filepath: path, size: content.length } }, body: {} } });
    await withPermissions(false).importFile(denied as never);
    expect(denied.body.results[0]).toMatchObject({ code: 'forbiddenEdit' });
  });
});
