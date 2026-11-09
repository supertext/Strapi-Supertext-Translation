import type { Core } from '@strapi/strapi';
import { PLUGIN_NAME } from '../reporting';
import { sourceCode, targetCodeOrNull } from '../supertext/languages';
import {
  TranslationFileError,
  TranslationFiles,
  type FileJob,
  type FileSegment,
  type ImportedSegment,
} from '../vendor/supertext-sdk/index';
import type { Job } from './extract';
import type { SettingsService } from './settings';
import { TranslationError, type TranslatorService } from './translator';

/**
 * Translation files (the Supertext SDK's `TranslationFiles`): *Export for translation* writes an
 * entry's texts as XLIFF 1.2 or HTML, *Import translation* reads a translated file and saves it
 * with the same extraction and write-back as API translations (translator service).
 *
 * Reference format (the job's `reference`, the XLIFF `original`):
 *   `entry:<content-type uid>:<documentId>:<sourceLocale>:<targetLocale>`, each part URI-encoded
 *   (the uid's `::` becomes `%3A%3A`), e.g. `entry:api%3A%3Aarticle.article:abc123:en:de-CH`.
 */

/** Uploads larger than this are refused before they are read. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type FileFormat = 'xliff' | 'html';

export interface EntryReference {
  uid: string;
  documentId: string;
  sourceLocale: string;
  targetLocale: string;
}

export function formatReference(ref: EntryReference): string {
  return ['entry', ref.uid, ref.documentId, ref.sourceLocale, ref.targetLocale].map(encodeURIComponent).join(':');
}

/** The reference back, or null when it isn't one of ours. */
export function parseReference(reference: string): EntryReference | null {
  let parts: string[];
  try {
    parts = reference.split(':').map(decodeURIComponent);
  } catch {
    return null;
  }
  if (parts.length !== 5 || parts[0] !== 'entry' || parts.some((p) => p === '')) {
    return null;
  }
  const [, uid, documentId, sourceLocale, targetLocale] = parts;
  return { uid, documentId, sourceLocale, targetLocale };
}

/** The extraction's jobs as file segments: the attribute path is the key. */
export const fileSegments = (jobs: Job[]): FileSegment[] =>
  jobs.map((job) => ({ key: job.key, text: job.segment.text, html: job.segment.html }));

/** Error codes of TranslationFileError → the plugin's codes (`error.<code>` in the admin). */
export const fileErrorCode = (error: TranslationFileError): string =>
  error.code === 'too_large' ? 'fileTooLarge' : error.code === 'missing_metadata' ? 'fileMissingMetadata' : 'fileInvalid';

/** English messages for the codes above (the admin shows its own translation). */
const FILE_MESSAGES: Record<string, string> = {
  fileTooLarge: 'The file is too large (at most 10 MB).',
  fileMissingMetadata: "This file wasn't exported by the Supertext plugin, or its header was removed.",
  fileInvalid: "This file isn't a valid XLIFF or HTML translation file.",
};

export const fileError = (error: TranslationFileError): TranslationError => {
  const code = fileErrorCode(error);
  return new TranslationError(FILE_MESSAGES[code], code === 'fileTooLarge' ? 413 : 422, code);
};

export const tooLarge = () => new TranslationError('The file is too large (at most 10 MB).', 413, 'fileTooLarge');

export interface ExportRequest {
  uid: string;
  documentId: string;
  sourceLocale: string;
  targetLocales: string[];
  format: FileFormat;
}

export interface ExportedFile {
  body: string;
  contentType: string;
  filename: string;
}

/** One job of an imported file: counts, or an error with its message code. */
export interface ImportResult {
  uid: string | null;
  documentId: string | null;
  targetLocale: string;
  imported?: number;
  /** Translated, but the source changed since the export; not imported (the option was off). */
  sourceChanged?: number;
  untranslated?: number;
  invalid?: number;
  missing?: number;
  error?: string;
  code?: string;
  values?: Record<string, string | number>;
}

export interface ImportRequest {
  content: string;
  includeChanged: boolean;
  /** Whether the user may read the source and edit the target locale of an entry (Content Manager permissions). */
  canEdit(uid: string, sourceLocale: string, targetLocale: string): boolean;
}

const fileSafe = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, '_');

