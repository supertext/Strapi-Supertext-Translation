#!/usr/bin/env node
/**
 * End-to-end test against the REAL Supertext API: a fresh demo (nothing translated yet)
 * with a real SUPERTEXT_API_KEY. The editor translates every English article into every
 * other locale with the Supertext panel in the Content Manager's edit view, then each
 * translation is read back through Strapi's Content Manager API and checked: one copy per
 * locale, left as a draft, fields filled and changed, no protocol leftovers, bold, italics,
 * links, headings, list items and Markdown kept, really in the target language (de-CH
 * without "ß"), and translating again replaces the same entries instead of adding new ones.
 * See "End-to-end tests" in docs/DEVELOPER.md.
 *
 *   STRAPI_URL=http://127.0.0.1:8081 EDITOR_EMAIL=… EDITOR_PASSWORD=… node test/e2e/live.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const B = (process.env.STRAPI_URL ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
const need = (name) => process.env[name] || (() => { throw new Error(`Set ${name}`); })();
const artifacts = fileURLToPath(new URL('./artifacts/', import.meta.url));
mkdirSync(artifacts, { recursive: true });

const MODEL = 'api::article.article';
const SOURCE = 'en';

const failures = [];
function check(name, ok, detail = '') {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
	if (!ok) failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
	return ok;
}
const note = (text) => console.log(`note ${text}`);

// Common words, to tell the target languages apart. Lower case, whole words.
const STOPWORDS = {
	en: ['the', 'and', 'is', 'are', 'with', 'for', 'you', 'your', 'our', 'of', 'to', 'we', 'who', 'what'],
	de: ['der', 'die', 'das', 'und', 'ist', 'sind', 'mit', 'für', 'sie', 'ihre', 'ihr', 'unser', 'unsere', 'wir', 'eine', 'ein', 'den', 'zu', 'von', 'was'],
	fr: ['le', 'les', 'et', 'est', 'sont', 'avec', 'pour', 'vous', 'votre', 'vos', 'notre', 'nos', 'nous', 'des', 'une', 'un', 'du', 'de', 'qui', 'que'],
	it: ['il', 'lo', 'gli', 'e', 'è', 'sono', 'con', 'per', 'lei', 'sua', 'suo', 'nostro', 'nostra', 'noi', 'una', 'un', 'del', 'della', 'di', 'che', 'chi'],
};
const words = (text) => text.toLowerCase().match(/[\p{L}]+/gu) ?? [];
const score = (text, lang) => words(text).filter((w) => STOPWORDS[lang].includes(w)).length;
const count = (haystack, needle) => String(haystack ?? '').split(needle).length - 1;
const LEFTOVERS = ['data-st-id', 'data-st-ph', 'st-ph-', '<div', '</div>'];

// --- Strapi's admin API (what the admin panel itself uses) ----------------------------------
let token = '';
async function api(path, init = {}) {
	const res = await fetch(`${B}${path}`, {
		...init,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
	});
	const body = await res.json().catch(() => ({}));
	return { status: res.status, body };
}
const login = await api('/admin/login', { method: 'POST', body: JSON.stringify({ email: need('EDITOR_EMAIL'), password: need('EDITOR_PASSWORD') }) });
if (!check('editor can log in (DEMO_EDITOR_*)', login.status === 200 && login.body?.data?.token, `HTTP ${login.status}`)) {
	throw new Error(failures.join('\n'));
}
token = login.body.data.token;

/** One locale of a document as the edit view loads it (components and dynamic zones populated). */
async function entry(documentId, locale) {
	const { status, body } = await api(`/content-manager/collection-types/${MODEL}/${documentId}?locale=${encodeURIComponent(locale)}`);
	return status === 200 && body?.data?.locale === locale ? body : null;
}
async function listIn(locale) {
	const { body } = await api(`/content-manager/collection-types/${MODEL}?locale=${encodeURIComponent(locale)}&page=1&pageSize=100`);
	return body?.results ?? [];
}

// --- Fields ------------------------------------------------------------------------------------
/** Keys that are no translatable text (ids, dates, generated slugs, media, users). */
const SKIP = new Set(['id', 'documentId', 'locale', 'slug', 'status', 'createdAt', 'updatedAt', 'publishedAt', '__component', 'createdBy', 'updatedBy', 'localizations', 'cover', 'image', 'url', 'type', 'format', 'level']);
const isBlocks = (v) => Array.isArray(v) && v.length > 0 && v.every((b) => b && typeof b === 'object' && typeof b.type === 'string' && Array.isArray(b.children));
const blockText = (n) => (typeof n.text === 'string' ? n.text : (n.children ?? []).map(blockText).join(''));
function nodes(n, out = []) {
	out.push(n);
	for (const c of n.children ?? []) nodes(c, out);
	return out;
}

