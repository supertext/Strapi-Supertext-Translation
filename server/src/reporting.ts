/**
 * Version reports to the Supertext Commando Center, the automatic API key check and the
 * callback ping (Commando-Center-Supertext-Translation → docs/DEVELOPER.md → Report protocol).
 * The protocol is Supertext Plugin Health's (`InstallationReporter`, `pingResponse`, bundled in
 * vendor/supertext-plugin-health); the key check is the Supertext SDK's (`checkApiKey()`). This file
 * only gives them what Strapi knows: the site URL, the Strapi and plugin versions, and a place to
 * keep the reporter's state (Strapi's core store, `plugin_supertext_reporter`).
 *
 * The plugin is configured in config/plugins (key from SUPERTEXT_API_KEY), so there is no
 * "settings saved": the key check runs when the key changed (fingerprint), on "Test connection"
 * and after a 401/403 from Supertext. No Strapi imports here (tested on its own).
 */
import {
  InstallationReporter,
  pingResponse,
  reporterState,
  reportsEnabled,
  type Extension,
  type KeyCheck,
  type KeyChecker,
  type LanguageMapping,
  type PingResponse,
  type ReporterOptions,
  type ReporterResult,
  type ReporterState,
} from './vendor/supertext-plugin-health/index';
import { SDK_VERSION } from './vendor/supertext-sdk/index';
import { apiKeyFingerprint, SupertextClient, type SupertextClientOptions } from './vendor/supertext-sdk/v1/index';
import { LIVE_ENDPOINT, USER_AGENT } from './supertext/client';
import { PLUGIN_NAME, pluginVersion } from './version';

/** The GitHub repository name: the center reads the latest release from it. */
export { PLUGIN_NAME };
/** The ping route below Strapi's REST prefix (content API route `GET /ping` of the plugin `supertext`). */
export const PING_PATH = '/supertext/ping';

/** Where the state lives: Strapi's core store (`strapi.store`), key `plugin_supertext_reporter`. */
export interface StateStorage {
  get(): Promise<unknown>;
  set(value: unknown): Promise<void>;
}

export interface ReportingSettings {
  apiKey?: string;
  endpoint?: string;
  /** "Send version information to Supertext" (config option `versionReports`, default on). */
  versionReports?: boolean;
}

export interface ReportingContext {
  storage: StateStorage;
  /** The current plugin configuration (read on every call, so a changed environment counts). */
  settings: () => ReportingSettings;
  /** The installed Strapi version (`strapi.config.get('info.strapi')`). */
  strapiVersion: () => string | null;
  /** Strapi's REST prefix (`api.rest.prefix`, default `/api`). */
  apiPrefix: () => string;
  logger: { debug(message: string): void };
  /** For tests: options passed to the Plugin Health reporter (fetch, report URL, clock). */
  reporterOverrides?: Partial<ReporterOptions>;
  /** For tests: options passed to the SDK client that checks the key (fetch, base URL). */
  clientOverrides?: SupertextClientOptions;
}

export type ReporterAction = 'onRequest' | 'testConnection' | 'authenticationFailed';

/** Whether version reports are on: `versionReports` (default on), SUPERTEXT_VERSION_REPORTS wins. */
export const versionReportsEnabled = (settings: ReportingSettings, env: string | null | undefined = process.env.SUPERTEXT_VERSION_REPORTS): boolean =>
  reportsEnabled(typeof settings.versionReports === 'boolean' ? settings.versionReports : null, env);

/** An absolute http(s) URL without trailing slash, else null. */
export const absoluteUrl = (value: unknown): string | null => {
  const url = String(value ?? '').trim();
  return /^https?:\/\/[^/]/i.test(url) ? url.replace(/\/+$/, '') : null;
};

/** The site's base URL: Strapi's `server.url` if it is absolute, else the origin the request came in on. */
export const siteUrl = (serverUrl: unknown, requestOrigin?: string | null): string | null =>
  absoluteUrl(serverUrl) ?? absoluteUrl(requestOrigin);

/** Strapi's own plugins (`@strapi/…`) and this one: not sent by "Send configuration to Supertext". */
const CORE_PLUGIN = /^@strapi\//;

/**
 * The installed Strapi plugins for "Send configuration to Supertext", from Strapi's `enabledPlugins`
 * (`{ <name>: { info, packageInfo } }`): npm name and version, Strapi's own and this plugin left out.
 */
