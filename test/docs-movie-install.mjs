/**
 * Records the install and configuration movie (an MP4, no GIF) from a local demo against the stand-in API: the
 * install commands from docs/INSTALLATION.md in a terminal, then Settings → Supertext → Translation as the demo's
 * admin. See docs/DEVELOPER.md → Demo movie. The MP4 isn't committed: it goes to test/docs/movie/out/ (git-ignored)
 * or to MOVIE_OUT.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { MovieKit } from './docs/movie/movie-kit.mjs';

const EMAIL = process.env.DEMO_ADMIN_EMAIL || 'anna.muster@example.com';
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'Docs12345';
const B = process.env.STRAPI_URL || 'http://127.0.0.1:1337';
const HERE = new URL('./docs/movie/', import.meta.url).pathname;
const OUT = process.env.MOVIE_OUT || path.join(HERE, 'out', 'Strapi-Supertext-Translation-install.mp4');

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
// The demo talks to a local stand-in: show the endpoint users will see instead of its local address.
await page.addInitScript(() => {
  const fix = (root) => {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (/https?:\/\/(127\.0\.0\.1|localhost)[^\s]*/.test(n.nodeValue)) n.nodeValue = n.nodeValue.replace(/https?:\/\/(127\.0\.0\.1|localhost)[^\s]*/g, 'https://api.supertext.com/v1/');
    }
  };
  new MutationObserver(() => document.body && fix(document.body)).observe(document, { childList: true, subtree: true, characterData: true });
});