const files = ({ strapi }: { strapi: Core.Strapi }) => {
  const translator = () => strapi.plugin('supertext').service('translator') as TranslatorService;
  const settings = () => strapi.plugin('supertext').service('settings') as SettingsService;

  const strapiLocales = async (): Promise<string[]> => {
    const locales = ((await strapi.plugin('i18n')?.service('locales')?.find()) ?? []) as { code: string }[];
    return locales.map((l) => l.code);
  };

  /** Supertext codes from the mapping, else the Strapi code with `_` → `-`, so a file can go to any translator. */
  const languages = async () => {
    const mapping = await settings().mapping();
    return {
      source: (locale: string) => {
        try {
          return sourceCode(locale, mapping[locale]?.code);
        } catch {
          return locale.replace(/_/g, '-');
        }
      },
      target: (locale: string) => targetCodeOrNull(locale, mapping[locale]?.code) ?? locale.replace(/_/g, '-'),
    };
  };

  return {
    /** The file for one entry: XLIFF with one job per target locale, or HTML for exactly one. */
    async exportEntry(request: ExportRequest): Promise<ExportedFile> {
      const { uid, documentId, sourceLocale, format } = request;
      const targets = [...new Set(request.targetLocales)].filter((l) => l && l !== sourceLocale);
      if (!targets.length) {
        throw new TranslationError('Choose at least one target locale other than the source locale.', 400, 'noTargets');
      }
      if (format === 'html' && targets.length !== 1) {
        throw new TranslationError('An HTML file holds exactly one target locale.', 400, 'fileHtmlOneLocale');
      }
      const source = await translator().loadSource(uid, documentId, sourceLocale);
      const segments = fileSegments(translator().extract(uid, source).jobs);
      if (!segments.length) {
        throw new TranslationError('Nothing to translate.', 422, 'fileNothing');
      }
      const lang = await languages();
      const jobs: FileJob[] = targets.map((targetLocale) => ({
        plugin: PLUGIN_NAME,
        reference: formatReference({ uid, documentId, sourceLocale, targetLocale }),
        sourceLanguage: lang.source(sourceLocale),
        targetLanguage: lang.target(targetLocale),
        segments,
      }));
      const item = fileSafe(`${uid.split('.').pop()}-${documentId}`);
      const suffix = targets.length === 1 ? `-${fileSafe(targets[0])}` : '';
      return format === 'html'
        ? { body: TranslationFiles.exportHtml(jobs[0]), contentType: 'text/html; charset=utf-8', filename: `strapi-${item}${suffix}.html` }
        : { body: TranslationFiles.exportXliff(jobs), contentType: 'application/x-xliff+xml', filename: `strapi-${item}${suffix}.xlf` };
    },

    /**
     * Reads a translated file and saves each job. Errors of the whole file are thrown
     * (TranslationError with a file code); problems with one job end up in its result.
     */
    async importFile(request: ImportRequest): Promise<ImportResult[]> {
      let parsed;
      try {
        parsed = TranslationFiles.read(request.content);
      } catch (error) {
        throw error instanceof TranslationFileError ? fileError(error) : error;
      }
      const locales = await strapiLocales();
      const results: ImportResult[] = [];

      for (const file of parsed) {
        const ref = parseReference(file.reference);
        const base: ImportResult = {
          uid: ref?.uid ?? null,
          documentId: ref?.documentId ?? null,
          targetLocale: ref?.targetLocale ?? file.targetLanguage,
        };
        try {
          if (file.plugin !== PLUGIN_NAME) {
            throw new TranslationError(`This file belongs to another system (${file.plugin}).`, 422, 'fileOtherSystem', {
              plugin: file.plugin,
            });
          }
          const notFound = () =>
            new TranslationError('The entry this file was exported from no longer exists.', 404, 'fileNotFound');
          if (!ref) throw notFound();
          try {
            translator().contentType(ref.uid);
          } catch {
            throw notFound();
          }
          for (const locale of [ref.targetLocale, ref.sourceLocale]) {
            if (!locales.includes(locale)) {
              throw new TranslationError(`The site has no language ${locale}.`, 422, 'fileNoLanguage', { language: locale });
            }
          }
          if (!request.canEdit(ref.uid, ref.sourceLocale, ref.targetLocale)) {
            throw new TranslationError(`You may not edit these locales: ${ref.targetLocale}`, 403, 'forbiddenEdit', {
              locales: ref.targetLocale,
            });
          }
          const source = await translator().loadEntry(ref.uid, ref.documentId, ref.sourceLocale);
          if (!source) throw notFound();

          const extraction = translator().extract(ref.uid, source);
          const imported = TranslationFiles.importTranslations(file, fileSegments(extraction.jobs));
          const byKey = new Map<string, ImportedSegment>(imported.map((r) => [r.key, r]));
          const target = (await translator().loadEntry(ref.uid, ref.documentId, ref.targetLocale)) ?? {};

          const counts = { imported: 0, sourceChanged: 0, untranslated: 0, invalid: 0, missing: 0 };
          for (const job of extraction.jobs) {
            const r = byKey.get(job.key);
            if (r && r.text !== null && (r.status === 'ok' || (r.status === 'source_changed' && request.includeChanged))) {
              job.apply(r.text);
              counts.imported++;
              continue;
            }
            if (r?.status === 'source_changed') counts.sourceChanged++;
            else if (r?.status === 'untranslated') counts.untranslated++;
            else if (r?.status === 'invalid_markup') counts.invalid++;
            else if (r?.status === 'missing') counts.missing++;
            // Not imported: keep what the target locale has there (else the source, as API translation does).
            job.keep(target);
          }

          if (counts.imported > 0) {
            const existing = await translator().existingLocales(ref.uid, ref.documentId);
            await translator().writeLocale(ref.uid, ref.documentId, ref.targetLocale, extraction, existing.includes(ref.targetLocale));
          }
          results.push({ ...base, ...counts });
        } catch (error) {
          if (error instanceof TranslationError) {
            results.push({ ...base, error: error.message, code: error.code, values: error.values });
          } else {
            const detail = (error as Error).message;
            strapi.log.error(`[supertext] Import of ${file.reference} failed: ${detail}`);
            results.push({ ...base, error: `Could not save the translation: ${detail}`, code: 'saveFailed', values: { detail } });
          }
        }
      }
      return results;
    },
  };
};

export default files;
export type FilesService = ReturnType<typeof files>;
