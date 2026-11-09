/**
 * The plugin's admin permissions (Settings → Administration Panel → Roles → Settings → Supertext).
 * Super Admins get them automatically; other roles only when an administrator ticks them.
 * The panel in the Content Manager uses the Content Manager's own permissions instead.
 */
export const ACTIONS = {
  read: 'plugin::supertext.settings.read',
  update: 'plugin::supertext.settings.update',
} as const;

export const actions = [
  { section: 'settings', category: 'Supertext', subCategory: 'Settings', pluginName: 'supertext', displayName: 'Read', uid: 'settings.read' },
  { section: 'settings', category: 'Supertext', subCategory: 'Settings', pluginName: 'supertext', displayName: 'Update', uid: 'settings.update' },
];
