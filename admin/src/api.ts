export interface LocaleResult {
  locale: string;
  status: 'created' | 'updated' | 'error';
  fields?: number;
  error?: string;
  code?: string;
  values?: Record<string, string | number>;
}

/** One job of an imported translation file (POST /supertext/import). */
export interface ImportResult {
  uid: string | null;
  documentId: string | null;
  targetLocale: string;
  imported?: number;
  sourceChanged?: number;
  untranslated?: number;
  invalid?: number;
  missing?: number;
  error?: string;
  code?: string;
  values?: Record<string, string | number>;
}

export interface PluginStatus {
  configured: boolean;
  endpoint: string;
  locales: Record<string, { code?: string; politeness?: string; review?: boolean }>;
  contentTypes: string[];
  /** Plugin version from package.json, null if the server couldn't read it. */
  version: string | null;
  /** "Send version information to Supertext" and the latest automatic API key check. */
  reports: { enabled: boolean; check: KeyCheck | null };
}

export type Politeness = 'default' | 'more' | 'less';

/** One row of Settings → Supertext → Languages (GET /supertext/settings). */
export interface LanguageStatus {
  code: string;
  name: string;
  /** The Supertext code it is sent as (mapping, exact match or default); null = translating into it fails. */
  target: string | null;
  /** Saved with the combo box (null: nothing saved). */
  saved: string | null;
  /** Preselected when nothing is saved: the exact match, else the SDK default, else null. */
  suggested: string | null;
  /** Set under locales in config/plugins: wins over the combo box. */
  override: { code?: string; politeness?: Politeness; review?: boolean };
  /** The tone that applies (config/plugins wins). */
  politeness: Politeness;
  /** The tone saved on this page. */
  savedPoliteness: Politeness;
  politenessSupported: boolean | null;
  /** Translation review that applies (config/plugins wins). */
  review: boolean;
  /** Translation review saved on this page. */
  savedReview: boolean;
}

/** A Supertext target language for the combo box (the SDK's targetOptions()). */
export interface TargetOption {
  code: string;
  name: string;
  /** Whether Supertext offers formal/informal for it. */
  politeness: boolean;
}

export interface SettingsPage {
  languages: LanguageStatus[];
  targets: TargetOption[];
  /** False when reviewUrl is '' (Translation review off for every locale). */
  reviewAvailable: boolean;
}

/** The plugin's admin permissions (server/src/permissions.ts). */
export const PERMISSIONS = {
  read: [{ action: 'plugin::supertext.settings.read', subject: null }],
  update: [{ action: 'plugin::supertext.settings.update', subject: null }],
};

/** The SDK's API key check (`keycheck.<status>` in translations/*.json). */
export interface KeyCheck {
  status: 'ok' | 'invalid' | 'missing' | 'unreachable' | 'error';
  checkedAt: string;
  httpStatus: number | null;
  errorCode: string | null;
}

export interface StrapiLocale {
  id: number;
  code: string;
  name: string;
  isDefault: boolean;
}

/** An error from the plugin's API: English `message`, plus `code`/`values` for a translated text. */
export interface ApiError {
  message: string;
  code?: string;
  values?: Record<string, string | number>;
}

/** Reads the plugin's error out of a fetch-client error. */
export const apiError = (error: unknown): ApiError => {
  const e = error as {
    response?: { data?: { error?: { message?: string; details?: { code?: string; values?: ApiError['values'] } } } };
    message?: string;
  };
  const body = e?.response?.data?.error;
  return {
    message: body?.message ?? e?.message ?? 'Unknown error',
    code: body?.details?.code,
    values: body?.details?.values,
  };
};
