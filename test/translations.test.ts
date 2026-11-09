import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '../admin/src/translations');
const load = (locale: string) => JSON.parse(readFileSync(join(dir, `${locale}.json`), 'utf8')) as Record<string, string>;
const en = load('en');
const locales = readdirSync(dir)
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''));

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const tags = (text: string) => [...text.matchAll(/<\/?(\w+)>/g)].map((m) => m[0]).sort();
const urls = (text: string) => [...text.matchAll(/https:\/\/\S+?(?=[\s)]|$)/g)].map((m) => m[0]).sort();

const sources = (path: string): string =>
  readdirSync(path, { withFileTypes: true })
    .map((entry) =>
      entry.isDirectory() ? sources(join(path, entry.name)) : /\.tsx?$/.test(entry.name) ? readFileSync(join(path, entry.name), 'utf8') : ''
    )
    .join('\n');

describe('admin translations', () => {
  it('ships English, German, French and Italian', () => {
    expect(locales.sort()).toEqual(['de', 'en', 'fr', 'it']);
  });

  for (const locale of locales.filter((l) => l !== 'en')) {
    it(`${locale} has exactly the English keys, placeholders, tags and URLs`, () => {
      const messages = load(locale);
      expect(Object.keys(messages).sort()).toEqual(Object.keys(en).sort());
      for (const [key, text] of Object.entries(en)) {
        expect(placeholders(messages[key]), key).toEqual(placeholders(text));
        expect(tags(messages[key]), key).toEqual(tags(text));
        expect(urls(messages[key]), key).toEqual(urls(text));
        expect(messages[key].split('Supertext').length, key).toBe(text.split('Supertext').length);
        // A straight apostrophe before { or < starts an ICU quote and hides the placeholder.
        expect(messages[key], key).not.toMatch(/'[{<]/);
      }
    });
  }

  it('has a message for every key the admin panel uses', () => {
    const admin = sources(join(__dirname, '../admin/src'));
    const used = [...admin.matchAll(/getTranslation\('([\w.]+)'\)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(10);
    for (const key of used) {
      expect(en, key).toHaveProperty([key]);
    }
    for (const status of ['created', 'updated']) {
      expect(en).toHaveProperty([`panel.result.${status}`]);
    }
    // The API key check's results (texts from the Commando Center's guide).
    for (const status of ['ok', 'invalid', 'missing', 'unreachable', 'error']) {
      expect(en).toHaveProperty([`keycheck.${status}`]);
    }
  });

  it('has a message for every error code the server sends', () => {
    const server = ['controllers/translate.ts', 'services/translator.ts', 'services/files.ts', 'supertext/client.ts']
      .map((file) => readFileSync(join(__dirname, '../server/src', file), 'utf8'))
      .join('\n');
    const codes = new Set([
      ...[...server.matchAll(/Error\(\s*(?:'[^']*'|`[^`]*`),\s*(?:\d+|undefined),\s*'(\w+)'/g)].map((m) => m[1]),
      ...[...server.matchAll(/code: '(\w+)'/g)].map((m) => m[1]),
      ...[...server.matchAll(/\[\s*'(\w+)',\s*['`]/g)].map((m) => m[1]),
    ]);
    expect(codes.size).toBeGreaterThan(15);
    expect(codes).toContain('unsupportedLanguage');
    expect(codes).toContain('unsupportedFeature');
    for (const code of codes) {
      expect(en, code).toHaveProperty([`error.${code}`]);
    }
  });
});
