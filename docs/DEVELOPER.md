# Developer guide — Supertext Translation for Strapi

How the plugin is built, how to work on it, and how it's tested, released and deployed.

## Repository layout

```
admin/src/                 Admin panel (React)
  index.ts                 Registers the edit-view side panel and the settings page
  components/SupertextPanel.tsx
  components/LanguagesCard.tsx  Settings → Supertext → Languages: one SingleSelect per Strapi locale
  pages/Settings.tsx       Settings → Supertext → Translation
  translations/{en,de,fr,it}.json  Admin strings (react-intl), incl. error.<code> messages
  utils/errorText.ts       Server error code → message in the user's language
server/src/                Server (Koa) part
  config/index.ts          Defaults + validation of plugin config
  routes/admin/index.ts    /supertext/* admin routes
  routes/content-api/      public GET /api/supertext/ping (Commando Center)
  controllers/translate.ts Permission checks, request handling, when the reporter runs
  services/translator.ts   Orchestration: load source, translate per locale, save (loadEntry/loadSource/writeLocale shared with files)
  services/files.ts        Translation files: export (XLIFF/HTML) and import with the SDK's TranslationFiles, reference format
  services/settings.ts     The language mapping in the core store, combined with config/plugins locales
  language-settings.ts     Validating, reading and combining the mapping (no Strapi imports)
  permissions.ts           Admin actions plugin::supertext.settings.read / .update
  services/reporting.ts    one Reporting per process: state in the core store, Strapi version, REST prefix
  reporting.ts             Commando Center: version reports, API key check, ping (Plugin Health's InstallationReporter + the SDK's key check)
  services/extract.ts      Pure schema walk: data for the target + text segments
  supertext/client.ts      the plugin's Supertext client on top of the Supertext SDK; SDK error codes → plugin codes; forReview() for locales with Translation review
  supertext/languages.ts   Strapi locale → Supertext code (the SDK's Languages: mapping, exact match, default)
  vendor/supertext-sdk/    Supertext SDK sources (TypeScript), bundled with the server; see *Supertext SDK*
  vendor/supertext-plugin-health/  Supertext Plugin Health sources (TypeScript), bundled with the server; see *Supertext Plugin Health*
  supertext/html.ts        Pack/unpack segments into one HTML document
  supertext/blocks.ts      Strapi "blocks" inline nodes <-> HTML
scripts/vendor-sdk.sh      updates server/src/vendor/supertext-sdk
scripts/vendor-plugin-health.sh  updates server/src/vendor/supertext-plugin-health
test/                      Vitest unit tests + mock Supertext API
test/e2e/                  End-to-end test against the real Supertext API (own package.json)
demo/                      Strapi 5 demo app (Article type, Swiss locales, sample entry)
Dockerfile, railway.json   Demo image for Railway
```

## How a translation runs

```
Editor clicks "Translate with Supertext" (SupertextPanel)
  → POST /supertext/translate { model, documentId, sourceLocale, targetLocales }
      controller: Content Manager permission checker
        read(sourceLocale) and create|update(each target locale), else 403
      translator.translate()
        source = documents(uid).findOne({ documentId, locale, status: 'draft', populate })
                 populate = populateFor(schema): media, components, dynamic zones (deep)
        for each target locale:
          extract(schema, source) → { data, jobs, uidFields }
          translateJobs(): all segments → ONE HTML document (split > 900k chars)
                           → Supertext → parse → job.apply() writes into data
          uid fields: new locale → content-manager uid service from translated target field
                      existing locale → keep its current slug
          documents(uid).update({ documentId, locale, data })   // creates or replaces the draft
      ← { results: [{ locale, status: created|updated|error, fields, error? }] }
```

`extract()` rules (see `services/extract.ts`):

| Attribute | Handling |
| --- | --- |
| `string`, `text`, `richtext` | Plain-text segment (Markdown syntax survives). Skipped if empty or purely numeric. |
| `blocks` | Each paragraph/heading/quote/list-item becomes an HTML segment with `<strong> <em> <u> <s> <code> <a href>`; code blocks are skipped. |
| `component`, `dynamiczone` | Recursed; `id`s dropped so new component rows are created; `__component` kept. |
| `media` | Copied as file ids. |
| `uid` | Copied, then regenerated (see above). |
| numbers, booleans, dates, enumerations, email, json | Copied. |
| `relation`, `password` | Skipped. |
| Top-level fields with `pluginOptions.i18n.localized: false` | Skipped (shared across locales). |

## Supertext API protocol

Shared with the WordPress plugin and every other Supertext plugin, and done by the Supertext SDK:

1. `POST {base}translate/ai/file` — multipart: `file` (part type exactly `text/html`, no charset, else 415), `target_lang` (a Supertext target code, e.g. `de-CH`, `es`), optional `source_lang` (bare language, e.g. `en`; see *Language codes*), optional `politeness` (`more`/`less`) → `{ file_id }`
2. `GET …/{file_id}/status` until `done` (`error`, `limit_exceeded`, `deleted` are terminal)
3. `GET …/{file_id}/translation` → translated HTML
4. `DELETE …/{file_id}`, also after errors (files also expire after 24 h)

Header: `Authorization: Supertext-Auth-Key <key>`. The key may be configured with or without the `Supertext-Auth-Key ` prefix; exactly one is sent. The header name must be `Authorization` (the live API answers 403 to `Authentication`).

