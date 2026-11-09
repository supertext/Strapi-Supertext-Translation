import type { Core } from '@strapi/strapi';
import type { LocaleOptions, PluginConfig } from '../config';
import { MAX_DOCUMENT_CHARACTERS, SupertextClient, SupertextError } from '../supertext/client';
import { buildDocument, parseDocument, type Segment } from '../supertext/html';
import { politenessFor, sourceCode, targetCode } from '../supertext/languages';
import type { SettingsService } from './settings';
import { pluginVersion } from '../version';
import { extract, populateFor, type Attributes, type Extraction, type Job, type SchemaLookup } from './extract';

export interface TranslateRequest {
  uid: string;
  documentId: string;
  sourceLocale: string;
  targetLocales: string[];
}

export interface LocaleResult {
  locale: string;
  status: 'created' | 'updated' | 'error';
  fields?: number;
  error?: string;
  /** Message key for the admin panel (`error.<code>`), with its placeholder values. */
  code?: string;
  values?: Record<string, string | number>;
  /** Supertext's HTTP status for a failed locale (401/403: the key was rejected). */
  httpStatus?: number;
}

/** See SupertextError: `code`/`values` are translated in the admin panel, `message` is English. */
export class TranslationError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code?: string,
    public readonly values: Record<string, string | number> = {}
  ) {
    super(message);
  }
}