/** Translatable texts of an entry by path: plain strings, and each top-level block of a blocks field. */
function texts(value, path = '', out = new Map()) {
	if (typeof value === 'string') {
		if (value.trim() && !/^[\d\s.,:-]+$/.test(value)) out.set(path, { kind: 'text', value });
	} else if (isBlocks(value)) {
		value.forEach((block, i) => {
			if (block.type !== 'code' && blockText(block).trim()) out.set(`${path}[${i}]`, { kind: 'block', value: blockText(block), block });
		});
	} else if (Array.isArray(value)) {
		value.forEach((v, i) => texts(v, `${path}[${i}]`, out));
	} else if (value && typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) if (!SKIP.has(k)) texts(v, path ? `${path}.${k}` : k, out);
	}
	return out;
}

/** Formatting that must survive, per field: inline marks, links, list items, headings, Markdown. */
function formatting(field) {
	if (field.kind === 'block') {
		const all = nodes(field.block);
		return {
			bold: all.filter((n) => n.bold).length,
			italics: all.filter((n) => n.italic).length,
			underline: all.filter((n) => n.underline).length,
			links: all.filter((n) => n.type === 'link').length,
			'link targets': all.filter((n) => n.type === 'link').map((n) => n.url).sort().join(' '),
			'list items': all.filter((n) => n.type === 'list-item').length,
			[`block type ${field.block.type}`]: 1,
		};
	}
	const v = field.value;
	return {
		'Markdown bold': count(v, '**'),
		'Markdown list items': (v.match(/^\s*[-*] /gm) ?? []).length,
		'Markdown links': (v.match(/\]\(/g) ?? []).length,
		'line breaks': count(v, '\n'),
	};
}

// --- Setup -------------------------------------------------------------------------------------
const { body: localeList } = await api('/i18n/locales');
const locales = Array.isArray(localeList) ? localeList : [];
const targets = locales.filter((l) => l.code !== SOURCE);
const sources = await listIn(SOURCE);
console.log(`English articles: ${sources.length}; target locales: ${targets.map((t) => t.code).join(', ')}`);
check('demo has an English article', sources.length > 0);
check('demo has target locales', targets.length > 0);
const source = new Map();
for (const s of sources) source.set(s.documentId, await entry(s.documentId, SOURCE));
for (const [doc, s] of source) {
	const existing = (s?.meta?.availableLocales ?? []).map((l) => l.locale).filter((l) => l !== SOURCE);
	check(`fresh demo: article ${doc} not translated yet`, existing.length === 0, existing.join(', '));
}
if (failures.length) throw new Error(failures.join('\n'));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, locale: 'en-US' });
page.setDefaultTimeout(30_000);
page.on('pageerror', (e) => console.log(`page error: ${e.message}`));

// --- Log in as the editor in the admin panel -------------------------------------------------
await page.goto(`${B}/admin/auth/login`);
await page.fill('input[name=email]', need('EDITOR_EMAIL'));
await page.fill('input[name=password]', need('EDITOR_PASSWORD'));
await page.click('button[type=submit]');
await page.waitForURL((u) => !u.pathname.includes('/auth/login'), { timeout: 60_000 }).catch(() => {});
if (!check('editor can log in to the admin panel', !page.url().includes('/auth/login'))) {
	await page.screenshot({ path: `${artifacts}login.png` });
	throw new Error(failures.join('\n'));
}
await page.getByRole('button', { name: /skip|close|not now/i }).first().click({ timeout: 3000 }).catch(() => {});
await page.keyboard.press('Escape').catch(() => {});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Opens the English edit view, ticks every target locale in the Supertext panel and translates. */
async function translate(doc, label) {
	await page.goto(`${B}/admin/content-manager/collection-types/${MODEL}/${doc}?plugins[i18n][locale]=${SOURCE}`);
	await page.getByText('Supertext translation').first().waitFor({ timeout: 60_000 });
	await page.getByRole('button', { name: 'Translate with Supertext' }).waitFor();
	const notConfigured = await page.getByText('Supertext is not configured yet').count();
	check(`${label}: panel without "not configured"`, notConfigured === 0);
	for (const t of targets) {
		const box = page.getByRole('checkbox', { name: new RegExp(`\\(${escape(t.code)}\\)`) });
		const usable = (await box.count()) === 1 && (await box.isEnabled());
		if (check(`${label}: ${t.code} can be selected`, usable)) await box.click();
	}
	if (label.startsWith('second')) {
		check(`${label}: overwrite warning shown`, (await page.getByText(/Existing translations will be replaced/).count()) > 0);
	}
	const started = Date.now();
	const [response] = await Promise.all([
		page.waitForResponse((r) => r.url().includes('/supertext/translate') && r.request().method() === 'POST', { timeout: 900_000 }),
		page.getByRole('button', { name: 'Translate with Supertext' }).click(),
	]);
	const body = await response.json().catch(() => ({}));
	console.log(`${label}: ${Math.round((Date.now() - started) / 1000)} s, HTTP ${response.status()}`);
	check(`${label}: translate request succeeded`, response.ok(), `HTTP ${response.status()} ${body?.error?.message ?? ''}`);
	const results = body?.results ?? [];
	await page.waitForTimeout(1000);
	await page.screenshot({ path: `${artifacts}${label}-result.png`, fullPage: true });
	const expected = label.startsWith('second') ? 'updated' : 'created';
	for (const t of targets) {
		const r = results.find((x) => x.locale === t.code);
		check(`${label}: ${t.code} ${expected}`, r?.status === expected, r ? `${r.status}${r.error ? `: ${r.code ?? ''} ${r.error}` : ''}` : 'no result');
		// What the editor sees in the panel: "German (Switzerland) (de-CH): created (9 fields)" or an error in red.
		const line = page.getByText(new RegExp(`^${escape(t.name)}: `)).first();
		const shown = (await line.count()) ? (await line.textContent()).trim() : '';
		check(`${label}: ${t.code} result shown without error`, /: (created|replaced) \(\d+ fields?\)/.test(shown), shown || 'nothing shown');
	}
}

