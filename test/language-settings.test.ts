import { describe, expect, it } from 'vitest';
import {
  effectiveOptions,
  InvalidSettingsError,
  languageStatus,
  parseSettings,
  storedSettings,
} from '../server/src/language-settings';
import settingsService from '../server/src/services/settings';

const LOCALES = ['en', 'de', 'fr-CH', 'en-GB', 'de-LI'];

describe('language settings (combo boxes)', () => {
  it('validates what the page sends against the locales and Supertext’s list', () => {
    expect(parseSettings({ de: { code: 'de-CH', politeness: 'more' }, en: { code: 'en-us' }, 'de-LI': { code: '' } }, LOCALES)).toEqual({
      de: { code: 'de-CH', politeness: 'more' },
      en: { code: 'en-US' },
    });
    expect(() => parseSettings({ xx: { code: 'de-CH' } }, LOCALES)).toThrow(InvalidSettingsError);
    expect(() => parseSettings({ de: { code: 'de' } }, LOCALES)).toThrow(InvalidSettingsError);
    expect(() => parseSettings({ de: { code: 'de-CH', politeness: 'very' } }, LOCALES)).toThrow(InvalidSettingsError);
    // English has no formal/informal.
    expect(() => parseSettings({ en: { code: 'en-US', politeness: 'more' } }, LOCALES)).toThrow(InvalidSettingsError);
    expect(() => parseSettings('de=de-CH', LOCALES)).toThrow(InvalidSettingsError);
  });

  it('reads only valid entries from the store', () => {
    expect(storedSettings({ de: { code: 'de-ch', politeness: 'less' }, en: { code: 'nope' }, x: 3 })).toEqual({
      de: { code: 'de-CH', politeness: 'less' },
    });
    expect(storedSettings(null)).toEqual({});
  });

  it('lets locales in config/plugins win per field', () => {
    expect(effectiveOptions({ de: { code: 'de-CH', politeness: 'more' }, en: { code: 'en-GB' } }, { de: { code: 'de-AT' } })).toEqual({
      de: { code: 'de-AT', politeness: 'more' },
      en: { code: 'en-GB' },
    });
  });

  it('lists every locale with what is saved, suggested, overridden and sent', () => {
    const rows = [
      { code: 'en', name: 'English' },
      { code: 'de', name: 'German' },
      { code: 'fr-CH', name: 'French (Switzerland)' },
      { code: 'de-LI', name: 'German (Liechtenstein)' },
    ];
    const status = languageStatus(rows, { de: { code: 'de-CH', politeness: 'more' } }, { 'fr-CH': { politeness: 'less' } });
    expect(status).toEqual([
      { code: 'en', name: 'English', target: 'en-US', saved: null, suggested: 'en-US', override: {}, politeness: 'default', savedPoliteness: 'default', politenessSupported: false, review: false, savedReview: false },
      { code: 'de', name: 'German', target: 'de-CH', saved: 'de-CH', suggested: 'de-DE', override: {}, politeness: 'more', savedPoliteness: 'more', politenessSupported: true, review: false, savedReview: false },
      { code: 'fr-CH', name: 'French (Switzerland)', target: 'fr-CH', saved: null, suggested: 'fr-CH', override: { politeness: 'less' }, politeness: 'less', savedPoliteness: 'default', politenessSupported: true, review: false, savedReview: false },
      { code: 'de-LI', name: 'German (Liechtenstein)', target: null, saved: null, suggested: null, override: {}, politeness: 'default', savedPoliteness: 'default', politenessSupported: null, review: false, savedReview: false },
    ]);
  });

  it('stores the mapping in the core store and translations use it with the config override', async () => {
    const store = new Map<string, unknown>();
    const key = (s: { type: string; name: string; key: string }) => `${s.type}_${s.name}_${s.key}`;
    const strapi = {
      config: { get: () => ({ locales: { en: { code: 'en-GB' } } }) },
      plugin: (name: string) => (name === 'i18n' ? { service: () => ({ find: async () => LOCALES.map((code) => ({ code, name: code })) }) } : undefined),
      store: {
        get: async (s: { type: string; name: string; key: string }) => store.get(key(s)),
        set: async (s: { type: string; name: string; key: string; value: unknown }) => void store.set(key(s), s.value),
      },
      log: { debug() {} },
    };
    const service = settingsService({ strapi } as never);
    const page = await service.save({ de: { code: 'de-CH' }, en: { code: 'en-US' } });
    expect(store.get('plugin_supertext_languages')).toEqual({ de: { code: 'de-CH' }, en: { code: 'en-US' } });
    expect(page.targets.length).toBe(37);
    expect(page.languages.find((l) => l.code === 'en')).toMatchObject({ saved: 'en-US', target: 'en-GB', override: { code: 'en-GB' } });
    expect(await service.mapping()).toEqual({ de: { code: 'de-CH' }, en: { code: 'en-GB' } });
    await expect(service.save({ de: { code: 'klingon' } })).rejects.toBeInstanceOf(InvalidSettingsError);
  });

  it('keeps Translation review per locale (off by default; config/plugins wins)', () => {
    expect(parseSettings({ de: { code: 'de-CH', review: true }, en: { review: false }, 'fr-CH': { review: true } }, LOCALES)).toEqual({
      de: { code: 'de-CH', review: true },
      'fr-CH': { review: true },
    });
    expect(() => parseSettings({ de: { review: 'yes' } }, LOCALES)).toThrow(InvalidSettingsError);
    expect(storedSettings({ de: { review: true }, en: { review: 'yes' }, fr: { code: 'fr-CH' } })).toEqual({ de: { review: true }, fr: { code: 'fr-CH' } });
    expect(effectiveOptions({ de: { review: true }, en: { review: true } }, { de: { review: false }, fr: { review: true } })).toEqual({
      de: {},
      en: { review: true },
      fr: { review: true },
    });
    const [de, en] = languageStatus([{ code: 'de' }, { code: 'en' }], { de: { review: true }, en: { review: true } }, { en: { review: false } });
    expect(de).toMatchObject({ review: true, savedReview: true, override: {} });
    expect(en).toMatchObject({ review: false, savedReview: true, override: { review: false } });
  });
});
