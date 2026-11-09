import { describe, expect, it } from 'vitest';
import { politenessFor, sourceCode, suggestTarget, supportsPoliteness, targetCode, targetCodeOrNull, targetOptions } from '../server/src/supertext/languages';

describe('language codes (mapping, exact match, default)', () => {
  it('sends a bare source language', () => {
    expect(sourceCode('en')).toBe('en');
    expect(sourceCode('')).toBe('');
    expect(sourceCode('en-US')).toBe('en');
    expect(sourceCode('en_GB')).toBe('en');
    expect(sourceCode('DE-ch')).toBe('de');
  });

  it('uses a Strapi locale that is a Supertext code, ignoring case and underscores', () => {
    expect(targetCode('it-CH')).toBe('it-CH');
    expect(targetCode('de_ch')).toBe('de-CH');
    expect(targetCode('fr-ch')).toBe('fr-CH');
    expect(targetCode('es')).toBe('es');
    expect(targetCode('zh-hant')).toBe('zh-Hant');
  });

  it('uses the SDK default where one is obvious', () => {
    expect(targetCode('de')).toBe('de-DE');
    expect(targetCode('en')).toBe('en-US');
    expect(targetCode('pt')).toBe('pt-PT');
    expect(targetCode('zh-CN')).toBe('zh-Hans');
    expect(targetCode('zh-TW')).toBe('zh-Hant');
    expect(targetCode('es-ES')).toBe('es');
    expect(suggestTarget('de')).toBe('de-DE');
    expect(suggestTarget('fr_ch')).toBe('fr-CH');
  });

  it('refuses locales without a mapping, a match or a default', () => {
    for (const code of ['en-IE', 'de-LI', 'gsw', 'xx']) {
      expect(() => targetCode(code), code).toThrow(expect.objectContaining({ code: 'unsupportedLanguage', values: { language: code } }));
      expect(suggestTarget(code), code).toBeNull();
    }
    expect(targetCodeOrNull('de-LI')).toBeNull();
    expect(() => sourceCode('xx')).toThrow(expect.objectContaining({ code: 'unsupportedLanguage' }));
  });

  it('lets the configured code win and sends it as it is', () => {
    expect(targetCode('de', 'de-AT')).toBe('de-AT');
    expect(targetCode('ch', 'gsw-u-sd-chzh')).toBe('gsw-u-sd-chzh');
    expect(targetCodeOrNull('zh-CN', 'zh-Hans')).toBe('zh-Hans');
    // The source is the language of the configured code.
    expect(sourceCode('ch', 'de-CH')).toBe('de');
  });

  it('uses one mapping for both directions', () => {
    expect(targetCode('de', 'de-CH')).toBe('de-CH');
    expect(sourceCode('de', 'de-CH')).toBe('de');
    expect(targetCode('en', 'en-US')).toBe('en-US');
    expect(sourceCode('en', 'en-US')).toBe('en');
  });

  it('knows which targets offer formal/informal and never drops a setting silently', () => {
    expect(supportsPoliteness('de-CH')).toBe(true);
    expect(supportsPoliteness('en-US')).toBe(false);
    expect(politenessFor('de-CH', 'more')).toBe('more');
    expect(politenessFor('en-US', undefined)).toBe('default');
    expect(politenessFor('en-US', 'default')).toBe('default');
    expect(() => politenessFor('en-US', 'more', 'en')).toThrow(expect.objectContaining({ code: 'unsupportedFeature', values: { language: 'en' } }));
    // A mapped code the SDK doesn't list: sent as configured.
    expect(politenessFor('xx-YY', 'less')).toBe('less');
  });

  it('offers every Supertext target for the combo box', () => {
    const options = targetOptions();
    expect(options.length).toBe(37);
    expect(options).toContainEqual({ code: 'de-CH', name: 'German (Switzerland)', politeness: true });
    expect(options.find((o) => o.code === 'en-US')?.politeness).toBe(false);
  });
});
