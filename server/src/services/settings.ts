import type { Core } from '@strapi/strapi';
import type { PluginConfig } from '../config';
import { effectiveOptions, languageStatus, parseSettings, storedSettings, type LanguageSettings } from '../language-settings';
import { targetOptions } from '../supertext/languages';

/** Where the settings page's language mapping lives: Strapi's core store, key `plugin_supertext_languages`. */
const scope = { type: 'plugin', name: 'supertext', key: 'languages' } as const;

/**
 * The language mapping of Settings → Supertext (one combo box per Strapi locale), combined with
 * `locales` in config/plugins, which overrides it per locale.
 */
const settings = ({ strapi }: { strapi: Core.Strapi }) => {
  const overrides = () => (strapi.config.get('plugin::supertext') as PluginConfig).locales ?? {};

  const strapiLocales = async (): Promise<{ code: string; name?: string }[]> => {
    try {
      return (await strapi.plugin('i18n')?.service('locales')?.find()) ?? [];
    } catch (error) {
      strapi.log.debug(`[supertext] Could not read the locales: ${(error as Error).message}`);
      return [];
    }
  };

  const saved = async (): Promise<LanguageSettings> => storedSettings(await strapi.store.get(scope));
  /** Every Strapi locale with its saved, suggested and effective Supertext code. */
  const languages = async () => languageStatus(await strapiLocales(), await saved(), overrides());
  /** The settings page: the rows, the target codes for the combo boxes and whether Translation review is available. */
  const page = async () => ({
    languages: await languages(),
    targets: targetOptions(),
    reviewAvailable: Boolean(((strapi.config.get('plugin::supertext') as PluginConfig).reviewUrl ?? '').trim()),
  });

  return {
    saved,
    languages,
    page,

    /** The mapping translations use: config/plugins wins, then the settings page. */
    async mapping() {
      return effectiveOptions(await saved(), overrides());
    },

    /** Validates against the Strapi locales and Supertext's list, then stores (InvalidSettingsError otherwise). */
    async save(input: unknown) {
      const locales = (await strapiLocales()).map(({ code }) => code);
      const value = parseSettings(input, locales, overrides());
      await strapi.store.set({ ...scope, value });
      return page();
    },
  };
};

export default settings;
export type SettingsService = ReturnType<typeof settings>;
