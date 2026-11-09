/**
 * Supertext AI file translation (https://api.supertext.com/v1/) through the shared
 * Supertext SDK: submit one HTML document, poll its status, download the
 * translation, delete the file. No Strapi imports here (tested on its own).
 */
import {
  LIVE_BASE_URL,
  SupertextClient as SdkClient,
  SupertextError as SdkError,
  type ApiKeyCheck,
  type FetchLike,
} from '../vendor/supertext-sdk/v1/index';
import { PLUGIN_NAME, pluginVersion } from '../version';

export type { ApiKeyCheck };

export const LIVE_ENDPOINT = LIVE_BASE_URL;

/**
 * Supertext's review service (translation proxy of Supertext Localization Review). It speaks the
 * same API and forwards to the live Supertext API, keeping every translation so reviewers can
 * correct them on the website. Used for locales with *Translation review* on.
 */
export const REVIEW_URL = 'https://localizationreview-production.up.railway.app/v1/';

/** `Strapi-Supertext-Translation/<version>`, so Supertext and the review service see which release calls. */
export const USER_AGENT = `${PLUGIN_NAME}/${pluginVersion() ?? '0.0.0'}`;

/** Stay well below the API's 1,000,000 character limit per document. */
export const MAX_DOCUMENT_CHARACTERS = 900_000;

export type Politeness = 'default' | 'more' | 'less';

export interface ClientOptions {
  apiKey: string;
  endpoint?: string;
  /** The review service for locales with *Translation review* on. Empty = review off everywhere. */
  reviewEndpoint?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TranslateOptions {
  /** A Supertext target code (`de-CH`, `es`), sent as it is: resolve it with languages.ts first. */
  targetLanguage: string;
  /** A Supertext source code (`en`), sent as it is. Empty = auto-detect. */
  sourceLanguage?: string;
  politeness?: Politeness;
}

/**
 * `code` and `values` let the admin panel show the message in the user's
 * interface language (keys `error.<code>` in admin/src/translations); `message`
 * is the English text for logs and API clients.
 */
export class SupertextError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: string,
    public readonly values: Record<string, string | number> = {}
  ) {
    super(message);
    this.name = 'SupertextError';
  }
}

/** SDK error code → this plugin's code (admin key `error.<code>`) and English message. */
const ERRORS: Record<string, [string, string]> = {
  missing_api_key: ['notConfigured', 'No Supertext API key configured.'],
  authentication_failure: [
    'authFailed',
    'Authentication failed. Please check the Supertext API key. No Supertext account yet? Create one at https://www.supertext.com/person/en/account/signin. Generate your API key at https://www.supertext.com/en/integrations/api (supertext.com → Integrations → API; requires the Admin role).',
  ],
  invalid_language_pair: ['invalidLanguagePair', 'Supertext does not support this language pair.'],
  unsupported_language: [
    'unsupportedLanguage',
    'This language has no Supertext language yet. Ask your administrator to choose its Supertext language under Settings → Supertext → Translation.',
  ],
  unsupported_feature: [
    'unsupportedFeature',
    'Supertext offers no formal or informal tone for this language. Ask your administrator to set it to the default tone under Settings → Supertext → Translation (or remove its politeness option in config/plugins).',
  ],
  not_found: ['notFound', 'The requested Supertext resource was not found.'],
  payload_too_large: ['tooLarge', 'The content is too large for Supertext to translate in one go.'],
  too_many_requests: ['rateLimited', 'Too many requests to Supertext. Please try again shortly.'],
  service_unavailable: ['unavailable', 'The Supertext service is currently unavailable.'],
  unexpected_status: ['http', 'Supertext answered with an unexpected HTTP status.'],
  transport_error: ['unreachable', 'Could not reach Supertext.'],
  no_file_id: ['noFileId', 'Supertext did not return a file id.'],
  translation_error: ['failed', 'Supertext failed to translate the document.'],
  quota_exceeded: ['limitExceeded', 'Your Supertext translation limit is exceeded.'],
  file_deleted: ['fileDeleted', 'The Supertext file was deleted before it could be downloaded.'],
  timeout: ['timeout', 'Timed out waiting for the Supertext translation.'],
  incomplete_response: ['emptyTranslation', 'The translated document was empty.'],
};

