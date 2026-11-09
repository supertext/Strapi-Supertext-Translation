'use strict';

const LOCALES = [
  { code: 'de-CH', name: 'German (Switzerland) (de-CH)' },
  { code: 'fr-CH', name: 'French (Switzerland) (fr-CH)' },
  { code: 'it-CH', name: 'Italian (Switzerland) (it-CH)' },
];

const SAMPLE = {
  title: 'Swiss chocolate, shipped worldwide',
  slug: 'swiss-chocolate-shipped-worldwide',
  summary: 'How a small family business in Bern brings hand-made pralines to customers in 40 countries.',
  body: [
    { type: 'heading', level: 2, children: [{ type: 'text', text: 'From Bern to the world' }] },
    {
      type: 'paragraph',
      children: [
        { type: 'text', text: 'Every praline is made by hand in our workshop in ' },
        { type: 'text', text: 'Bern', bold: true },
        { type: 'text', text: '. Read more on ' },
        { type: 'link', url: 'https://www.supertext.com', children: [{ type: 'text', text: 'our website' }] },
        { type: 'text', text: '.' },
      ],
    },
    {
      type: 'list',
      format: 'unordered',
      children: [
        { type: 'list-item', children: [{ type: 'text', text: 'Fresh ingredients from local farms' }] },
        { type: 'list-item', children: [{ type: 'text', text: 'Climate-neutral delivery within 48 hours' }] },
      ],
    },
  ],
  readingTime: 3,
  seo: {
    metaTitle: 'Hand-made Swiss chocolate | Demo',
    metaDescription: 'Hand-made pralines from Bern, delivered fresh to 40 countries.',
    noIndex: true,
  },
  sections: [
    {
      __component: 'sections.feature',
      heading: 'Our promise',
      text: 'We only use **fair-trade cocoa** and never add palm oil.\n\n- No artificial flavours\n- Recyclable packaging',
    },
    { __component: 'sections.quote', quote: 'The best chocolate I have ever tasted.', author: 'A happy customer' },
  ],
};

/**
 * Creates admin accounts from environment variables, so a fresh demo is ready
 * without anyone registering in the browser. Existing accounts are left alone
 * (their password is never overwritten).
 *
 *   DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD  → Super Admin
 *   DEMO_EDITOR_EMAIL / DEMO_EDITOR_PASSWORD → Editor (e.g. for automated tests)
 */
async function ensureAccounts(strapi) {
  const users = strapi.service('admin::user');
  const roles = strapi.service('admin::role');
  const accounts = [
    { prefix: 'DEMO_ADMIN', role: 'strapi-super-admin', firstname: 'Demo', lastname: 'Admin' },
    { prefix: 'DEMO_EDITOR', role: 'strapi-editor', firstname: 'Demo', lastname: 'Editor' },
  ];

  for (const account of accounts) {
    const email = (process.env[`${account.prefix}_EMAIL`] || '').trim().toLowerCase();
    const password = process.env[`${account.prefix}_PASSWORD`] || '';
    if (!email || !password) continue;

    if (await users.exists({ email })) {
      strapi.log.info(`[demo] ${account.prefix}_EMAIL account already exists, leaving it unchanged`);
      continue;
    }
    // Strapi's own rule: 8+ characters with an upper-case letter, a lower-case letter and a number.
    if (password.length < 8 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) {
      strapi.log.warn(
        `[demo] ${account.prefix}_PASSWORD is too weak (8+ characters, upper- and lower-case letter, number); account not created`
      );
      continue;
    }
    const role = await roles.findOne({ code: account.role });
    if (!role) {
      strapi.log.warn(`[demo] Role ${account.role} not found; ${account.prefix} account not created`);
      continue;
    }
    await users.create({
      email,
      firstname: account.firstname,
      lastname: account.lastname,
      password,
      registrationToken: null,
      isActive: true,
      roles: [role.id],
    });
    strapi.log.info(`[demo] Created ${account.role} account from ${account.prefix}_EMAIL`);
  }
}

/**
 * Strapi doesn't grant locales added later to existing roles, so the demo's
 * Editor role would see no entries. Give its content permissions every locale.
 */
async function grantEditorAllLocales(strapi, localeCodes) {
  const role = await strapi.service('admin::role').findOne({ code: 'strapi-editor' });
  if (!role) return;
  const permissions = await strapi.db.query('admin::permission').findMany({
    where: { role: role.id, action: { $startsWith: 'plugin::content-manager.explorer.' } },
  });
  for (const permission of permissions) {
    const properties = permission.properties || {};
    const current = properties.locales || [];
    if (localeCodes.every((code) => current.includes(code))) continue;
    await strapi.db.query('admin::permission').update({
      where: { id: permission.id },
      data: { properties: { ...properties, locales: [...new Set([...current, ...localeCodes])] } },
    });
  }
}

module.exports = {
  register() {},

  /** Demo setup: admin accounts from env, Swiss locales, Supertext language settings, one English sample article. */
  async bootstrap({ strapi }) {
    try {
      await ensureAccounts(strapi);
    } catch (error) {
      strapi.log.error(`[demo] Could not create demo accounts: ${error.message}`);
    }

    const locales = strapi.plugin('i18n').service('locales');
    const existing = (await locales.find()).map((locale) => locale.code);
    for (const locale of LOCALES) {
      if (!existing.includes(locale.code)) {
        await locales.create(locale);
        strapi.log.info(`[demo] Added locale ${locale.code}`);
      }
    }

    try {
      await grantEditorAllLocales(strapi, (await locales.find()).map((locale) => locale.code));
    } catch (error) {
      strapi.log.warn(`[demo] Could not grant locales to the Editor role: ${error.message}`);
    }

    // Settings → Supertext → Languages: formal address for the Swiss locales, only if nothing is
    // saved yet (an administrator's choices are never overwritten). en uses the default en-US.
    const languages = { type: 'plugin', name: 'supertext', key: 'languages' };
    if (!(await strapi.store.get(languages))) {
      await strapi.store.set({
        ...languages,
        value: { 'de-CH': { code: 'de-CH', politeness: 'more' }, 'fr-CH': { code: 'fr-CH', politeness: 'more' }, 'it-CH': { code: 'it-CH', politeness: 'more' } },
      });
      strapi.log.info('[demo] Saved the Supertext language settings');
    }

    const articles = strapi.documents('api::article.article');
    if ((await articles.count({ locale: 'en' })) === 0) {
      await articles.create({ locale: 'en', data: SAMPLE });
      strapi.log.info('[demo] Created the sample article');
    }
  },
};