**Rate limit:** the API limits requests per second per key (HTTP 429, `RATE_LIMIT_EXCEEDED`); translating into several languages at once hits it. A 429 is retried up to 4 times, waiting for `Retry-After` if sent, otherwise 1, 2, 4 and 8 seconds (plus jitter, at most 30 s), before reporting *Too many requests*. Each segment travels as `<div data-st-id="N">…</div>` (`server/src/supertext/html.ts`); plain text is escaped with line breaks as `<br>`.

### Supertext SDK

All Supertext calls go through the [Supertext SDK](https://github.com/Supertext/Supertext-API-SDK-Guide) (`sdk/typescript`), the shared client of all Supertext plugins: it provides the API client and the API key check (`checkApiKey()`, `apiKeyFingerprint()`, `SDK_VERSION`); version reports are Supertext Plugin Health's (below). Its TypeScript sources (`index.ts`, `version.ts` and the API version folder `v1/`; the plugin imports `vendor/supertext-sdk/v1/index`) are copied into `server/src/vendor/supertext-sdk/` and bundled into `dist/server` by `strapi-plugin build`, so sites install nothing besides the plugin; `COMMIT` and `VERSION` name the SDK commit and version (the server's `tsconfig.json` uses `lib: ES2022` for them). Never edit the copy: fix the SDK repository and copy it again with `scripts/vendor-sdk.sh [commit-or-tag]` (or `SDK_DIR=<clone> scripts/vendor-sdk.sh`), then run tests, type checks and the build, and note the update in `CHANGELOG.md`.

`server/src/supertext/client.ts` wraps the SDK client and maps the SDK's error codes to the plugin's own (`error.<code>` in the admin translations): `missing_api_key` → `notConfigured`, `authentication_failure` → `authFailed`, `invalid_language_pair` → `invalidLanguagePair` (detail: the codes sent), `unsupported_language` → `unsupportedLanguage` and `unsupported_feature` → `unsupportedFeature` (value `language`: the Strapi locale), `not_found` → `notFound`, `payload_too_large` → `tooLarge`, `too_many_requests` → `rateLimited`, `service_unavailable` → `unavailable`, `unexpected_status` → `http`, `transport_error` → `unreachable`, `no_file_id` → `noFileId`, `translation_error` → `failed`, `quota_exceeded` → `limitExceeded`, `file_deleted` → `fileDeleted`, `timeout` → `timeout`, `incomplete_response` → `emptyTranslation`. The API key never appears in messages. The User-Agent is `Strapi-Supertext-Translation/<version>` (`USER_AGENT`, the version from `package.json` as in the reports), after the SDK's own.

### Translation review

**Translation review** (per target locale: the checkbox under *Settings → Supertext → Translation → Languages*, stored as `review: true` with the locale's entry in the core store; `locales.<locale>.review` in `config/plugins` overrides it): `translate()` in `server/src/services/translator.ts` takes `SupertextClient.forReview(mapping[locale]?.review === true)` for each target, a second SDK client with the same key, timeouts, fetch and User-Agent whose base URL is `reviewUrl` (`SUPERTEXT_REVIEW_URL`, default `REVIEW_URL`, the translation proxy of [Supertext Localization Review](https://github.com/Supertext/Localization-Review-Supertext-Translation)), created once on first use. `translateDocument()` runs the whole round trip (upload, status, download, delete) on one client, so a job is always collected where it was submitted. The proxy speaks the same API v1, forwards to the live Supertext API with the plugin's key, stores every segment per key and serves reviewers' corrections on the next upload, so nothing else changes in the plugin. `reviewUrl: ''` (or the same URL as `endpoint`) means `forReview()` always returns the direct client, and the settings page greys out the checkboxes (`reviewAvailable`). The key check (`SupertextClient.checkApiKey`, **Test connection**), the reports and translation files never use the review service. Tests: `test/client.test.ts` (*Translation review*: all four calls to the review URL with the same key and User-Agent, other locales direct, off with an empty or identical URL, the default and `SUPERTEXT_REVIEW_URL`) and `test/language-settings.test.ts` (storing, validating and overriding `review`).

### Language codes

Supertext accepts exactly the codes its `GET features` lists (the SDK's `Languages`, from the live API): bare sources (`en`, `de`); targets in one exact form each, regional for German, English, French, Italian and Portuguese (`de-CH`, `en-US`, `pt-BR`), with a script for Chinese and Serbian (`zh-Hans`, `sr-Latn`), a dialect for Swiss German (`gsw-u-sd-chzh`), bare for the others (`es`, `nl`, `sl`). Anything else is HTTP 404 `INVALID_LANGUAGE_PAIR`; formal/informal for a target without it (`en-US`, `rm`, …) is HTTP 400 `FEATURE_ERROR` (`unsupported_feature`). No pair within one language.

`server/src/supertext/languages.ts` turns Strapi locales into Supertext codes with the SDK's `Languages` (SDK 0.4.0). The language mapping is chosen under *Settings → Supertext → Translation → Languages*, one design-system `SingleSelect` per Strapi locale (`admin/src/components/LanguagesCard.tsx`), and stored in Strapi's core store (type `plugin`, name `supertext`, key `languages` → row `plugin_supertext_languages`, `{ <locale>: { code, politeness, review } }`, `review` only stored when on). `locales.<locale>.code` / `.politeness` / `.review` in `config/plugins` stay as an override for automated setups: `effectiveOptions()` in `server/src/language-settings.ts` lets each field set there win over the page, and the page shows it read-only. Configurations from before the page existed are not migrated: they keep working as overrides.

- `targetCode(locale, code)`: the SDK's `Languages.target(locale, mapping)`: the mapping wins (sent as it is, so a code from `config/plugins` that Supertext adds later works before the SDK lists it); else a locale that equals a Supertext code apart from case and `_`/`-` (`de-CH`, `fr_ch` → `fr-CH`, `es`); else the SDK's default (`Languages.defaultTarget`: `de` → `de-DE`, `en` → `en-US`, `fr` → `fr-FR`, `it` → `it-IT`, `pt` → `pt-PT`, `zh`/`zh-CN`/`zh-SG` → `zh-Hans`, `zh-TW`/`zh-HK`/`zh-MO` → `zh-Hant`, `sr` → `sr-Latn`, a region of a bare target → the bare target: `es-ES` → `es`); else `SupertextError('unsupportedLanguage', { language })`, which the translator reports for that locale without calling Supertext (`en-IE`, `de-LI`, `gsw`, `sr-RS` need a mapping).
- `sourceCode(locale, code)`: the SDK's `Languages.source()` with the same mapping, which sends the code in its source form (`de-CH` → `de`; one mapping for both directions), else the locale's language (`en-US` → `en`), else `unsupportedLanguage`.
- `politenessFor(target, politeness)`: `more`/`less` for a target where `Languages.supportsPoliteness()` is false is `unsupportedFeature` before anything is sent (never dropped silently); targets the SDK doesn't list get it as configured.
- The settings page: `GET /supertext/settings` returns every Strapi locale (i18n's `locales` service) with `saved`, `suggested` (`Languages.suggestTarget()`: exact match, else default, else null), `override`, `target` (what is sent; null = fails) and the tone, plus `targets` (`Languages.targetOptions()`, shown as "Name (code)" with the name from the browser's `Intl.DisplayNames` in the admin's language, the SDK's English name for `gsw-u-sd-*`). Each combo box starts with `saved`, else `suggested`, else *— choose —* (marked red). The politeness select appears only where the chosen target offers it. `PUT /supertext/settings` validates every code against the SDK's list (`Languages.matchTarget()`, stored in canonical form) and every locale against i18n, and refuses politeness for a target without it (400 `invalidSettings`).

The mock APIs (`test/mock-supertext.mjs`, `test/mock-sample-de.mjs`) accept exactly the live target list and bare sources (404 `INVALID_LANGUAGE_PAIR` otherwise) and reject politeness where it isn't offered.

### Supertext Plugin Health

[Supertext Plugin Health](https://github.com/Supertext/Commando-Center-Supertext-Translation/tree/main/plugin-health) (`plugin-health/typescript`, in the Commando Center repository) sends the version reports and the API key check result to the Supertext Commando Center and answers its reachability ping (`InstallationReporter`, `reportsEnabled()`, `reporterState()`, `pingResponse()`). It has no dependencies and doesn't call Supertext itself: `server/src/reporting.ts` passes it the SDK's version (`SDK_VERSION`) and a key checker built on the SDK (`{ check: (key) => new SupertextClient(key, …).checkApiKey(), fingerprint: apiKeyFingerprint }`). Its TypeScript sources (`index.ts`) are copied into `server/src/vendor/supertext-plugin-health/` and bundled into `dist/server` like the SDK; `COMMIT` and `VERSION` name the commit and version. Never edit the copy: fix it in Commando-Center-Supertext-Translation/plugin-health and copy it again with `scripts/vendor-plugin-health.sh <tag>` (e.g. `plugin-health-v0.1.0`; or `PLUGIN_HEALTH_DIR=<clone> scripts/vendor-plugin-health.sh`), then run tests, type checks and the build, and note the update in `CHANGELOG.md`.

### Commando Center: version reports, key check, ping

Protocol: [Commando-Center-Supertext-Translation](https://github.com/Supertext/Commando-Center-Supertext-Translation) → `docs/DEVELOPER.md` → *Report protocol*; Plugin Health's `InstallationReporter` and `pingResponse()` and the SDK's `checkApiKey()` implement it, `server/src/reporting.ts` only supplies what Strapi knows (no Strapi imports there; `services/reporting.ts` wires it to Strapi):

- **Setting:** `versionReports` in the plugin config (default `true`), combined with `SUPERTEXT_VERSION_REPORTS` by Plugin Health's `reportsEnabled()` (the environment wins). Off: no reports, ping 404. `SUPERTEXT_REPORT_URL` sends reports elsewhere (tests, the mocks' `POST /report`).
- **Report fields:** `site_url` = `server.url` if absolute, else the admin request's origin (`ctx.request.origin`; the demo sets `proxy: true`); plugin `Strapi-Supertext-Translation` with the version from `package.json` (`version.ts`); system `Strapi` with `strapi.config.get('info.strapi')`; `callback.url` = `<site><api.rest.prefix>/supertext/ping`.
- **When:** the config lives in `config/plugins`, so there is no `settings_saved`. `onRequest` runs in the background on `GET /supertext/status` (settings page and editor panel) and after `POST /supertext/translate` (reports `installed`, `upgraded` or `api_key_check`; checks the key only when its fingerprint changed); `POST /supertext/test-connection` runs `testConnection` and waits for it; a locale that failed with `authFailed` runs `authenticationFailed` with Supertext's HTTP status. Calls are serialized per process. Nothing here ever throws into a request.
- **State:** the reporter's JSON (`reporterState()`; the same format the SDK 0.2 reporter stored, so updating sends no new `installed`) in Strapi's core store (`strapi.store`, type `plugin`, name `supertext`, key `reporter` → row `plugin_supertext_reporter` in `strapi_core_store_settings`). It holds the key's SHA-256 fingerprint, never the key.
- **Ping:** content API route `GET /ping` with `auth: false` → `/api/supertext/ping`; status, headers (`Cache-Control: no-store`) and body exactly as `pingResponse()` returns them. Strapi has no page cache.

## Translation files (export and import)

*Export for translation* and *Import translation* in the panel use the SDK's `TranslationFiles` (SDK 0.5.0, `server/src/vendor/supertext-sdk/translation-file.ts`, imported from `vendor/supertext-sdk/index`: it doesn't call the API, so it isn't in `v1/`). The glue is `server/src/services/files.ts`, the routes are in `controllers/translate.ts` (`exportFile`, `importFile`):

- **Segments:** `extract()`, the same as API translation. Every `Job` has a `key`, its attribute path: `title`, `seo.metaTitle`, `sections.0.quote`, `body.1.0` (blocks: the index in the field, then in `children`), and `keep(other)`, which puts back the value another version of the entry has at that place.
- **Job metadata:** `plugin` = `Strapi-Supertext-Translation`; `sourceLanguage`/`targetLanguage` = the codes the mapping resolves (`sourceCode`/`targetCodeOrNull` with `settings().mapping()`), else the Strapi code with `_` → `-`, so unmapped locales can still be exported.
- **Reference format:** `entry:<content-type uid>:<documentId>:<sourceLocale>:<targetLocale>`, each part URI-encoded (`entry:api%3A%3Aarticle.article:abc123:en:de-CH`; `formatReference`/`parseReference`). The source locale is in it because the import collects the segments from the same locale again.
- **Export:** XLIFF = one job per target locale in one file, HTML = exactly one target. File name `strapi-<type>-<documentId>[-<locale>].xlf|.html`.
- **Import:** the controller reads the multipart temp file (refused over 10 MB before reading, deleted in `finally`); `TranslationFiles.read`, then per job: `plugin` must be ours (else `fileOtherSystem`), the reference must parse and name a localized, enabled content type and an existing entry (else `fileNotFound`), both locales must exist in i18n (else `fileNoLanguage`), the user must read the source and create/update the target (else `forbiddenEdit`); then `extract()` again and `importTranslations`. `ok` results (and `source_changed` with `includeChanged`) go through `job.apply`, every other job gets `job.keep(target)` (the target locale's draft; without one it keeps the source, as API translation does), and `writeLocale` saves like an API translation (uid fields kept or generated, draft). Nothing is saved when nothing was imported.

## Admin API

All routes require an authenticated admin (`admin::isAuthenticatedAdmin`). The settings routes also need the plugin's admin permissions (`server/src/permissions.ts`, registered in `bootstrap.ts` with the admin's `actionProvider`; under *Roles → Settings → Supertext*): `plugin::supertext.settings.read` for the page (the settings link checks it too), `GET /settings` and `POST /test-connection`; `plugin::supertext.settings.update` for `PUT /settings`. Super Admins get both automatically.

| Route | Purpose |
| --- | --- |
| `GET /supertext/status` | `{ configured, endpoint, locales, contentTypes, version, reports: { enabled, check } }` (never the key; `version` is read from the plugin's `package.json` at runtime; `check` is the latest key check `{ status, checkedAt, httpStatus, errorCode, fingerprint }`) |
| `POST /supertext/test-connection` | The SDK's key check (`GET features`, no cost) → `{ ok, check }` with `check.status` `ok`, `invalid`, `missing`, `unreachable` or `error`. Always HTTP 200 (a 401 would sign the admin out); the page shows `keycheck.<status>` |
| `GET /supertext/settings` | `{ languages: [{ code, name, target, saved, suggested, override, politeness, savedPoliteness, politenessSupported }], targets: [{ code, name, politeness }] }` (see *Language codes*) |
| `PUT /supertext/settings` | Body `{ languages: { <locale>: { code, politeness } } }` (`code` empty = nothing saved: the default applies); answers like `GET`, or 400 `invalidSettings` |
| `GET /supertext/locales?model=&documentId=` | Locales that exist for a document |
| `POST /supertext/translate` | See above |
| `GET /supertext/export?model=&documentId=&sourceLocale=&targetLocales=a,b&format=xliff\|html` | *Export for translation*: the file with `Content-Disposition: attachment` (`application/x-xliff+xml` or `text/html; charset=utf-8`); same permission checks as `/translate`; 422 `fileNothing`, 400 `fileHtmlOneLocale`. No API key needed |
| `POST /supertext/import` | *Import translation*: multipart `file` (≤ 10 MB, else 413 `fileTooLarge`) and `includeChanged` (`1`); `{ results: [{ uid, documentId, targetLocale, imported, sourceChanged, untranslated, invalid, missing }` or `{ …, error, code, values }] }`; 422 `fileInvalid`/`fileMissingMetadata` for an unreadable file |

Public (content API, no login): `GET /api/supertext/ping?challenge=<16–64 of A-Z a-z 0-9 _ ->` → 200 `{ ok: true, plugin: "Strapi-Supertext-Translation", challenge }`, 400 `{ ok: false }` for any other challenge, 404 with version reports off.

## Local development

```bash
npm ci
npm test                 # unit tests (vitest)
npm run test:ts:back     # type-check server
npm run test:ts:front    # type-check admin
npm run build            # dist/ via @strapi/sdk-plugin

# Run the demo against the mock API
npm run mock &           # http://localhost:8765/v1/, key "test-key"; POST /report stands in for the center
cp demo/.env.example demo/.env
npm run demo:install     # build + pack the plugin, install it into demo/
cd demo && npm run develop
```

Without `DATABASE_URL` the demo uses SQLite via `better-sqlite3`, an optional dependency: it's skipped where it can't be installed (e.g. the Railway image, which uses PostgreSQL). If SQLite fails to load locally, run `npm --prefix demo rebuild better-sqlite3`.

The mock "translates" by prefixing every text node with `[<target>] `, which makes it easy to see which fields were translated. Point `SUPERTEXT_API_KEY`/`SUPERTEXT_API_ENDPOINT` in `demo/.env` at the real API to test for real.

Why a tarball instead of `npm link`? Linking makes the plugin load its own copy of React and the design system, which breaks the admin panel. `npm install ./plugin.tgz` puts the plugin inside `demo/node_modules` so it shares the demo's dependencies. Install the tarball explicitly (as `demo:install` does): with an unchanged version number, a plain `npm install` keeps the old copy.

## Interface strings

The admin panel's strings live in `admin/src/translations/{en,de,fr,it}.json` (react-intl messages, loaded by `registerTrads` in `admin/src/index.ts` and prefixed with the plugin id). English is the source and fallback. New or changed strings need all four languages in the same commit: formal address (Sie, vous, Lei), Strapi's own terms in each language (de *Sprache*/*Eintrag*, fr *locale*/*entrée*, it *lingua*/*elemento*), and "Supertext", `{placeholders}`, `<tags>` and URLs unchanged. Use typographic apostrophes (’) in French and Italian: a straight `'` before `{` or `<` is an ICU quote.

Server errors are English (`message`, for logs and API clients) and carry a `code` and `values` (`SupertextError`, `TranslationError`, the controller's `forbidden` details and the per-locale results). The admin panel shows `error.<code>` from the translation files via `utils/errorText.ts`, falling back to the English message. A new server error gets a code and an `error.<code>` entry; `test/translations.test.ts` checks both.

## Tests

| File | Covers |
| --- | --- |
| `test/html.test.ts` | Segment packing round trip (escaping, line breaks, Unicode, Markdown) |
| `test/blocks.test.ts` | Blocks inline ↔ HTML (marks, links, line breaks) |
| `test/extract.test.ts` | Field selection, copying, ids, dynamic zones, populate tree |
| `test/client.test.ts` | The plugin's client on the SDK: call sequence, form fields, key prefix, 429 retries, error codes, cleanup, the review service client (`forReview`, default `REVIEW_URL`, off with an empty URL), the User-Agent with the version (the SDK's own tests run in the SDK repository) |
| `test/translations.test.ts` | All four admin languages have the same keys, placeholders, tags and URLs; every key, server error code and key check result has an English message |
| `test/languages.test.ts` | Locale → Supertext code: exact matches, the mapping, the SDK defaults (`de` → `de-DE`, `zh-TW` → `zh-Hant`, `es-ES` → `es`), `unsupportedLanguage` for `en-IE`, `de-LI`, `gsw`; bare sources; formal/informal only where offered; the combo box's target list |
| `test/language-settings.test.ts` | The settings page's mapping: validation against the locales and Supertext's list, reading the core store, the `config/plugins` override per field, the rows (saved, suggested, override, target), *Translation review* per locale |
| `test/files.test.ts` | Translation files with a fake Strapi: reference round trip; export (extraction keys, mapped and unmapped languages, XLIFF with several targets, HTML with one, nothing to translate); import (written like API translations with slug and blocks formatting, `source_changed` only with the option, untranslated/invalid/missing not written and the target's own text kept, HTML with refused markup, other system, unknown entry or type, missing locale, permissions, unreadable files); the controller's download headers, permission check, temp file deleted and 10 MB limit |
| `test/status.test.ts` | Version from `package.json`, status without the key |
| `test/reporting.test.ts` | The setting and the environment, site URL, state kept in the store (never the key), one `installed` report, a changed key checked again, a 401 reported once as `api_key_check`, *Test connection*, nothing sent with reports off, ping answers, no exception when the store fails (fake fetch, never the live API or center) |

CI (`.github/workflows/ci.yml`) runs type checks, tests and the build on Node 22, 24 and 26, then builds the demo admin panel with the packed plugin.

## End-to-end tests

The unit tests use fakes. `.github/workflows/e2e.yml` also tests against the **real Supertext API**, so changes on Supertext's side (language codes, regional variants, formatting, rate limits) show up. It runs on every push to `main` that touches the plugin, the demo or the tests, on pull requests that change the E2E test or workflow, every Monday, and by hand (*Actions → E2E → Run workflow*). It builds the demo image (`Dockerfile`) once (Docker layer cache in GitHub Actions) and starts it twice, each with a new PostgreSQL database and demo accounts and Strapi secrets made up for the run:

1. **Real API** (repository or organization secret `SUPERTEXT_API_KEY`; without it these steps are skipped with a warning). Version reports are off (`SUPERTEXT_VERSION_REPORTS=0`), so CI runs don't appear in the Commando Center.
   - `test/e2e/features.mjs` asks the live `GET features` (cost-free, no plugin or SDK code) whether every pair the demo translates (`en` → `de-CH`, `fr-CH`, `it-CH`) is offered; a missing pair fails the run. Whether the plugin's own language list matches the API is the SDK's job (its own tests).
   - `test/e2e/live.mjs` (Playwright): the demo editor (`DEMO_EDITOR_*`) logs in to the admin panel, opens each English article, ticks every other locale in the *Supertext translation* panel and clicks *Translate with Supertext*. Then each locale is read back through Strapi's Content Manager API (as the editor) and checked: every English article has exactly one entry per locale, left as a draft, with a slug; every text field and every block is filled and at least 80 % of them changed (single words may stay the same); no `data-st-id`/placeholder or wrapper `<div>` is left; bold, italics, links (and their URLs), headings, list items and the Markdown of rich-text fields are kept; the non-localized `readingTime` is copied; the text is in the target language (common words of each language counted) and de-CH has no "ß"; the panel shows *created*/*replaced* for each locale and no error. Translating again (with the overwrite warning) must update the same entries (same documents, same slug, still drafts, no new entries). Strapi has no placeholders or shortcodes, so the sample content has none. Each run translates the sample article twice into three languages (around 2,500 characters on the key's account).
2. **Stand-in API** (`test/mock-sample-de.mjs`): the docs screenshots (see *Docs screenshots*), so the images don't change with each machine translation. If `docs/images/` changed, a second job pushes the branch `automation/docs-screenshots` and opens (or updates) the pull request "Docs: regenerate screenshots". This needs *Settings → Actions → General → Allow GitHub Actions to create and approve pull requests*.

If a run fails, the artifact `e2e-debug` has the result pages (`artifacts/*.png`), the demo logs and the stand-in log. Locally:

```bash
cd test/e2e && npm install && npx playwright install chromium
# fresh demo (new database) with a real SUPERTEXT_API_KEY and DEMO_EDITOR_*, e.g. PORT=8081
SUPERTEXT_API_KEY=… E2E_TARGETS=de-CH,fr-CH,it-CH node features.mjs
STRAPI_URL=http://127.0.0.1:8081 EDITOR_EMAIL=… EDITOR_PASSWORD=… npm run live
```

`live.mjs` checks the language of the texts, so against the stand-in (which answers German for every locale) only the German checks pass; use it there to try changes to the UI steps without a key.

## Docs screenshots

The screenshots in `docs/images/` come from the local demo and are regenerated with one script whenever the panel, settings page or demo content changes:

```bash
npm run docs:mock &        # stand-in API that returns real German for the sample article
npm run demo:install
cd demo && rm -rf .tmp && DEMO_ADMIN_EMAIL=anna.muster@example.com DEMO_ADMIN_PASSWORD=Docs12345 \
  SUPERTEXT_API_KEY=test-key SUPERTEXT_API_ENDPOINT=http://127.0.0.1:8765/v1/ \
  SUPERTEXT_REPORT_URL=http://127.0.0.1:8765/report npm run develop &
cd .. && npx playwright install chromium   # once
npm run docs:screenshots
```

Other ports: `MOCK_PORT` for the stand-in, `PORT` for Strapi and `STRAPI_URL` (e.g. `http://127.0.0.1:20601`) for the script. Start from an empty demo database (`rm -rf demo/.tmp`) so the first translation shows as *created*. The script logs in with `DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD` (the defaults above are local-only), captures the edit view, the panel before/after translating, the German result, the overwrite warning, the settings page, its language combo boxes (`settings-languages.png`) and the locales page, and shows the live endpoint on the settings screenshot instead of the local stand-in's address.

## Demo movie

`docs/images/demo.gif` at the top of the README is a short demo movie (English captions; the GIF is silent, the MP4 of about 37 s has a spoken voice-over): the intro card, the English sample article, ticking German and French in the Supertext panel, *Translate with Supertext*, a moment of the progress state (the wait is cut), both drafts created, the German draft opened with *Open*, and the outro card. It is recorded from the local demo against the stand-in, signed in as the demo's editor:

```bash
pip install piper-tts                      # once: the voice (without it the movie is silent)
MOCK_DELAY_MS=7000 npm run docs:mock &   # stand-in; answers "translating" for 7 s so the progress state shows while it is said
npm run demo:install
cd demo && rm -rf .tmp && DEMO_ADMIN_EMAIL=anna.muster@example.com DEMO_ADMIN_PASSWORD=Docs12345 \
  DEMO_EDITOR_EMAIL=eddie.editor@example.com DEMO_EDITOR_PASSWORD=Docs12345 \
  SUPERTEXT_API_KEY=test-key SUPERTEXT_API_ENDPOINT=http://127.0.0.1:8765/v1/ \
  SUPERTEXT_REPORT_URL=http://127.0.0.1:8765/report npm run develop &   # plus the variables from demo/.env.example
cd .. && npm run docs:movie
```

Start from an empty demo database: the script translates into German and French, so a second run would show the overwrite warning. It signs in with `DEMO_EDITOR_EMAIL`/`DEMO_EDITOR_PASSWORD` (defaults above, local-only); `STRAPI_URL`, `MOCK_PORT`, `PORT` and `CHROME` work as for the screenshots. Recording, captions, cursor and the intro/outro cards come from the shared Supertext movie kit in `test/docs/movie/` (`movie-kit.mjs`, logo and Inter font with its SIL OFL licence; the same kit records every plugin's movie, so don't restyle it here). It needs `ffmpeg`.

**Voice:** each step is spoken with Piper (`pip install piper-tts`) and the voice *alba*; the caption shows a shorter version of the same sentence (`kit.say()` in `test/docs-movie.mjs`). The voice model (63 MB, pinned revision, SHA-256 checked) downloads once into `~/.cache/supertext-movie` and is never committed. Time spent generating speech is cut out of the movie. Without Piper, or with `MOVIE_VOICE=0`, the movie is made without sound. The voice is mixed into the MP4 (AAC, loudness-normalised); the GIF has no sound.

Voice: Piper voice “alba” (en_GB), trained on a dataset from the University of Edinburgh's Centre for Speech Technology Research, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)

The script writes the GIF (800 px, 12 fps, keep it under 3 MB) to `docs/images/demo.gif`, which is committed, and the MP4 (1280×720, H.264) to `test/docs/movie/out/Strapi-Supertext-Translation.mp4` (git-ignored; `MOVIE_OUT` for another path), which isn't committed. The GIF is left out of the npm package. Re-record it when the panel or the demo content changes.

**Install movie:** `npm run docs:movie:install` (`test/docs-movie-install.mjs`, same kit and voice) records how an administrator installs and sets up the plugin (about 87 s, MP4 only, no GIF): the intro card, the install commands from [INSTALLATION.md](INSTALLATION.md) typed in a terminal (`git clone` / `npm ci && npm run build && npm pack`, `npm install` of the tarball, `config/plugins.js`, the key in `.env`, `npm run build` / `npm run develop`; output shortened from the real commands), Strapi's locales under *Settings → Internationalization*, *Settings → Supertext → Translation* with *API key is set* and *Test connection*, German (Switzerland) picked in the language combo box (*Translation review* mentioned, left off), *Save*, the *Translate with Supertext* button on an entry, and the outro card. It signs in as the demo's admin (`DEMO_ADMIN_EMAIL`/`DEMO_ADMIN_PASSWORD`, defaults as above). Start the demo as above but with the fake key `SUPERTEXT_API_KEY=st-demo-0000-0000-0000` (the stand-in accepts any key) and without `MOCK_DELAY_MS`; the script shows the stand-in's address on the settings page as `https://api.supertext.com/v1/`. The MP4 goes to `test/docs/movie/out/Strapi-Supertext-Translation-install.mp4` (git-ignored; `MOVIE_OUT` for another path) and isn't committed. Re-record it when the install steps or the settings page change.

## Demo deployment (Railway)

The Railway service `Strapi` in project `supertext-cms-demos` builds this repo's `Dockerfile` on every push to `main`. The image builds the plugin, installs it into `demo/`, builds the admin panel and runs `strapi start`.

Service variables: `DATABASE_URL` (from the Postgres service), `APP_KEYS`, `ADMIN_JWT_SECRET`, `API_TOKEN_SALT`, `TRANSFER_TOKEN_SALT`, `JWT_SECRET`, `ENCRYPTION_KEY`, and `SUPERTEXT_API_KEY` (set by hand in the Railway dashboard). Uploads live on the volume mounted at `/app/public/uploads`.

Optional variables that make a fresh demo ready to use without registering in the browser (set them in the Railway dashboard; never commit them):

| Variable | Effect |
| --- | --- |
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD` | Creates a Super Admin on startup |
| `DEMO_EDITOR_EMAIL`, `DEMO_EDITOR_PASSWORD` | Creates an Editor, e.g. for automated tests |

Accounts are only created if they don't exist yet; an existing account's password is never changed by these variables (change it in the admin panel instead). Passwords must follow Strapi's rule (8+ characters, upper- and lower-case letter, number), otherwise the account is skipped with a warning in the log.

On every start the demo also ensures the locales de-CH, fr-CH and it-CH, gives Strapi's Editor role access to all locales (Strapi doesn't grant locales added later to existing roles), and saves formal address for the Swiss locales under *Settings → Supertext → Languages* if no language settings are saved yet, and creates one English sample article if none exists (`demo/src/index.js`).

## Dependency updates

Dependabot (`.github/dependabot.yml`) opens weekly pull requests: minor and patch updates grouped into one, GitHub Actions in another, each major update on its own. Merge one when CI is green and it doesn't change what the plugin supports.

`.github/workflows/dependabot-merge.yml` merges a minor or patch package update by itself once every other check on its pull request has passed (it waits up to 85 minutes and leaves the pull request alone if a check fails). GitHub Actions updates and majors stay for a person: the workflow's built-in token can't merge changes to workflow files, and a major needs a decision. Merges by the workflow don't start CI on `main`; the weekly health check looks at `main`.

Some major versions are ignored on purpose: TypeScript (7.x is the native compiler; `@strapi/sdk-plugin` pins TypeScript 5.9.3 and its `vite-plugin-dts`/Volar need a TypeScript below 7, checked November 2026) and `@types/node` (the types must match the oldest Node version the plugin supports, not the newest). In Strapi also React, React DOM and their types, react-router-dom and react-intl: Strapi 5's admin provides React 18, react-router-dom 6 and react-intl 6 itself, so the plugin must match them. Minor and major updates of `@strapi/design-system` and `@strapi/icons` are ignored too: Strapi's admin pins both exactly (2.2.4 in Strapi 5.61.1, checked November 2026), and a newer one in the plugin would bundle a second design system (2.3 moved to Base UI). Lift an ignore rule when the plugin moves to the new version.

`overrides` in `package.json` and `demo/package.json` lift two packages Strapi pins exactly to their fixed versions (security advisories): `zod` 4.x to 4.6.7 or newer and `nodemailer` to 10.4 or newer. Remove them once Strapi ships those versions itself. Advisories that remain (November 2026) need a major Strapi doesn't take yet: `zod` 3 inside `koa-body`/`koa-session`, `stream-json` 1 and `glob` 13 (pinned by Strapi), `@hono/node-server` 1, `minimatch` below 11, `deepmerge` (no fixed version) and `react-router` 6 (Strapi 5's admin provides it).

## Code quality and security checks

- **Checks** workflow (`.github/workflows/checks.yml`): [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh/) lint the workflows on every push and pull request. Dependency review fails a pull request that adds a package with a known vulnerability (moderate or worse). Third-party actions are pinned to commit SHAs; Dependabot keeps the pins up to date. To run the workflow lint locally: `pip install actionlint-py zizmor`, then `actionlint` and `zizmor .github/workflows` in the repo root.
- **Links** workflow (`.github/workflows/links.yml`): [lychee](https://lychee.cli.rs/) checks the links in all Markdown files weekly and whenever docs change on `main`. Broken links open (or update) the issue "Broken links in the docs". Links that can't work from CI (local URLs, placeholders, pages behind a login) are excluded in `.lycheeignore`.
- JavaScript and TypeScript are analysed by CodeQL (see below), so this repo runs no separate static analyser.
- GitHub settings (set by Remy's setup script, not stored in the repo): **secret scanning with push protection** (a push containing a known token format is rejected; findings under *Security → Secret scanning*) and **CodeQL default setup** (findings under *Security → Code scanning* and as comments on pull requests; PHP isn't covered by CodeQL, which is why the PHP plugins run PHPStan).
- `.github/workflows/support-triage.yml`: support requests from the Supertext integrations website arrive as issues labelled `support` (contact details stay in the Supertext CMS). Claude classifies each one: answers questions (marked `<!-- supertext:reply -->`, emailed to the sender by the CMS) and closes them, fixes bugs as pull requests for review (never merged automatically), labels feature requests `feature-request`. Only people with triage rights can add labels, so outsiders can't start it. Needs the organisation secret `ANTHROPIC_API_KEY`; the workflow is the same in every Supertext repo.

Before starting work in this repo, look at its open findings: code scanning alerts, secret scanning alerts, Dependabot PRs and the "Broken links in the docs" issue.

## Releasing

Releases are published by `.github/workflows/release.yml` when the version is officially bumped; nobody tags or creates releases by hand.

1. Move the *Unreleased* entries in `CHANGELOG.md` under a new `## X.Y.Z — YYYY-MM-DD` section, and keep an empty *Unreleased* above it.
2. Set the same version in:
   - `package.json`: the npm package version
3. Push to `main`. The workflow checks that the version files match `CHANGELOG.md`, then tags `vX.Y.Z` and creates the GitHub release with the CHANGELOG section as notes (0.x versions as pre-releases). A push that adds no new version does nothing, and a version that is already released is skipped. After fixing a failed run, start it again with *Run workflow* on the *Release* workflow.

Publishing to npm stays manual: `npm publish` once the package name is registered.
## Known limitations / roadmap

- Translation runs inside the request; very large entries may hit proxy timeouts. Planned: background jobs with progress.
- Relations are not set on new translations.
- No bulk translation from the list view yet; translation files are one entry per export.
- No screenshots of the export and import sections yet (`npm run docs:screenshots` doesn't capture them).
- No automatic translation on save/publish yet.
- Human (professional) translation orders are not supported (the WordPress plugin has them).
- Not yet tested against the live Supertext API.
- Re-translating overwrites manual changes in the translated fields; no change detection. A translation memory and reviewers' corrections come from the review service when a locale has *Translation review* on; corrections reach Strapi only with the next translation (no push).
- The end-to-end test against the live Supertext API covers the demo's Article type (text, rich text, blocks, a component and a dynamic zone); other field combinations are covered by the unit tests only.
