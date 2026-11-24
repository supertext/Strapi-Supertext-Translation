import type { Core } from '@strapi/strapi';
import type { PluginConfig } from '../config';
import { Reporting } from '../reporting';

const instances = new WeakMap<object, Reporting>();

/**
 * The Commando Center glue for this Strapi process (see ../reporting.ts): state in the core store
 * (`plugin_supertext_reporter`), settings from config/plugins, Strapi's version and REST prefix.
 */
export const reportingFor = (strapi: Core.Strapi): Reporting => {
  let instance = instances.get(strapi);
  if (!instance) {
    const scope = { type: 'plugin', name: 'supertext', key: 'reporter' } as const;
    instance = new Reporting({
      storage: {
        get: () => strapi.store.get(scope),
        set: async (value) => {
          await strapi.store.set({ ...scope, value });
        },
      },
      settings: () => strapi.config.get('plugin::supertext') as PluginConfig,
      strapiVersion: () => {
        const version = strapi.config.get('info.strapi');
        return typeof version === 'string' ? version : null;
      },
      apiPrefix: () => String(strapi.config.get('api.rest.prefix', '/api')),
      logger: { debug: (message) => strapi.log.debug(message) },
    });
    instances.set(strapi, instance);
  }
  return instance;
};

/** Plain object (Strapi may copy services), delegating to the one Reporting of this process. */
const reporting = ({ strapi }: { strapi: Core.Strapi }) => ({
  enabled: () => reportingFor(strapi).enabled,
  ping: (challenge: unknown) => reportingFor(strapi).ping(challenge),
  run: (...args: Parameters<Reporting['run']>) => reportingFor(strapi).run(...args),
  inBackground: (...args: Parameters<Reporting['inBackground']>) => reportingFor(strapi).inBackground(...args),
  lastCheck: () => reportingFor(strapi).lastCheck(),
  sendConfiguration: (...args: Parameters<Reporting['sendConfiguration']>) => reportingFor(strapi).sendConfiguration(...args),
});

export default reporting;
export type ReportingService = ReturnType<typeof reporting>;
