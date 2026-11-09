import type { Core } from '@strapi/strapi';
import { TranslationError, type TranslatorService } from '../services/translator';
import { SupertextClient, SupertextError } from '../supertext/client';
import { siteUrl } from '../reporting';
import type { ReportingService } from '../services/reporting';
import type { SettingsService } from '../services/settings';
import { InvalidSettingsError } from '../language-settings';
import { MAX_UPLOAD_BYTES, tooLarge, type FilesService } from '../services/files';
import { readFile, unlink } from 'node:fs/promises';

/** A file of a multipart upload as Strapi's body parser (formidable) hands it over. */
type UploadedFile = { filepath?: string; path?: string; size?: number };

type Ctx = {
  request: { body?: Record<string, unknown>; origin?: string; files?: Record<string, UploadedFile | UploadedFile[]> };
  set?(headers: Record<string, string>): void;
  query: Record<string, unknown>;
  state: { userAbility: unknown };
  body: unknown;
  status: number;
  forbidden(message?: string, details?: unknown): void;
  badRequest(message?: string, details?: unknown): void;
};

const controller = ({ strapi }: { strapi: Core.Strapi }) => {
  const translator = () => strapi.plugin('supertext').service('translator') as TranslatorService;
  const files = () => strapi.plugin('supertext').service('files') as FilesService;
  const reporting = () => strapi.plugin('supertext').service('reporting') as ReportingService;
  const settings = () => strapi.plugin('supertext').service('settings') as SettingsService;
  /** The site's base URL: `server.url` if absolute, else the origin of this request. */
  const site = (ctx: Ctx) => siteUrl(strapi.config.get('server.url'), ctx.request?.origin);

  const checker = (ctx: Ctx, model: string) =>
    strapi.plugin('content-manager').service('permission-checker').create({ userAbility: ctx.state.userAbility, model });

  const fail = (ctx: Ctx, error: unknown) => {
    if (error instanceof TranslationError || error instanceof SupertextError) {
      ctx.status = error instanceof TranslationError ? error.status : 502;
      ctx.body = { error: { message: error.message, details: { code: error.code, values: error.values } } };
      return;
    }
    strapi.log.error(`[supertext] ${(error as Error).stack ?? error}`);
    ctx.status = 502;
    ctx.body = { error: { message: (error as Error).message } };
  };

  /** Same rules as the Content Manager: read the source locale, write each target locale. Answers 403 when not. */
  const deniedLocales = (ctx: Ctx, model: string, sourceLocale: string, targetLocales: string[]) => {
    const permissions = checker(ctx, model);
    if (permissions.cannot.read({ locale: sourceLocale })) {
      return ctx.forbidden(`You may not read the ${sourceLocale} version.`, {
        code: 'forbiddenRead',
        values: { locale: sourceLocale },
      }) ?? true;
    }
    const denied = targetLocales.filter(
      (locale: string) => permissions.cannot.update({ locale }) && permissions.cannot.create({ locale })
    );
    if (denied.length) {
      return ctx.forbidden(`You may not edit these locales: ${denied.join(', ')}`, {
        code: 'forbiddenEdit',
        values: { locales: denied.join(', ') },
      }) ?? true;
    }
    return null;
  };

  return {
    async status(ctx: Ctx) {
      // Version report and key check in the background (back-end request that runs the plugin's code).
      reporting().inBackground('onRequest', site(ctx));
      ctx.body = {
        ...translator().status(),
        reports: { enabled: reporting().enabled(), check: await reporting().lastCheck() },
      };
    },

    /** The automatic key check (always HTTP 200: a 401 would sign the admin out); reports a changed status. */
    async testConnection(ctx: Ctx) {
      try {
        const result = await reporting().run('testConnection', site(ctx));
        const { apiKey, endpoint } = strapi.config.get('plugin::supertext') as { apiKey?: string; endpoint?: string };
        const check = result?.check ?? (await SupertextClient.checkApiKey(apiKey ?? '', endpoint));
        ctx.body = { ok: check.status === 'ok', check };
      } catch (error) {
        fail(ctx, error);
      }
    },

    /** Public (no login): the Commando Center checks that the site is reachable. 404 while reports are off. */
    ping(ctx: Ctx) {
      const answer = reporting().ping(ctx.query.challenge);
      ctx.status = answer.status;
      ctx.set?.(answer.headers);
      ctx.body = answer.body;
    },

    /** Settings → Supertext → Languages: one row per Strapi locale and the codes for the combo boxes. */
    async settings(ctx: Ctx) {
      ctx.body = await settings().page();
    },

    /** Saves the combo boxes (`{ languages: { <locale>: { code, politeness, review } } }`), validated against Supertext's list. */
    async saveSettings(ctx: Ctx) {
      try {
        ctx.body = await settings().save((ctx.request.body ?? {}).languages);
      } catch (error) {
        if (error instanceof InvalidSettingsError) {
          ctx.status = 400;
          ctx.body = { error: { message: error.message, details: { code: 'invalidSettings', values: error.values } } };
          return;
        }
        throw error;
      }
    },

    async locales(ctx: Ctx) {
      const model = String(ctx.query.model ?? '');
      const documentId = String(ctx.query.documentId ?? '');
      if (!model || !documentId) {
        return ctx.badRequest('model and documentId are required');
      }
      if (checker(ctx, model).cannot.read()) {
        return ctx.forbidden();
      }
      ctx.body = { locales: await translator().existingLocales(model, documentId) };
    },

    /**
     * Export for translation: GET ?model&documentId&sourceLocale&targetLocales=a,b&format=xliff|html.
     * Same permissions as translating; no API key needed.
     */
    async exportFile(ctx: Ctx) {
      const model = String(ctx.query.model ?? '');
      const documentId = String(ctx.query.documentId ?? '');
      const sourceLocale = String(ctx.query.sourceLocale ?? '');
      const raw = ctx.query.targetLocales;
      const targetLocales = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(',')).filter(Boolean);
      const format = ctx.query.format === 'html' ? 'html' : 'xliff';
      if (!model || !documentId || !sourceLocale || !targetLocales.length) {
        return ctx.badRequest('model, documentId, sourceLocale and targetLocales are required');
      }
      const denied = deniedLocales(ctx, model, sourceLocale, targetLocales);
      if (denied) return denied;
      try {
        const file = await files().exportEntry({ uid: model, documentId, sourceLocale, targetLocales, format });
        ctx.set?.({
          'Content-Type': file.contentType,
          'Content-Disposition': `attachment; filename="${file.filename}"`,
          'Cache-Control': 'no-store',
        });
        ctx.body = file.body;
      } catch (error) {
        fail(ctx, error);
      }
    },

    /**
     * Import translation: multipart with `file` (XLIFF or HTML, at most 10 MB) and `includeChanged`.
     * The body parser's temporary file is read into memory and deleted right away.
     */
    async importFile(ctx: Ctx) {
      const upload = ctx.request.files?.file;
      const file = Array.isArray(upload) ? upload[0] : upload;
      const filepath = file?.filepath ?? file?.path;
      try {
        if (!file || !filepath) {
          return ctx.badRequest('file is required');
        }
        if ((file.size ?? 0) > MAX_UPLOAD_BYTES) {
          throw tooLarge();
        }
        const content = await readFile(filepath, 'utf8');
        const includeChanged = /^(1|true)$/.test(String(ctx.request.body?.includeChanged ?? ''));
        const results = await files().importFile({
          content,
          includeChanged,
          canEdit: (uid, sourceLocale, targetLocale) => {
            const permissions = checker(ctx, uid);
            return (
              !permissions.cannot.read({ locale: sourceLocale }) &&
              !(permissions.cannot.update({ locale: targetLocale }) && permissions.cannot.create({ locale: targetLocale }))
            );
          },
        });
        ctx.body = { results };
      } catch (error) {
        fail(ctx, error);
      } finally {
        if (filepath) await unlink(filepath).catch(() => undefined);
      }
    },

    async translate(ctx: Ctx) {
      const body = ctx.request.body ?? {};
      const model = String(body.model ?? '');
      const documentId = String(body.documentId ?? '');
      const sourceLocale = String(body.sourceLocale ?? '');
      const targetLocales = Array.isArray(body.targetLocales) ? body.targetLocales.map(String) : [];
      if (!model || !documentId || !sourceLocale || !targetLocales.length) {
        return ctx.badRequest('model, documentId, sourceLocale and targetLocales are required');
      }

      const denied = deniedLocales(ctx, model, sourceLocale, targetLocales);
      if (denied) return denied;

      try {
        const results = await translator().translate({ uid: model, documentId, sourceLocale, targetLocales });
        const rejected = results.find((r) => r.code === 'authFailed');
        if (rejected) reporting().inBackground('authenticationFailed', site(ctx), rejected.httpStatus ?? 401);
        else reporting().inBackground('onRequest', site(ctx));
        ctx.body = { results };
      } catch (error) {
        fail(ctx, error);
      }
    },
  };
};

export default controller;