export const installedPlugins = (enabledPlugins: unknown): Extension[] => {
  const out: Extension[] = [];
  for (const [name, plugin] of Object.entries((enabledPlugins ?? {}) as Record<string, { packageInfo?: { name?: unknown; version?: unknown } }>)) {
    const pkg = plugin?.packageInfo ?? {};
    const packageName = typeof pkg.name === 'string' && pkg.name ? pkg.name : name;
    if (CORE_PLUGIN.test(packageName) || name === 'supertext') continue;
    out.push({ name: packageName, version: typeof pkg.version === 'string' ? pkg.version : null, active: true, type: 'plugin' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

/**
 * The plugin's side of the Commando Center. One per Strapi process; calls are serialized so two
 * requests don't report twice. Nothing here ever throws into a request.
 */
export class Reporting {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly ctx: ReportingContext) {}

  get enabled(): boolean {
    try {
      return versionReportsEnabled(this.ctx.settings());
    } catch {
      return false;
    }
  }

  /** The ping route's answer (status, headers and body exactly as Plugin Health gives them). */
  ping(challenge: unknown): PingResponse {
    return pingResponse(typeof challenge === 'string' ? challenge : null, { plugin: PLUGIN_NAME, enabled: this.enabled });
  }

  reporter(url: string, languages?: LanguageMapping[]): InstallationReporter {
    const settings = this.ctx.settings();
    const prefix = `/${String(this.ctx.apiPrefix() || '/api').replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
    return new InstallationReporter({
      enabled: versionReportsEnabled(settings),
      siteUrl: url,
      plugin: { name: PLUGIN_NAME, version: pluginVersion() ?? '0.0.0' },
      system: { name: 'Strapi', version: this.ctx.strapiVersion() },
      sdkVersion: SDK_VERSION,
      callbackUrl: `${url}${prefix}${PING_PATH}`,
      keyChecker: this.keyChecker(settings),
      ...(languages ? { languages: () => languages } : {}),
      ...this.ctx.reporterOverrides,
    });
  }

  /** The SDK's key check (`GET features`) against the configured endpoint. */
  keyChecker(settings: ReportingSettings): KeyChecker {
    const options: SupertextClientOptions = { baseUrl: settings.endpoint || LIVE_ENDPOINT, userAgent: USER_AGENT, ...this.ctx.clientOverrides };
    return { check: (key) => new SupertextClient(key, options).checkApiKey(), fingerprint: apiKeyFingerprint };
  }

  async #load(): Promise<ReporterState> {
    return reporterState(await this.ctx.storage.get());
  }

  /** Runs one reporter action with the stored state and stores the result. Never throws. */
  run(action: ReporterAction, url: string | null, httpStatus?: number): Promise<ReporterResult | null> {
    const task = this.#queue.then(async () => {
      if (!url) return null;
      try {
        const reporter = this.reporter(url);
        const apiKey = this.ctx.settings().apiKey ?? '';
        const state = await this.#load();
        const result =
          action === 'authenticationFailed'
            ? await reporter.authenticationFailed(state, apiKey, httpStatus ?? 401)
            : action === 'testConnection'
              ? await reporter.testConnection(state, apiKey)
              : await reporter.onRequest(state, apiKey);
        await this.ctx.storage.set(result.state);
        if (result.event) this.ctx.logger.debug(`[supertext] version report ${result.event}: ${result.sent ? 'sent' : 'not sent'}`);
        return result;
      } catch (error) {
        this.ctx.logger.debug(`[supertext] version report skipped: ${(error as Error)?.message ?? error}`);
        return null;
      }
    });
    this.#queue = task;
    return task;
  }

  /**
   * "Send configuration to Supertext" (Settings → Supertext): the installed plugins and every locale with
   * its Supertext code in one `extensions` report, sent now (also within the hour after a failed report).
   * Null while version reports are off or without a site URL. Never throws.
   */
  sendConfiguration(url: string | null, extensions: Extension[], languages: LanguageMapping[]): Promise<ReporterResult | null> {
    const task = this.#queue.then(async () => {
      if (!url || !this.enabled) return null;
      try {
        const result = await this.reporter(url, languages).sendExtensions(await this.#load(), extensions);
        await this.ctx.storage.set(result.state);
        return result;
      } catch (error) {
        this.ctx.logger.debug(`[supertext] configuration not sent: ${(error as Error)?.message ?? error}`);
        return null;
      }
    });
    this.#queue = task;
    return task;
  }

  /** For back-end requests: runs in the background, so the request doesn't wait for Supertext or the center. */
  inBackground(action: ReporterAction, url: string | null, httpStatus?: number): void {
    void this.run(action, url, httpStatus);
  }

  /** The latest stored key check (for the settings page), or null. */
  async lastCheck(): Promise<KeyCheck | null> {
    try {
      return (await this.#load()).keyCheck;
    } catch {
      return null;
    }
  }
}
