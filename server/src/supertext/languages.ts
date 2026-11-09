import { Languages, SupertextError as SdkError } from '../vendor/supertext-sdk/v1/index';
import { fromSdkError, type Politeness } from './client';

/**
 * Strapi locales → Supertext codes, with the Supertext SDK's rules (the same in every Supertext
 * plugin): the locale's mapping wins (the combo box under Settings → Supertext, or `code` under
 * `locales` in config/plugins, which overrides it; sent as it is); otherwise a Strapi locale that
 * equals a Supertext code apart from case and `_`/`-` is used (`de-CH`, `fr_ch` → `fr-CH`, `es`);
 * otherwise the SDK's default where one is obvious (`de` → `de-DE`, `en` → `en-US`, `zh-TW` →
 * `zh-Hant`, `es-ES` → `es`); anything else (`en-IE`, `de-LI`, `gsw`) is the error
 * `unsupportedLanguage` and nothing is sent. Sources are bare (`en-US` → `en`).
 */
export const SUPERTEXT_TARGETS = Languages.TARGETS;

/** The targets for the combo box (sorted by English name): code, name and whether formal/informal is offered. */
export const targetOptions = () => Languages.targetOptions().map(({ code, name, politeness }) => ({ code, name, politeness }));

/** What the combo box preselects for a locale nobody mapped: the exact match, else the default, else null. */
export const suggestTarget = (locale: string): string | null => Languages.suggestTarget(locale);

/** The canonical Supertext target code for a value from the combo box, null if it isn't one. */
export const canonicalTarget = (code: string): string | null => Languages.matchTarget(code);

const plugin = <T>(run: () => T): T => {
  try {
    return run();
  } catch (error) {
    throw error instanceof SdkError ? fromSdkError(error) : error;
  }
};

/** Target code for a Strapi locale: the mapping wins, else an exact Supertext code, else the default, else `unsupportedLanguage`. */
export function targetCode(locale: string, override?: string): string {
  return plugin(() => Languages.target(locale, override ? { [locale]: override } : undefined));
}

/** The target code, or null when the locale has no mapping, no match and no default (for the settings page). */
export function targetCodeOrNull(locale: string, override?: string): string | null {
  try {
    return targetCode(locale, override);
  } catch {
    return null;
  }
}

/**
 * Source code: the SDK's `Languages.source()` with the same mapping, so one `code` serves both
 * directions (`de-CH` → `de`); else the locale's language (`en-US` → `en`), else
 * `unsupportedLanguage`. Empty = auto-detect.
 */
export function sourceCode(locale: string, override?: string): string {
  return plugin(() => Languages.source(locale || '', override ? { [locale]: override } : undefined));
}

/** Whether Supertext offers formal/informal for a target code (null: a code not in the SDK's list). */
export const supportsPoliteness = (target: string): boolean | null => Languages.supportsPoliteness(target);

/**
 * The politeness to send. A formal/informal setting for a target that has none isn't dropped
 * silently: it is the error `unsupportedFeature` (nothing is sent), and the settings page warns.
 */
export function politenessFor(target: string, politeness: Politeness | undefined, locale = target): Politeness {
  const value = politeness ?? 'default';
  if (value !== 'default' && supportsPoliteness(target) === false) {
    throw fromSdkError(new SdkError('unsupported_feature', { feature: 'politeness', targetLang: locale }));
  }
  return value;
}
