import { LIVE_ENDPOINT, REVIEW_URL, type Politeness } from '../supertext/client';

export interface LocaleOptions {
  /**
   * The Supertext code for this locale (the language mapping), e.g. `de-CH` for the Strapi locale
   * `de`. Needed for every locale that isn't itself a Supertext code; sent as it is.
   */
  code?: string;
  /** "more" = formal (Sie/vous), "less" = informal (du/tu). */
  politeness?: Politeness;
  /**
   * Translation review: translations into this locale go through Supertext's review service
   * (`reviewUrl`). Overrides the checkbox under Settings → Supertext → Translation.
   */
  review?: boolean;
}

export interface PluginConfig {
  /** Supertext API key. Defaults to the SUPERTEXT_API_KEY environment variable. */
  apiKey?: string;
  /** API base URL. Defaults to SUPERTEXT_API_ENDPOINT or the live API. */
  endpoint?: string;
  /**
   * The review service for locales with *Translation review* on. Defaults to SUPERTEXT_REVIEW_URL
   * or Supertext's review service; '' turns review off for every locale.
   */
  reviewUrl: string;
  pollIntervalMs: number;
  pollTimeoutMs: number;
  /** Per-locale options, keyed by Strapi locale code (e.g. "de-CH"). */
  locales: Record<string, LocaleOptions>;
  /** Restrict translation to these content-type UIDs. Empty = every localized type. */
  contentTypes: string[];
  /**
   * "Send version information to Supertext" (default on). SUPERTEXT_VERSION_REPORTS=0 turns it
   * off as well and wins over this option.
   */
  versionReports: boolean;
}

export default {
  default: (): PluginConfig => ({
    apiKey: process.env.SUPERTEXT_API_KEY,
    endpoint: process.env.SUPERTEXT_API_ENDPOINT || LIVE_ENDPOINT,
    // An empty SUPERTEXT_REVIEW_URL keeps the default; set reviewUrl: '' to turn review off.
    reviewUrl: process.env.SUPERTEXT_REVIEW_URL || REVIEW_URL,
    pollIntervalMs: 2000,
    pollTimeoutMs: 180_000,
    locales: {},
    contentTypes: [],
    versionReports: true,
  }),
  validator(config: Partial<PluginConfig>) {
    for (const [locale, options] of Object.entries(config.locales ?? {})) {
      if (options?.politeness && !['default', 'more', 'less'].includes(options.politeness)) {
        throw new Error(`supertext: locales.${locale}.politeness must be "default", "more" or "less".`);
      }
      if (options?.review !== undefined && typeof options.review !== 'boolean') {
        throw new Error(`supertext: locales.${locale}.review must be true or false.`);
      }
    }
    if (config.reviewUrl !== undefined && typeof config.reviewUrl !== 'string') {
      throw new Error('supertext: reviewUrl must be a URL or an empty string.');
    }
    if (config.versionReports !== undefined && typeof config.versionReports !== 'boolean') {
      throw new Error('supertext: versionReports must be true or false.');
    }
    if (config.contentTypes && !Array.isArray(config.contentTypes)) {
      throw new Error('supertext: contentTypes must be an array of content-type UIDs.');
    }
  },
};
