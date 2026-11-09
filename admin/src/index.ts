import type { StrapiApp } from '@strapi/strapi/admin';
import { Initializer } from './components/Initializer';
import { SupertextPanel } from './components/SupertextPanel';
import { PERMISSIONS } from './api';
import { PLUGIN_ID } from './pluginId';
import { getTranslation } from './utils/getTranslation';

const plugin: StrapiApp['appPlugins'][string] = {
  register(app) {
    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: 'Supertext',
    });

    app.addSettingsLink(
      { id: PLUGIN_ID, intlLabel: { id: getTranslation('settings.section'), defaultMessage: 'Supertext' } },
      {
        id: 'configuration',
        to: PLUGIN_ID,
        intlLabel: { id: getTranslation('settings.link'), defaultMessage: 'Translation' },
        Component: () => import('./pages/Settings'),
        permissions: PERMISSIONS.read,
      }
    );
  },

  bootstrap(app) {
    const contentManager = app.getPlugin('content-manager') as unknown as {
      apis: { addEditViewSidePanel(panels: unknown[]): void };
    };
    contentManager.apis.addEditViewSidePanel([SupertextPanel]);
  },

  async registerTrads({ locales }: { locales: string[] }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = (await import(`./translations/${locale}.json`)) as {
            default: Record<string, string>;
          };
          return {
            data: Object.fromEntries(Object.entries(data).map(([key, value]) => [getTranslation(key), value])),
            locale,
          };
        } catch {
          return { data: {}, locale };
        }
      })
    );
  },
};

export default plugin;
