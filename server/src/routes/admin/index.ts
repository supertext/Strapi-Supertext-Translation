import { ACTIONS } from '../../permissions';

const policies = ['admin::isAuthenticatedAdmin'];
const can = (action: string) => ['admin::isAuthenticatedAdmin', { name: 'admin::hasPermissions', config: { actions: [action] } }];

export default () => ({
  type: 'admin',
  routes: [
    { method: 'GET', path: '/status', handler: 'translate.status', config: { policies } },
    { method: 'POST', path: '/test-connection', handler: 'translate.testConnection', config: { policies: can(ACTIONS.read) } },
    { method: 'GET', path: '/settings', handler: 'translate.settings', config: { policies: can(ACTIONS.read) } },
    { method: 'PUT', path: '/settings', handler: 'translate.saveSettings', config: { policies: can(ACTIONS.update) } },
    { method: 'GET', path: '/locales', handler: 'translate.locales', config: { policies } },
    { method: 'POST', path: '/translate', handler: 'translate.translate', config: { policies } },
    { method: 'GET', path: '/export', handler: 'translate.exportFile', config: { policies } },
    { method: 'POST', path: '/import', handler: 'translate.importFile', config: { policies } },
  ],
});