/** All target entries of all source articles. */
async function snapshot() {
	const out = {};
	for (const doc of source.keys()) {
		out[doc] = {};
		for (const t of targets) out[doc][t.code] = await entry(doc, t.code);
	}
	out.lists = {};
	for (const t of targets) out.lists[t.code] = await listIn(t.code);
	return out;
}

// --- First translation -------------------------------------------------------------------
for (const doc of source.keys()) await translate(doc, 'first-run');
const first = await snapshot();

for (const [doc, src] of source) {
	const sourceTexts = texts(src.data);
	for (const t of targets) {
		const lang = t.code.split(/[-_]/)[0].toLowerCase();
		const tag = `${t.code} ${doc}`;
		const e = first[doc][t.code];
		if (!check(`${tag}: translated copy exists`, !!e)) continue;
		const d = e.data;
		const published = d.status ? d.status !== 'draft' : d.publishedAt != null;
		check(`${tag}: left as a draft (not published)`, !published, d.status ?? String(d.publishedAt));
		check(`${tag}: slug filled`, String(d.slug ?? '').trim() !== '', d.slug);
		const raw = JSON.stringify(d);
		const left = LEFTOVERS.filter((l) => raw.includes(l));
		check(`${tag}: no protocol leftovers`, left.length === 0, left.join(', '));

		const targetTexts = texts(d);
		let fields = 0;
		let changed = 0;
		let text = '';
		for (const [path, s] of sourceTexts) {
			fields++;
			const v = targetTexts.get(path);
			if (!check(`${tag}: ${path} filled`, !!v && v.value.trim() !== '')) continue;
			if (v.value !== s.value) changed++;
			else note(`${tag}: ${path} unchanged ("${s.value}")`);
			text += ` ${v.value}`;
			const want = formatting(s);
			const got = formatting(v);
			for (const [what, n] of Object.entries(want)) {
				if (n) check(`${tag}: ${path} keeps its ${what}`, got[what] === n, `${got[what] ?? 0}/${n}`);
			}
		}
		check(`${tag}: texts were changed by the translation`, fields > 0 && changed / fields >= 0.8, `${changed}/${fields} fields`);
		if (STOPWORDS[lang]) {
			const scores = Object.fromEntries(Object.keys(STOPWORDS).map((l) => [l, score(text, l)]));
			const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0];
			check(`${tag}: text is in the target language`, best === lang, JSON.stringify(scores));
		}
		if (/^de-ch$/i.test(t.code)) check(`${tag}: Swiss German spelling (no "ß")`, !text.includes('ß'));
		// Non-localized fields are shared, not translated.
		if (src.data.readingTime != null) check(`${tag}: shared field readingTime kept`, d.readingTime === src.data.readingTime, `${d.readingTime}`);
	}
}
note('the demo content has no placeholders or shortcodes (Strapi has none); links, marks, list items, headings and Markdown are counted instead');
for (const t of targets) {
	check(`${t.code}: one entry per English article`, first.lists[t.code].length === source.size, `${first.lists[t.code].length}/${source.size}`);
}

// --- Translating again replaces the same entries ------------------------------------------------
for (const doc of source.keys()) await translate(doc, 'second-run');
const second = await snapshot();
for (const t of targets) {
	const before = first.lists[t.code].map((r) => r.documentId).sort().join(',');
	const after = second.lists[t.code].map((r) => r.documentId).sort().join(',');
	check(`${t.code}: translating again adds no entries`, before === after, `${first.lists[t.code].length} → ${second.lists[t.code].length}`);
	for (const doc of source.keys()) {
		const a = first[doc][t.code]?.data;
		const b = second[doc][t.code]?.data;
		if (!a || !b) continue;
		check(`${t.code} ${doc}: translating again updates the same entry`, a.documentId === b.documentId && a.locale === b.locale);
		if (a.id !== b.id) note(`${t.code} ${doc}: row id changed ${a.id} → ${b.id} (Strapi's document is the same)`);
		check(`${t.code} ${doc}: translating again keeps the slug`, a.slug === b.slug, `${a.slug} → ${b.slug}`);
		const published = b.status ? b.status !== 'draft' : b.publishedAt != null;
		check(`${t.code} ${doc}: still a draft after translating again`, !published, b.status ?? '');
	}
}

await browser.close();

if (failures.length) {
	console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}`);
	process.exit(1);
}
console.log('\nAll end-to-end checks passed.');