const translator = ({ strapi }: { strapi: Core.Strapi }) => {
  const config = (): PluginConfig => strapi.config.get('plugin::supertext') as PluginConfig;
  const settings = () => strapi.plugin('supertext').service('settings') as SettingsService;

  const schema: SchemaLookup = {
    component: (uid) => ((strapi.components as unknown as Record<string, { attributes: Attributes }>)[uid]?.attributes ?? {}),
  };

  const client = () => {
    const { apiKey, endpoint, reviewUrl, pollIntervalMs, pollTimeoutMs } = config();
    if (!apiKey) {
      throw new TranslationError(
        'No Supertext API key configured. Set SUPERTEXT_API_KEY on the server. No Supertext account yet? Create one at https://www.supertext.com/person/en/account/signin. Generate your API key at https://www.supertext.com/en/integrations/api (supertext.com → Integrations → API; requires the Admin role).',
        503,
        'notConfigured'
      );
    }
    return new SupertextClient({ apiKey, endpoint, reviewEndpoint: reviewUrl, pollIntervalMs, pollTimeoutMs });
  };

  const contentType = (uid: string) => {
    const model = strapi.contentTypes[uid as keyof typeof strapi.contentTypes] as
      | { attributes: Attributes; pluginOptions?: { i18n?: { localized?: boolean } } }
      | undefined;
    if (!model) {
      throw new TranslationError(`Unknown content type ${uid}.`, 404, 'unknownContentType', { uid });
    }
    if (!model.pluginOptions?.i18n?.localized) {
      throw new TranslationError('This content type is not localized. Enable internationalization for it first.', 400, 'notLocalized');
    }
    const allowed = config().contentTypes;
    if (allowed.length && !allowed.includes(uid)) {
      throw new TranslationError('Supertext translation is not enabled for this content type.', 403, 'notEnabled');
    }
    return model;
  };

  /** Sends the segments in as few documents as possible (one unless > ~900k characters). */
  async function translateJobs(
    jobs: Job[],
    targetLocale: string,
    sourceLocale: string,
    api: SupertextClient,
    mapping: Record<string, LocaleOptions>
  ) {
    const options = mapping[targetLocale] ?? {};
    const chunks: Job[][] = [];
    let current: Job[] = [];
    let size = 0;
    for (const job of jobs) {
      const length = job.segment.text.length + 40;
      if (current.length && size + length > MAX_DOCUMENT_CHARACTERS) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(job);
      size += length;
    }
    if (current.length) chunks.push(current);

    // Resolved before anything is sent: a locale without mapping, match or default, or a tone the
    // target lacks, sends nothing.
    const targetLanguage = targetCode(targetLocale, options.code);
    const sourceLanguage = sourceCode(sourceLocale, mapping[sourceLocale]?.code);
    const politeness = politenessFor(targetLanguage, options.politeness, targetLocale);

    let applied = 0;
    for (const chunk of chunks) {
      const segments: Segment[] = chunk.map((job) => job.segment);
      const translated = await api.translateDocument(buildDocument(segments), { targetLanguage, sourceLanguage, politeness });
      const parsed = parseDocument(translated, segments);
      chunk.forEach((job, index) => {
        const value = parsed.get(index);
        if (value !== undefined && value !== '') {
          job.apply(value);
          applied++;
        }
      });
    }
    return applied;
  }

  /** The saved (draft) version of an entry in a locale, with components, dynamic zones and media; null if none. */
  async function loadEntry(uid: string, documentId: string, locale: string): Promise<Record<string, unknown> | null> {
    const model = contentType(uid);
    const found = await strapi.documents(uid as never).findOne({
      documentId,
      locale,
      status: 'draft',
      populate: populateFor(model.attributes, schema) as never,
    } as never);
    return (found as Record<string, unknown> | null) ?? null;
  }

  /** The source version, or the `sourceMissing` error. */
  async function loadSource(uid: string, documentId: string, sourceLocale: string): Promise<Record<string, unknown>> {
    const source = await loadEntry(uid, documentId, sourceLocale);
    if (!source) {
      throw new TranslationError(`No ${sourceLocale} version of this entry found. Save it first.`, 404, 'sourceMissing', {
        locale: sourceLocale,
      });
    }
    return source;
  }

  /**
   * Saves extracted (and translated) data into a locale: uid fields keep the URL an existing
   * translation has, or are generated from the translated title for a new one. The same for API
   * translations and imported translation files.
   */
  async function writeLocale(uid: string, documentId: string, locale: string, extraction: Extraction, exists: boolean) {
    const { data, uidFields } = extraction;
    for (const field of uidFields) {
      if (exists) {
        delete data[field]; // keep the URL the translation already has
        continue;
      }
      try {
        data[field] = await strapi
          .plugin('content-manager')
          .service('uid')
          .generateUIDField({ contentTypeUID: uid, field, data, locale });
      } catch (error) {
        strapi.log.warn(`[supertext] Could not generate ${field} for ${locale}: ${(error as Error).message}`);
      }
    }
    await strapi.documents(uid as never).update({ documentId, locale, data } as never);
  }

  return {
    contentType,
    loadEntry,
    loadSource,
    writeLocale,
    /** Extraction of an entry with this content type's schema (fresh copy each call). */
    extract: (uid: string, entry: Record<string, unknown>) => extract(contentType(uid).attributes, entry, schema),

    /** Configuration for the settings page and the panel (never the key). */
    status() {
      const { apiKey, endpoint, locales, contentTypes } = config();
      return { configured: Boolean(apiKey), endpoint, locales, contentTypes, version: pluginVersion() };
    },

    /** Locales that already exist for a document, so callers can warn before overwriting. */
    async existingLocales(uid: string, documentId: string): Promise<string[]> {
      const rows = await strapi.db.query(uid as never).findMany({
        where: { documentId },
        select: ['locale'],
      });
      return [...new Set(rows.map((row: { locale: string }) => row.locale))];
    },

    async translate(request: TranslateRequest): Promise<LocaleResult[]> {
      const { uid, documentId, sourceLocale } = request;
      const model = contentType(uid);
      const targets = [...new Set(request.targetLocales)].filter((locale) => locale && locale !== sourceLocale);
      if (!targets.length) {
        throw new TranslationError('Choose at least one target locale other than the source locale.', 400, 'noTargets');
      }
      const api = client();
      // Settings → Supertext, with locales in config/plugins winning per locale.
      const mapping = await settings().mapping();
      const source = await loadSource(uid, documentId, sourceLocale);
      const existing = await this.existingLocales(uid, documentId);

      const results: LocaleResult[] = [];
      for (const locale of targets) {
        try {
          // Extract per locale: each target needs its own copy of the data.
          const extraction = extract(model.attributes, source, schema);
          // A locale with *Translation review* on goes through the review service.
          const fields = await translateJobs(extraction.jobs, locale, sourceLocale, api.forReview(mapping[locale]?.review === true), mapping);
          const exists = existing.includes(locale);
          await writeLocale(uid, documentId, locale, extraction, exists);
          results.push({ locale, status: exists ? 'updated' : 'created', fields });
        } catch (error) {
          const known = error instanceof SupertextError || error instanceof TranslationError;
          const detail = (error as Error).message;
          strapi.log.error(`[supertext] ${uid} ${documentId} → ${locale}: ${detail}`);
          results.push(
            known
              ? {
                  locale,
                  status: 'error',
                  error: error.message,
                  code: error.code,
                  // `language` for "has no Supertext language yet" and "no formal or informal tone".
                  values: { language: locale, ...error.values },
                  ...(error instanceof SupertextError && error.status ? { httpStatus: error.status } : {}),
                }
              : {
                  locale,
                  status: 'error',
                  error: `Could not save the translation: ${detail}`,
                  code: 'saveFailed',
                  values: { detail },
                }
          );
        }
      }
      return results;
    },
  };
};

export default translator;
export type TranslatorService = ReturnType<typeof translator>;
