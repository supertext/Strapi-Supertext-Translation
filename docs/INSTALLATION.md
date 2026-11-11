# Installation guide — Supertext Translation for Strapi

For administrators setting up the plugin in a Strapi project.

## Requirements

| | |
| --- | --- |
| Strapi | 5.56 or newer (tested with 5.61) |
| Node.js | 22 or newer (26, the current LTS version, recommended; tested with 22, 24 and 26). Node.js 20 is no longer supported (end of life since 30 April 2026). |
| Database | Any database Strapi supports (tested with SQLite; the demo runs on PostgreSQL) |
| Strapi i18n | Enabled for every content type you want to translate (*Content-Type Builder → Advanced settings → Internationalization*), with the target languages added under *Settings → Internationalization* |
| Supertext | An account with an API key — see [Get a Supertext account and API key](#get-a-supertext-account-and-api-key) |
| Network | The Strapi server must reach `https://api.supertext.com` over HTTPS (and, for [Translation review](#translation-review), Supertext's review service) |

The languages Supertext translates into are Strapi's own locales:

![Settings → Internationalization with English as default and German, French and Italian (Switzerland)](images/locales.png)

Each Strapi locale needs a Supertext language. Supertext accepts exactly these target codes (from its `features` list, October 2026):

| Language | Supertext codes |
| --- | --- |
| German, English, French, Italian, Portuguese | `de-DE`, `de-CH`, `de-AT`, `en-US`, `en-GB`, `fr-FR`, `fr-CH`, `it-IT`, `it-CH`, `pt-PT`, `pt-BR` |
| Chinese, Serbian | `zh-Hans`, `zh-Hant`, `sr-Latn`, `sr-Cyrl` |
| Swiss German | `gsw-u-sd-chzh` (Zurich), `gsw-u-sd-chbe` (Bern) |
| All others, without region | `bg`, `cs`, `da`, `el`, `es`, `fi`, `hr`, `hu`, `ja`, `ko`, `nb`, `nl`, `pl`, `rm`, `ru`, `sk`, `sl`, `sq`, `sv`, `tr` |

You choose the Supertext language of each Strapi locale under **Settings → Supertext → Translation → Languages**: one combo box per locale, listing exactly these codes. One choice serves both directions: with `en` → `English (United States) (en-US)`, English is translated into `en-US` and from `en` (sources are sent without region).

![Settings → Supertext → Translation → Languages: one combo box per Strapi locale with its Supertext language, Formal/Informal where Supertext offers it, and a Translation review checkbox per locale, not ticked](images/settings-languages.png)

Each combo box starts with the saved choice, else a suggestion, and a locale nobody chose is translated with that suggestion:

1. A Strapi locale that **is** one of these codes (apart from upper/lower case and `_`/`-`) is used as it is: `de-CH`, `fr_ch` → `fr-CH`, `es`.
2. Otherwise the default where the language is obvious:

   | Strapi locale | Default |
   | --- | --- |
   | `de`, `en`, `fr`, `it`, `pt` | `de-DE`, `en-US`, `fr-FR`, `it-IT`, `pt-PT` |
   | `zh`, `zh-CN`, `zh-SG` / `zh-TW`, `zh-HK`, `zh-MO` | `zh-Hans` / `zh-Hant` |
   | `sr` | `sr-Latn` |
   | a region of a language Supertext has without region (`es-ES`, `nl-NL`, `sl-SI`, `ja-JP` …) | the bare code (`es`, `nl`, `sl`, `ja`) |

3. Anything else (for example `en-IE`, `de-LI`, `gsw`, `sr-RS`) shows an empty **— choose —** combo box marked in red. Until you choose a language, translating into or from it fails with *has no Supertext language yet* and nothing is sent.

Choose a different language where the default isn't what you want (for example `de` → `de-CH` for a Swiss site) and click **Save**. Saving needs the permission *Settings → Supertext → Update* (see [Permissions](#permissions)). The choices are stored in Strapi's database (core store, key `plugin_supertext_languages`).

- **Politeness:** next to each locale whose language offers it, *Formal* (Sie, vous, Lei) or *Informal* (du, tu); *Default* leaves it to Supertext. English, Swiss German, Romansh, Albanian and Serbian have none.
- **Translation review:** a checkbox per locale, off by default; see [Translation review](#translation-review).
- **Override for automated setups:** `code`, `politeness` and `review` under `locales` in `config/plugins` (see [All settings](#all-settings)) win over the page, per locale and per field. The page shows that locale's value read-only with *Set in config/plugins*. Installations that mapped their locales there before keep working unchanged; to manage a locale on the page instead, remove its entry from `config/plugins` and restart.

### Get a Supertext account and API key

1. **Account:** no Supertext account yet? [Log in or create a Supertext account](https://www.supertext.com/person/en/account/signin) with your email address.
2. **API key:** generate the AI API key at [supertext.com → Integrations → API](https://www.supertext.com/en/integrations/api). This page requires the **Admin** role in your Supertext account; if you don't have it, ask an admin of your Supertext account to generate the key.

The plugin's settings page (*Settings → Supertext → Translation*) shows the same two links.

## 1. Install the package

The plugin isn't on npm yet. Build it from GitHub and install the tarball:

```bash
git clone https://github.com/Supertext/Strapi-Supertext-Translation.git
cd Strapi-Supertext-Translation
npm ci && npm run build && npm pack
# → strapi-plugin-supertext-translation-<version>.tgz

cd /path/to/your-strapi-project
npm install /path/to/strapi-plugin-supertext-translation-<version>.tgz
```

Once it's published to npm this becomes `npm install strapi-plugin-supertext-translation`.

## 2. Enable and configure it

In `config/plugins.js` (or `.ts`):

```js
module.exports = ({ env }) => ({
  supertext: {
    enabled: true,
    config: {
      apiKey: env('SUPERTEXT_API_KEY'),
      // Optional: the language mapping is normally chosen under Settings → Supertext → Translation.
      // Entries here override that page per locale (for automated setups).
      // locales: {
      //   'de': { code: 'de-CH', politeness: 'more' },   // Strapi's "de" → Swiss German, formal (Sie)
      //   'pt': { code: 'pt-BR' },                       // Strapi's "pt" → Brazilian Portuguese
      //   'fr-CH': { review: true },                     // Translation review for French (Switzerland)
      // },
      // reviewUrl: '',                    // turns Translation review off for every locale
      // versionReports: false,            // see "Version information and the API key check"
    },
  },
});
```

Set the key as an environment variable on the server, for example in `.env`:

```bash
SUPERTEXT_API_KEY=your-key
```

Never commit the key to the repository.

## 3. Rebuild and restart

```bash
npm run build
npm run start      # or: npm run develop
```

A new **Supertext translation** panel now appears in the right-hand column of every localized entry in the Content Manager, and **Settings → Supertext → Translation** shows the connection, the language combo boxes and the installed plugin version (for example *Plugin version: 0.1.0*, linked to that release's notes on GitHub). Mention the version when you contact support.

![Settings → Supertext → Translation: connection status, links to create a Supertext account and generate an API key, the latest API key check, the endpoint, the plugin version and whether version information is sent](images/settings.png)

## 4. Check it works

1. Open *Settings → Supertext → Translation* and click **Test connection**. You should see *API key checked: the connection to Supertext works.* Under *Languages*, check the Supertext language of each locale (no combo box marked *— choose —*) and click **Save**.
2. Open any saved entry of a localized content type, tick a locale in the Supertext panel and click **Translate with Supertext**.

## All settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `apiKey` | `SUPERTEXT_API_KEY` env var | Supertext API key, with or without the `Supertext-Auth-Key ` prefix |
| `endpoint` | `SUPERTEXT_API_ENDPOINT` env var, else `https://api.supertext.com/v1/` | API base URL (`https://api.staging.supertext.com/v1/` for staging). For [Translation review](#translation-review) use the locales' checkbox instead. |
| `reviewUrl` | `SUPERTEXT_REVIEW_URL` env var, else Supertext's review service (`https://localizationreview-production.up.railway.app/v1/`) | Address of the review service for locales with *Translation review* on. `''` turns review off for every locale. Only change it when Supertext gives you another address. |
| `locales` | `{}` | Optional override of the language combo boxes under *Settings → Supertext → Translation*, per Strapi locale: `code` (the Supertext code to send, e.g. `de-CH`, `pt-BR`, `es`, see [the list above](#requirements)) `politeness` (`more` = formal, `less` = informal, `default`; only for targets that offer it) and `review` (`true`/`false`, [Translation review](#translation-review)). Each field set here wins over the page. |
| `contentTypes` | `[]` (all localized types) | Allow-list of content-type UIDs, e.g. `['api::article.article']` |
| `pollIntervalMs` | `2000` | Time between status checks |
| `pollTimeoutMs` | `180000` | Maximum wait per translation |
| `versionReports` | `true` | *Send version information to Supertext* (see below). `SUPERTEXT_VERSION_REPORTS=0` (or `false`, `off`, `no`) turns it off too and wins over this option. |

## Version information and the API key check

**Send version information to Supertext** is on by default. The plugin then sends the site URL and the versions of this plugin, Strapi and Node.js to Supertext after an update and when the API key changes, so Supertext support can see which version you run. A report contains exactly: the site URL (Strapi's `server.url` if it is an absolute URL, else the address the admin request came in on), the plugin's name (`Strapi-Supertext-Translation`) and version, the Strapi and Node.js versions, the Supertext SDK version, whether a key is set, the result of the API key check below (status, time, HTTP status, Supertext's error code) and the address of the ping endpoint. **No content, no API key and no personal data are sent.** Reports go from the Strapi server, never from the browser; a report that fails is not retried for an hour and never slows down or breaks a translation. To turn it off, set `versionReports: false` in the plugin's config or `SUPERTEXT_VERSION_REPORTS=0` in the environment and restart Strapi: nothing is sent at all then, and the ping endpoint answers 404. The settings page shows whether it is on.

**The API key check** runs whether or not version information is sent: when the plugin's admin code first runs with a key it hasn't checked yet (the key is compared by a fingerprint kept in Strapi's database, never the key itself), on **Test connection**, and when Supertext rejects the key during a translation. It's Supertext's cost-free `features` call; nothing is translated or billed. The settings page shows the latest result with its time: *the connection works*, *Supertext rejected the API key* (with the links to create an account and generate a key), *no API key is set*, *Supertext can't be reached* or *Supertext answered with an error*.

**The ping endpoint** `GET <server URL>/api/supertext/ping?challenge=…` (below Strapi's REST prefix, `api.rest.prefix`) is public (no login) and answers only `{"ok":true,"plugin":"Strapi-Supertext-Translation","challenge":"…"}` with `Cache-Control: no-store`, so Supertext can see that the site is reachable from the internet. It returns nothing else: no versions, no settings, no data. If a reverse proxy or firewall in front of Strapi only lets the admin through, allow this path too.

The plugin keeps this state (what was reported last, the latest key check) in Strapi's core store (`strapi_core_store_settings`, key `plugin_supertext_reporter`).

## Interface languages

The plugin's panel, settings page and messages are available in English, German, French and Italian and follow each user's Strapi interface language. Strapi only offers the interface languages the project lists in `src/admin/app.ts` (or `app.js`); English is always available:

```js
// src/admin/app.js
export default {
  config: {
    locales: ['de', 'fr', 'it'],
  },
};
```

Rebuild the admin panel (`npm run build`), then each user picks a language under their profile (top left → *Profile* → *Interface language*). The interface language is independent of the content locales under *Settings → Internationalization*. Messages from the server that reach other API clients stay in English.

## Permissions

The plugin follows the Content Manager's permissions: a user can translate an entry only if they may **read** its source locale and **create or update** each target locale. Use *Settings → Roles* to limit editors to certain locales as usual.

The settings page has its own permissions under *Settings → Administration panel → Roles → (role) → Settings → Supertext*: **Read** opens *Settings → Supertext → Translation* (and **Test connection**), **Update** saves the language combo boxes. Super Admins have both; give them to other roles as needed.

## Translation review

With **Translation review**, people check the translations on the website itself and correct them there: customers or Supertext linguists open the original and the translated page side by side in Chrome with the *Supertext Localization Review* extension and fix texts in a side panel. Their corrections come back into Strapi.

Turn it on per language for the locale that is translated **into**: **Settings → Supertext → Translation → Languages** → tick **Translation review** in that locale's row → **Save** (permission *Settings → Supertext → Update*). Untick it to turn it off again; nothing else changes. For automated setups, `review: true` under `locales.<locale>` in `config/plugins` does the same and wins over the checkbox.

- Translations into that locale then go through Supertext's review service instead of directly to Supertext. It answers exactly like Supertext and passes everything on with your API key, so billing, languages, formal/informal and error messages stay the same. Other locales keep going directly to Supertext.
- The review service keeps every translation of your account. A text it has translated before gets the same translation again (without a new Supertext call), and once a reviewer has corrected it, the corrected text.
- **Corrections arrive with the next translation:** after a review, translate the entries again (*Translate with Supertext*) to write the corrections into Strapi. As always, translating again overwrites manual changes in the translated fields.
- Reviewers get a review link for your site from Supertext; nothing to set up in Strapi.
- The review service works with keys of the **live** Supertext API. With a staging `endpoint`, leave review off.
- *Export for translation* and *Import translation* don't use the review service. The automatic API key check (and **Test connection**) still goes directly to Supertext.
- `reviewUrl: ''` turns review off for every locale; the checkboxes are then greyed out.

## Translation files (export and import)

Editors can export an entry as an XLIFF 1.2 or HTML file from the Supertext panel (*Export for translation*), have it translated anywhere, and import the translated file (*Import translation*); see the [user guide](USER_GUIDE.md#export-for-translation-and-import-a-translated-file). There is nothing to configure, and it works without an API key:

- **Permissions:** the same as translating: read the source locale and create or update the target locale (Content Manager permissions); the content type must be localized and, if you set `contentTypes`, listed there.
- **Uploads:** at most 10 MB, refused before the file is read. Strapi's body parser (`strapi::body`, multipart) stores the upload in a temporary file; the plugin reads it into memory and deletes it right away. Only files exported by this plugin are accepted, and translations may only use the formatting of the current source.

## Updating

Install the newer tarball (or `npm update strapi-plugin-supertext-translation` once on npm), then `npm run build` and restart. The version on the settings page shows which one is running.

## Uninstalling

Remove the `supertext` block from `config/plugins`, run `npm uninstall strapi-plugin-supertext-translation`, rebuild and restart. Existing translations stay as they are.

## Troubleshooting

| Message | Cause / fix |
| --- | --- |
| *Too many requests to Supertext* | The API's per-second limit was still exceeded after 4 automatic retries. Wait a moment and translate again. |
| *Supertext is not configured yet* / *No API key* | Set `SUPERTEXT_API_KEY` (or `config.apiKey`) and restart Strapi. No key yet? See [Get a Supertext account and API key](#get-a-supertext-account-and-api-key). |
| *Authentication failed* / *Supertext rejected the API key* on the settings page | The key is wrong or revoked. Check that the whole key was copied into `SUPERTEXT_API_KEY`, or generate a new one at [supertext.com → Integrations → API](https://www.supertext.com/en/integrations/api) (requires the Admin role). No Supertext account yet? [Create one](https://www.supertext.com/person/en/account/signin). Restart Strapi, then **Test connection**. |
| *The API key couldn't be checked because Supertext can't be reached* | The Strapi server can't reach `api.supertext.com` (firewall, proxy, DNS). Translations need the same connection. |
| *The language … has no Supertext language yet* / a red *— choose —* on the settings page | The Strapi locale has no default (e.g. `en-IE`, `de-LI`, `gsw`): choose its language under *Settings → Supertext → Translation → Languages* and click **Save**. |
| *Supertext does not support this language pair* | A `code` in `config/plugins` Supertext doesn't offer (e.g. `es-ES` instead of `es`), or source and target are the same language; fix the `code` or the choice on the settings page. The message shows the codes that were sent. |
| *The language settings could not be saved* | A value Supertext doesn't offer was sent (for example from an old browser tab); reload the page and save again. |
| *Supertext offers no formal or informal tone for the language …* | `politeness` in `config/plugins` is `more`/`less` for a target without it (English, Swiss German, Romansh, Albanian, Serbian); remove it or set `default`. The settings page marks it. |
| *This content type is not localized* | Enable internationalization for the content type in the Content-Type Builder. |
| *not enabled for this content type* | The type isn't in `contentTypes`. |
| *No … version of this entry found. Save it first.* | The entry hasn't been saved in the source locale yet. |
| *Timed out waiting* | Very large entries; raise `pollTimeoutMs`. If Strapi runs behind a proxy, also raise its request timeout. |
| *Could not reach Supertext* | The server can't make outbound HTTPS calls; check firewall/proxy settings. With *Translation review* on, the server must also reach Supertext's review service. |
| *Authentication failed* only for locales with *Translation review* | The review service only works with keys of the live Supertext API: with a staging `endpoint`, leave review off. |
| Reviewers' corrections don't show up in Strapi | They arrive with the next translation: translate the entries into that locale again. Check that the locale's *Translation review* is ticked (and not set to `false` in `config/plugins`). |
| The panel doesn't appear | The entry is new (save it first), the content type isn't localized, or the admin panel wasn't rebuilt after installing. |

Errors are also written to the Strapi server log with the prefix `[supertext]`.
