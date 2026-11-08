/**
 * Records the demo movie (docs/images/demo.gif and an MP4) from a local demo against the stand-in API.
 * See docs/DEVELOPER.md → Demo movie. The MP4 isn't committed: it goes to test/docs/movie/out/ (git-ignored)
 * or to MOVIE_OUT.
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { MovieKit } from './docs/movie/movie-kit.mjs';

const EMAIL = process.env.DEMO_EDITOR_EMAIL || 'eddie.editor@example.com';
const PASSWORD = process.env.DEMO_EDITOR_PASSWORD || 'Docs12345';
const B = process.env.STRAPI_URL || 'http://127.0.0.1:1337';
const HERE = new URL('./docs/movie/', import.meta.url).pathname;
const OUT = process.env.MOVIE_OUT || path.join(HERE, 'out', 'Strapi-Supertext-Translation.mp4');
const GIF = new URL('../docs/images/demo.gif', import.meta.url).pathname;

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

// Sign in as the demo's editor (not recorded).
await page.goto(`${B}/admin/auth/login`);
await page.fill('input[name=email]', EMAIL);
await page.fill('input[name=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForURL(/\/admin(\/)?$/, { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
const login = await (await fetch(`${B}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
const list = await (await fetch(`${B}/content-manager/collection-types/api::article.article?locale=en`, { headers: { Authorization: `Bearer ${login.data.token}` } })).json();
const doc = list.results[0].documentId;
await page.goto(`${B}/admin/content-manager/collection-types/api::article.article/${doc}?plugins[i18n][locale]=en`);
await page.getByText('Supertext translation').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);

const center = (locator) => locator.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
const kit = await MovieKit.start(page, { workDir: path.join(HERE, 'work'), assets: path.join(HERE, 'assets') });

// 1. The entry in the source language
await kit.say("Here's an article in English.", { caption: 'An article in English' });

// 2. The Supertext panel: pick the languages and translate
const german = page.getByRole('checkbox', { name: /German/ });
const french = page.getByRole('checkbox', { name: /French/ });
const translate = page.getByRole('button', { name: 'Translate with Supertext' });
await kit.say('In the Supertext panel, tick German and French.', {
  caption: 'In the Supertext panel, tick <b>German</b> and <b>French</b>',
  during: async () => { await center(translate); await kit.moveTo(german); await kit.click(german); await kit.click(french); },
});
await kit.say('Then click Translate with Supertext.', {
  caption: 'Click <b>Translate with Supertext</b>',
  during: async () => { await kit.moveTo(translate); await kit.hold(500); await kit.click(translate); },
});

// 3. Waiting: a moment of the progress state, then cut until it's done
await kit.say('Supertext translates the content.', { caption: 'Supertext translates the content…' });
kit.pause();
await page.getByText(/created \(/).first().waitFor({ timeout: 120000 });
await page.waitForTimeout(500);
kit.resume();
await kit.say('A few seconds later, both translations are saved as drafts.', { caption: 'Both translations are saved as drafts' });

// 4. The German version, opened the way an editor checks it
const open = page.getByRole('button', { name: 'Open' }).first();
await kit.say("Click Open to check the German version.", {
  caption: 'Click <b>Open</b> to check the German version',
  during: () => kit.moveTo(open),
  after: 0,
});
// The cursor is already on Open: click right away (no second move), then cut the loading.
await page.evaluate(([x, y]) => window.__stk?.ripple(x, y), [kit.cursor.x, kit.cursor.y]);
await open.click();
await page.waitForTimeout(250);
kit.pause(); // loading the German entry is cut
await page.getByText('Schweizer Schokolade, weltweit geliefert').first().waitFor({ timeout: 30000 });
for (const b of await page.getByRole('button', { name: /close/i }).all()) await b.click().catch(() => {});
await page.waitForTimeout(1500);
// Back to the top of the German entry; the cursor rests on its title.
await page.evaluate(() => { window.scrollTo(0, 0); for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0; });
await page.waitForTimeout(400);
kit.resume();
await kit.say('Here is the German version. Review it, and publish it as usual.', {
  caption: 'The German version is ready – review it and publish',
  during: () => kit.moveTo(page.getByRole('heading', { name: /Schweizer Schokolade/ }).first()),
  after: 500,
});

await kit.finish(OUT, { system: 'Strapi', repo: 'Strapi-Supertext-Translation', gif: GIF });
await browser.close();
console.log('movie', OUT, 'gif', GIF);