// Sign in as the demo's admin (not recorded): configuration is an admin task.
await page.goto(`${B}/admin/auth/login`);
await page.fill('input[name=email]', EMAIL);
await page.fill('input[name=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(/\/admin(\/)?$/, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
const login = await (await fetch(`${B}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
const list = await (await fetch(`${B}/content-manager/collection-types/api::article.article?locale=en`, { headers: { Authorization: `Bearer ${login.data.token}` } })).json();
const doc = list.results[0].documentId;
await page.goto('about:blank');

const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
const kit = await MovieKit.start(page, { workDir: path.join(HERE, 'work-install'), assets: path.join(HERE, 'assets') });
const term = (lines) => kit.terminal({ title: 'my-site', lines });
// Loads a page with the loading time cut out of the movie.
const open = async (url, ready) => {
  kit.pause();
  await page.goto(url);
  await ready.waitFor({ timeout: 60000 });
  for (const b of await page.getByRole('button', { name: /close/i }).all()) await b.click().catch(() => {});
  await page.waitForTimeout(1200);
  kit.resume();
};

// 1. The install commands from docs/INSTALLATION.md
await kit.say("The plugin isn't on npm yet. Clone it from GitHub, then install its dependencies, build it, and pack it.", {
  caption: 'Build the plugin from <b>GitHub</b> and pack it',
  during: () => term([
    { cmd: 'git clone https://github.com/Supertext/Strapi-Supertext-Translation.git' },
    { out: "Cloning into 'Strapi-Supertext-Translation'..." },
    { cmd: 'cd Strapi-Supertext-Translation' },
    { cmd: 'npm ci && npm run build && npm pack' },
    { out: 'added 1694 packages in 47s' },
    { out: '[INFO] Build complete!' },
    { out: 'strapi-plugin-supertext-translation-0.1.0.tgz', wait: 400 },
  ]),
});
await kit.say('Then switch to your Strapi project, and install the packed plugin from its tarball with npm install.', {
  caption: 'Install it in your Strapi project with <b>npm install</b>',
  during: () => term([
    { cmd: 'cd ../my-site' },
    { cmd: 'npm install ../Strapi-Supertext-Translation/strapi-plugin-supertext-translation-0.1.0.tgz' },
    { out: 'added 1 package in 4s', wait: 400 },
  ]),
});
await kit.say('Enable it in config, plugins dot j s, and read the API key from the environment.', {
  caption: 'Enable it in <b>config/plugins.js</b>',
  during: () => term([
    { cmd: 'cat config/plugins.js' },
    { out: 'module.exports = ({ env }) => ({' },
    { out: '  supertext: {' },
    { out: '    enabled: true,' },
    { out: '    config: {' },
    { out: "      apiKey: env('SUPERTEXT_API_KEY')," },
    { out: '    },' },
    { out: '  },' },
    { out: '});', wait: 400 },
  ]),
});
await kit.say('Generate your API key at supertext.com, under Integrations, API. No account yet? Create one at supertext.com. Then set the key in your environment.', {
  caption: 'Generate your API key at <b>supertext.com → Integrations → API</b>. No account yet? Create one at <b>supertext.com</b>',
  during: () => term([
    { cmd: 'echo "SUPERTEXT_API_KEY=st-demo-0000-0000-0000" >> .env', wait: 400 },
  ]),
});
await kit.say('Finally, rebuild the admin panel, and restart Strapi.', {
  caption: 'Rebuild and restart: <b>npm run build</b>, <b>npm run develop</b>',
  during: () => term([
    { cmd: 'npm run build' },
    { out: '✔ Compiling TS (1405ms)' },
    { out: '✔ Building build context (79ms)' },
    { out: '✔ Building admin panel (29.8s)' },
    { cmd: 'npm run develop' },
    { out: 'Strapi started successfully', wait: 400 },
  ]),
});

// 2. Strapi's locales are the languages Supertext translates into
await open(`${B}/admin/settings/internationalization`, page.getByText('German (Switzerland)').first());
await kit.say("Signed in as an administrator: the languages are Strapi's own locales, under Settings, Internationalization.", {
  caption: "Languages are Strapi's locales: <b>Settings → Internationalization</b>",
  during: () => kit.moveTo(page.getByText('German (Switzerland)').first()),
});

// 3. The plugin's settings
const menu = page.getByRole('link', { name: 'Translation', exact: true });
await kit.say('Open Settings, Supertext, Translation.', {
  caption: 'Open <b>Settings → Supertext → Translation</b>',
  during: async () => { await kit.click(menu); kit.pause(); await page.getByText('API key is set.').waitFor({ timeout: 30000 }); await page.waitForTimeout(800); kit.resume(); },
});
await kit.say('The page shows that the API key is set.', {
  caption: 'The API key is set',
  during: () => kit.moveTo(page.getByText('API key is set.')),
});

// 4. The key check
const test = page.getByRole('button', { name: 'Test connection' });
await kit.say('Click Test connection to check the key.', {
  caption: 'Click <b>Test connection</b>',
  during: async () => { await kit.click(test); await page.getByText('API key checked: the connection to Supertext works.').waitFor({ timeout: 30000 }); },
});
await kit.say('The connection to Supertext works.', {
  caption: 'API key checked: <b>the connection to Supertext works</b>',
  during: () => kit.moveTo(page.getByText('API key checked: the connection to Supertext works.')),
});

// 5. The language mapping
const german = page.getByRole('combobox', { name: 'Supertext language for German (Switzerland) (de-CH)' });
await kit.say('Under Languages, each Strapi locale has its Supertext language.', {
  caption: '<b>Languages</b>: a Supertext language for each locale',
  during: async () => { await center(german); await page.waitForTimeout(800); await center(german); await page.waitForTimeout(200); await kit.moveTo(german); },
});
await kit.say('Open the list for German, and pick German, Switzerland.', {
  caption: 'Pick <b>German (Switzerland) (de-CH)</b>',
  during: async () => {
    await kit.click(german);
    const option = page.getByRole('option', { name: 'German (Switzerland) (de-CH)' });
    await option.waitFor();
    await option.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
    await kit.hold(500);
    await kit.click(option);
  },
});
const review = page.getByRole('checkbox', { name: 'Translation review for German (Switzerland) (de-CH)' });
await kit.say('Translation review can be ticked per language. Leave it off for now.', {
  caption: '<b>Translation review</b> can be ticked per language',
  during: () => kit.moveTo(review),
});
const save = page.getByRole('button', { name: 'Save' });
await kit.say('Click Save.', {
  caption: 'Click <b>Save</b>',
  during: async () => { await center(save); await kit.click(save); },
  after: 700,
});

// 6. Where editors find it
const translate = page.getByRole('button', { name: 'Translate with Supertext' });
await open(`${B}/admin/content-manager/collection-types/api::article.article/${doc}?plugins[i18n][locale]=en`, translate);
await kit.say('Editors now find Translate with Supertext in the panel next to every entry.', {
  caption: 'Editors find <b>Translate with Supertext</b> next to every entry',
  during: async () => { await center(translate); await kit.moveTo(translate); },
  after: 500,
});

await kit.finish(OUT, { system: 'Strapi', repo: 'Strapi-Supertext-Translation', kind: 'install' });
await browser.close();
console.log('movie', OUT);
