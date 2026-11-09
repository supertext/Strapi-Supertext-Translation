/**
 * The language mapping chosen under Settings → Supertext (one combo box per Strapi locale), kept
 * in Strapi's core store (`plugin_supertext_languages`), and how it combines with `locales` in
 * config/plugins, which overrides it per locale (for automated setups). No Strapi imports here
 * (tested on its own).
 */
import type { LocaleOptions } from './config';
import type { Politeness } from './supertext/client';
import { canonicalTarget, suggestTarget, supportsPoliteness, targetCodeOrNull } from './supertext/languages';

/** Saved per Strapi locale code: the Supertext target code, the tone and Translation review (only stored when on). */
export type LanguageSettings = Record<string, LocaleOptions>;

const POLITENESS: readonly Politeness[] = ['default', 'more', 'less'];

/** Thrown for a request the settings page shouldn't send (an unknown locale or code). */
export class InvalidSettingsError extends Error {
  constructor(
    message: string,
    public readonly values: Record<string, string> = {}
  ) {
    super(message);
  }
}

/** Reads what the store holds, dropping anything that isn't a valid entry (never throws). */
export function storedSettings(value: unknown): LanguageSettings {
  const result: LanguageSettings = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [locale, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const { code, politeness, review } = raw as { code?: unknown; politeness?: unknown; review?: unknown };
    const entry: LocaleOptions = {};
    if (typeof code === 'string' && canonicalTarget(code)) entry.code = canonicalTarget(code)!;
    if (typeof politeness === 'string' && POLITENESS.includes(politeness as Politeness)) entry.politeness = politeness as Politeness;
    if (review === true) entry.review = true;
    if (entry.code || (entry.politeness && entry.politeness !== 'default') || entry.review) result[locale] = entry;
  }
  return result;
}

/**
 * Validates what the settings page sends (`{ <locale>: { code, politeness, review } }`) against the Strapi
 * locales and Supertext's target list, and returns what to store. `code` empty or null = not mapped.
 */
export function parseSettings(input: unknown, locales: string[], overrides: Record<string, LocaleOptions> = {}): LanguageSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidSettingsError('languages must be an object keyed by locale code.');
  }
  const result: LanguageSettings = {};
  for (const [locale, raw] of Object.entries(input as Record<string, unknown>)) {
    if (!locales.includes(locale)) {
      throw new InvalidSettingsError(`Unknown locale ${locale}.`, { locale });
    }
    const { code, politeness, review } = (raw && typeof raw === 'object' ? raw : {}) as {
      code?: unknown;
      politeness?: unknown;
      review?: unknown;
    };
    const entry: LocaleOptions = {};
    if (code !== undefined && code !== null && code !== '') {
      const canonical = typeof code === 'string' ? canonicalTarget(code) : null;
      if (!canonical) throw new InvalidSettingsError(`${String(code)} is not a Supertext language code.`, { locale, code: String(code) });
      entry.code = canonical;
    }
    if (politeness !== undefined && politeness !== null && politeness !== '' && politeness !== 'default') {
      if (!POLITENESS.includes(politeness as Politeness)) {
        throw new InvalidSettingsError(`Politeness must be default, more or less.`, { locale });
      }
      const target = targetCodeOrNull(locale, overrides[locale]?.code ?? entry.code);
      if (!target || supportsPoliteness(target) === false) {
        throw new InvalidSettingsError(`Supertext offers no formal or informal tone for ${target ?? locale}.`, { locale });
      }
      entry.politeness = politeness as Politeness;
    }
    if (review !== undefined && review !== null && typeof review !== 'boolean') {
      throw new InvalidSettingsError(`Translation review must be true or false.`, { locale });
    }
    if (review === true) entry.review = true;
    if (entry.code || entry.politeness || entry.review) result[locale] = entry;
  }
  return result;
}

/** The mapping that applies: config/plugins `locales` wins per field, then what was saved on the settings page. */
export function effectiveOptions(saved: LanguageSettings, overrides: Record<string, LocaleOptions> = {}): Record<string, LocaleOptions> {
  const result: Record<string, LocaleOptions> = {};
  for (const locale of new Set([...Object.keys(saved), ...Object.keys(overrides)])) {
    const code = overrides[locale]?.code ?? saved[locale]?.code;
    const politeness = overrides[locale]?.politeness ?? saved[locale]?.politeness;
    const review = overrides[locale]?.review ?? saved[locale]?.review;
    result[locale] = { ...(code ? { code } : {}), ...(politeness ? { politeness } : {}), ...(review ? { review: true } : {}) };
  }
  return result;
}

/** One row of the settings page: the Strapi locale, what is saved, what config overrides, and what is sent. */
export interface LanguageStatus {
  code: string;
  name: string;
  /** The Supertext code it is sent as (mapping, exact match or default); null = translating into it fails. */
  target: string | null;
  /** Saved on the settings page (null: nothing saved). */
  saved: string | null;
  /** What the combo box preselects when nothing is saved: exact match, else default, else null. */
  suggested: string | null;
  /** Set in config/plugins (`locales.<locale>`): wins over the settings page. */
  override: { code?: string; politeness?: Politeness; review?: boolean };
  /** The tone that applies (config/plugins wins). */
  politeness: Politeness;
  /** The tone saved on the settings page. */
  savedPoliteness: Politeness;
  /** Whether the target offers formal/informal (null: no target or not in the SDK's list). */
  politenessSupported: boolean | null;
  /** Translation review that applies (config/plugins wins): translations into it go through the review service. */
  review: boolean;
  /** Translation review saved on the settings page. */
  savedReview: boolean;
}

export function languageStatus(
  rows: { code: string; name?: string }[],
  saved: LanguageSettings,
  overrides: Record<string, LocaleOptions> = {}
): LanguageStatus[] {
  const options = effectiveOptions(saved, overrides);
  return rows.map(({ code, name }) => {
    const target = targetCodeOrNull(code, options[code]?.code);
    const override: LanguageStatus['override'] = {};
    if (overrides[code]?.code) override.code = overrides[code].code;
    if (overrides[code]?.politeness) override.politeness = overrides[code].politeness;
    if (typeof overrides[code]?.review === 'boolean') override.review = overrides[code].review;
    return {
      code,
      name: name ?? code,
      target,
      saved: saved[code]?.code ?? null,
      suggested: suggestTarget(code),
      override,
      politeness: options[code]?.politeness ?? 'default',
      savedPoliteness: saved[code]?.politeness ?? 'default',
      politenessSupported: target ? supportsPoliteness(target) : null,
      review: options[code]?.review === true,
      savedReview: saved[code]?.review === true,
    };
  });
}
