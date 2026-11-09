import { hasText, htmlToInline, inlineToHtml, isInlineContainer, type InlineNode } from '../supertext/blocks';
import type { Segment } from '../supertext/html';

/**
 * Turns a source document into (a) the data object for the target locale and
 * (b) the list of text segments to translate, each with a setter that writes
 * the translation into that data object.
 *
 * Pure function over a schema lookup, so it can be unit-tested without Strapi.
 */

export interface Attribute {
  type: string;
  component?: string;
  components?: string[];
  repeatable?: boolean;
  multiple?: boolean;
  targetField?: string;
  pluginOptions?: { i18n?: { localized?: boolean } };
  [key: string]: unknown;
}

export type Attributes = Record<string, Attribute>;

export interface SchemaLookup {
  component(uid: string): Attributes;
}

export interface Job {
  /**
   * Stable key of the text in the entry: the attribute path, e.g. `title`, `seo.metaTitle`,
   * `sections.0.quote`, `body.1.0` (a blocks field: the index in the field, then in `children`).
   * Used as the segment key of translation files.
   */
  key: string;
  segment: Segment;
  apply(translation: string): void;
  /** Puts back the value another version of the entry (same shape, e.g. the target locale) has at this place, if any. */
  keep(other: Record<string, unknown>): void;
}

export interface Extraction {
  data: Record<string, unknown>;
  jobs: Job[];
  /** uid attributes to regenerate from their (translated) target field. */
  uidFields: string[];
}

const COPIED_TYPES = new Set([
  'email',
  'enumeration',
  'integer',
  'biginteger',
  'float',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'json',
]);

const isTranslatableString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '' && !/^[\d\s.,:/+-]+$/.test(value);

export function extract(attributes: Attributes, source: Record<string, unknown>, schema: SchemaLookup): Extraction {
  const jobs: Job[] = [];
  const uidFields: string[] = [];
  const data = walk(attributes, source, schema, jobs, true, uidFields, []);
  return { data, jobs, uidFields };
}

function walk(
  attributes: Attributes,
  source: Record<string, unknown>,
  schema: SchemaLookup,
  jobs: Job[],
  topLevel: boolean,
  uidFields: string[],
  path: string[]
): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const [name, attribute] of Object.entries(attributes)) {
    // Non-localized fields are shared across locales; leave them alone.
    if (topLevel && attribute.pluginOptions?.i18n?.localized === false) {
      continue;
    }
    const value = source[name];
    if (value === undefined) {
      continue;
    }

    switch (attribute.type) {
      case 'string':
      case 'text':
      case 'richtext': {
        data[name] = value;
        if (isTranslatableString(value)) {
          // Markdown (richtext) travels as plain text so its syntax survives.
          const at = [...path, name];
          jobs.push({
            key: at.join('.'),
            segment: { text: value, html: false },
            apply: (t) => (data[name] = t),
            keep: (other) => {
              const kept = valueAt(other, at);
              if (typeof kept === 'string' && kept.trim() !== '') data[name] = kept;
            },
          });
        }
        break;
      }

      case 'blocks': {
        const blocks = structuredClone(value);
        data[name] = blocks;
        collectBlocks(blocks, jobs, [...path, name], []);
        break;
      }

      case 'uid': {
        data[name] = value;
        if (topLevel && attribute.targetField) {
          uidFields.push(name);
        }
        break;
      }

      case 'media': {
        data[name] = Array.isArray(value)
          ? value.map((file) => (file as { id: number }).id)
          : value
            ? (value as { id: number }).id
            : null;
        break;
      }

      case 'component': {
        const componentAttributes = schema.component(attribute.component as string);
        const one = (item: unknown, at: string[]) =>
          item ? walk(componentAttributes, item as Record<string, unknown>, schema, jobs, false, uidFields, at) : null;
        data[name] = attribute.repeatable
          ? Array.isArray(value)
            ? value.map((item, i) => one(item, [...path, name, String(i)]))
            : []
          : one(value, [...path, name]);
        break;
      }

      case 'dynamiczone': {
        data[name] = Array.isArray(value)
          ? value.map((item, i) => {
              const { __component } = item as { __component: string };
              // Mutate the walked object (don't spread it): the jobs' setters point at it.
              const entry = walk(schema.component(__component), item as Record<string, unknown>, schema, jobs, false, uidFields, [
                ...path,
                name,
                String(i),
              ]);
              return Object.assign(entry, { __component });
            })
          : [];
        break;
      }

      default:
        if (COPIED_TYPES.has(attribute.type)) {
          data[name] = value;
        }
      // relation, password and unknown types are skipped on purpose.
    }
  }
  return data;
}

/**
 * @param field   path of the blocks attribute
 * @param indices position of `nodes`: index in the field's array, then in each `children`
 */
function collectBlocks(nodes: unknown, jobs: Job[], field: string[], indices: number[]): void {
  if (!Array.isArray(nodes)) {
    return;
  }
  nodes.forEach((node, i) => {
    const at = [...indices, i];
    if (isInlineContainer(node)) {
      if (hasText(node.children)) {
        const original: InlineNode[] = node.children;
        jobs.push({
          key: [...field, ...at].join('.'),
          segment: { text: inlineToHtml(original), html: true },
          apply: (translation) => (node.children = htmlToInline(translation, original)),
          keep: (other) => {
            let kept: unknown = valueAt(other, field);
            at.forEach((index, depth) => {
              const list = depth === 0 ? kept : (kept as { children?: unknown } | undefined)?.children;
              kept = Array.isArray(list) ? list[index] : undefined;
            });
            const children = (kept as { children?: unknown } | undefined)?.children;
            if (Array.isArray(children)) node.children = structuredClone(children);
          },
        });
      }
    } else if (node && typeof node === 'object' && (node as { type?: string }).type !== 'code') {
      collectBlocks((node as { children?: unknown }).children, jobs, field, at);
    }
  });
}

/** The value at an attribute path (`['sections', '0', 'quote']`) of an entry, undefined if it has none. */
function valueAt(entry: unknown, path: string[]): unknown {
  let value = entry;
  for (const part of path) {
    value = value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
  }
  return value;
}

/** Builds a populate object that loads components, dynamic zones and media. */
export function populateFor(attributes: Attributes, schema: SchemaLookup, depth = 0): Record<string, unknown> | true {
  if (depth > 10) {
    return true;
  }
  const populate: Record<string, unknown> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    if (attribute.type === 'media') {
      populate[name] = true;
    } else if (attribute.type === 'component') {
      const nested = populateFor(schema.component(attribute.component as string), schema, depth + 1);
      populate[name] = nested === true || Object.keys(nested).length === 0 ? true : { populate: nested };
    } else if (attribute.type === 'dynamiczone') {
      populate[name] = {
        on: Object.fromEntries(
          (attribute.components ?? []).map((uid) => {
            const nested = populateFor(schema.component(uid), schema, depth + 1);
            return [uid, nested === true || Object.keys(nested).length === 0 ? true : { populate: nested }];
          })
        ),
      };
    }
  }
  return populate;
}
