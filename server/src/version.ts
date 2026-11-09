import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const PACKAGE_NAME = 'strapi-plugin-supertext-translation';

/** The plugin's name in version reports, translation files and the User-Agent (the GitHub repository's name). */
export const PLUGIN_NAME = 'Strapi-Supertext-Translation';

let cached: string | null | undefined;

/** Walks up from `start` to the plugin's own package.json. */
const findFrom = (start: string): string | null => {
  let dir = start;
  for (;;) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg?.name === PACKAGE_NAME && typeof pkg.version === 'string') return pkg.version;
    } catch {
      // no (readable) package.json here, keep going up
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
};

/** Resolves the installed package from the Strapi app (works for the ESM build, where __dirname is undefined). */
const fromApp = (): string | null => {
  try {
    const require = createRequire(join(process.cwd(), 'package.json'));
    const pkg = JSON.parse(readFileSync(require.resolve(`${PACKAGE_NAME}/package.json`), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
};

/**
 * The plugin's version, read at runtime from its package.json (the only place it is kept).
 * Returns null if the file can't be found.
 */
export const pluginVersion = (): string | null => {
  if (cached === undefined) {
    const here = typeof __dirname === 'string' ? findFrom(__dirname) : null;
    cached = here ?? fromApp();
  }
  return cached;
};
