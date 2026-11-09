/**
 * Regenerates the screenshots in docs/images from a local demo. See docs/DEVELOPER.md → Docs screenshots.
 */
import { chromium } from 'playwright';
const EMAIL = process.env.DEMO_ADMIN_EMAIL || 'anna.muster@example.com';
const PASSWORD = process.env.DEMO_ADMIN_PASSWORD || 'Docs12345';
const B = process.env.STRAPI_URL || 'http://127.0.0.1:1337';
const OUT = new URL('../docs/images', import.meta.url).pathname;
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1400, height: 940 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
const shot = (name, opts = {}) => page.screenshot({ path: `${OUT}/${name}.png`, ...opts });
const closeBanner = async () => { const x = page.locator('button[aria-label="Close"], button:has-text("×")').first(); if (await x.isVisible().catch(() => false)) await x.click().catch(() => {}); };

await page.goto(`${B}/admin/auth/login`);
await page.fill('input[name=email]', EMAIL);
await page.fill('input[name=password]', PASSWORD);
await page.click('button[type=submit]');
await page.waitForTimeout(4000);
await page.getByRole('button', { name: /skip|close|not now/i }).first().click({ timeout: 2000 }).catch(() => {});
await page.keyboard.press('Escape').catch(() => {});

// Installation guide: settings page + locales
await page.goto(`${B}/admin/settings/supertext`);
await page.getByText('Connection').first().waitFor({ timeout: 30000 });
// Show the API key check (the stand-in answers GET features like Supertext).
await page.getByRole('button', { name: 'Test connection' }).click();
await page.getByText('API key checked: the connection to Supertext works.').waitFor({ timeout: 30000 });
await page.waitForTimeout(800);
// Show the endpoint users will see (the screenshot run uses a local stand-in).
await page.getByText(/Endpoint:/).evaluate((el) => (el.textContent = 'Endpoint: https://api.supertext.com/v1/'));
// A fixed time for the key check, so the image only changes when the page does (CI regenerates it).
await page.getByText(/^Last checked:/).evaluate((el) => (el.textContent = 'Last checked: 10/14/2026, 12:01:04 AM'));
// The settings page scrolls inside Strapi's layout: a taller window shows all of it.
await page.setViewportSize({ width: 1400, height: 1240 });
await page.waitForTimeout(500);
await shot('settings', { clip: { x: 0, y: 0, width: 1400, height: 1030 } });
// The language combo boxes: clip to the Languages card, one select opened would hide the rows.
const languagesCard = page.getByRole('heading', { name: 'Languages' }).locator('xpath=ancestor::div[contains(@class, "") and .//table][1]');
await languagesCard.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await languagesCard.screenshot({ path: `${OUT}/settings-languages.png` });
await page.setViewportSize({ width: 1400, height: 940 });
await page.goto(`${B}/admin/settings/internationalization`);
await page.waitForTimeout(2500);
await shot('locales');

// User guide
const login = await (await fetch(`${B}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
const list = await (await fetch(`${B}/content-manager/collection-types/api::article.article?locale=en`, { headers: { Authorization: `Bearer ${login.data.token}` } })).json();
const doc = list.results[0].documentId;
await page.goto(`${B}/admin/content-manager/collection-types/api::article.article/${doc}?plugins[i18n][locale]=en`);
await page.getByText('Supertext translation').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
await shot('edit-view');
// Clip to the Supertext panel's card.
const box = async () => page.evaluate(() => {
  const label = [...document.querySelectorAll('*')].find((el) => el.childElementCount === 0 && /^Supertext translation$/i.test(el.textContent.trim()));
  let card = label;
  while (card && card.getBoundingClientRect().height < 150) card = card.parentElement;
  const r = card.getBoundingClientRect();
  return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 };
});
await page.getByRole('checkbox', { name: /German/ }).click();
await page.waitForTimeout(300);
await shot('panel-select', { clip: await box() });
await page.getByRole('button', { name: 'Translate with Supertext' }).click();
await page.getByText(/created \(/).first().waitFor({ timeout: 30000 });
await page.waitForTimeout(400);
await shot('panel-done', { clip: await box() });
await page.getByRole('button', { name: 'Open' }).first().click();
await page.waitForTimeout(1000);
for (const b of await page.getByRole('button', { name: /close/i }).all()) await b.click().catch(() => {});
await page.waitForTimeout(6000);
await shot('translated-de');
// back to English: overwrite warning
await page.goto(`${B}/admin/content-manager/collection-types/api::article.article/${doc}?plugins[i18n][locale]=en`);
await page.getByText('Supertext translation').first().waitFor({ timeout: 30000 });
await page.waitForTimeout(1500);
await page.getByRole('checkbox', { name: /German/ }).click();
await page.waitForTimeout(300);
await shot('panel-overwrite', { clip: await box() });
await browser.close();
console.log('done', doc);
