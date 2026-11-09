import type { Core } from '@strapi/strapi';
import { actions } from './permissions';

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  // Read and update the settings (Roles → Settings → Supertext).
  await strapi.service('admin::permission').actionProvider.registerMany(actions);
  const { apiKey } = strapi.config.get('plugin::supertext') as { apiKey?: string };
  if (!apiKey) {
    strapi.log.warn('[supertext] No API key configured (SUPERTEXT_API_KEY). Translation is disabled until one is set. Create a Supertext account at https://www.supertext.com/person/en/account/signin and generate a key at https://www.supertext.com/en/integrations/api (requires the Admin role).');
  }
};

export default bootstrap;