/** The SDK's error as this plugin's SupertextError (code and values for the admin panel). */
export function fromSdkError(error: SdkError): SupertextError {
  const [code, english] = ERRORS[error.code] ?? ['unknown', error.message];
  const values: Record<string, string | number> = {};
  if (code === 'http' && error.status) values.status = error.status;
  if (error.detail) values.detail = error.detail;
  if (code === 'invalidLanguagePair') values.detail = `${error.sourceLang ?? '?'} → ${error.targetLang ?? '?'}`;
  if (code === 'unsupportedLanguage' || code === 'unsupportedFeature') {
    const language = error.targetLang ?? error.sourceLang;
    if (language) values.language = language; // else the translator adds the Strapi locale
    delete values.detail;
  }
  let message = code === 'http' && error.status ? `Supertext answered with HTTP ${error.status}.` : english;
  if (values.language && code === 'unsupportedLanguage') message = message.replace('This language', `The language ${values.language}`);
  if (values.language && code === 'unsupportedFeature') message = message.replace('this language', `the language ${values.language}`);
  return new SupertextError(values.detail ? `${message} (${values.detail})` : message, error.status, code, values);
}

/**
 * The plugin's access to the Supertext AI file translation API, built on the shared
 * Supertext SDK (server/src/vendor/supertext-sdk, compiled with the plugin). The SDK does
 * the protocol (upload, polling, download, cleanup also after errors), the auth header
 * (a pasted `Supertext-Auth-Key ` prefix is stripped) and HTTP 429 retries. Language codes
 * are resolved before (languages.ts): the client sends the codes it is given.
 */
export class SupertextClient {
  private readonly sdk: SdkClient;

  private readonly options: ClientOptions;

  private reviewClient: SupertextClient | null = null;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new SupertextError('No Supertext API key configured.', undefined, 'notConfigured');
    }
    this.options = options;
    const pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 2000);
    this.sdk = new SdkClient(options.apiKey, {
      baseUrl: options.endpoint || LIVE_ENDPOINT,
      pollIntervalMs,
      timeoutMs: Math.max(5000, options.pollTimeoutMs ?? 180_000),
      userAgent: USER_AGENT,
      ...(options.fetch ? { fetch: options.fetch as unknown as FetchLike } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
    });
  }

  /**
   * The client for a target locale: the review service when its *Translation review* is on (same
   * key, timeouts, transport and User-Agent), else this one. Without a review endpoint, or with
   * the same one as the API, always this one. Created once, on first use. `translateDocument`
   * submits, polls, downloads and deletes with the same client, so a job is always collected
   * where it was submitted.
   */
  forReview(review: boolean): SupertextClient {
    const reviewEndpoint = (this.options.reviewEndpoint ?? '').trim();
    const endpoint = this.options.endpoint || LIVE_ENDPOINT;
    if (!review || !reviewEndpoint || reviewEndpoint.replace(/\/+$/, '') === endpoint.replace(/\/+$/, '')) {
      return this;
    }
    return (this.reviewClient ??= new SupertextClient({ ...this.options, endpoint: reviewEndpoint, reviewEndpoint: '' }));
  }

  /** Translates a complete HTML document and returns the translated HTML. */
  async translateDocument(html: string, options: TranslateOptions): Promise<string> {
    try {
      return await this.sdk.translateHtml(html, options.targetLanguage, {
        sourceLang: options.sourceLanguage || null,
        politeness: options.politeness ?? 'default',
      });
    } catch (error) {
      throw error instanceof SdkError ? fromSdkError(error) : error;
    }
  }

  /** The automatic key check (`GET features`, cost-free): ok, invalid, missing, unreachable or error. Never throws. */
  static checkApiKey(apiKey: string, endpoint?: string): Promise<ApiKeyCheck> {
    return new SdkClient(apiKey ?? '', { baseUrl: endpoint || LIVE_ENDPOINT, userAgent: USER_AGENT }).checkApiKey();
  }

  /** Cost-free check that the key is valid and the API reachable. */
  async validate(): Promise<void> {
    try {
      await this.sdk.validateApiKey();
    } catch (error) {
      throw error instanceof SdkError ? fromSdkError(error) : error;
    }
  }
}
