import ICAL from 'ical.js';
import { instantOf } from './ical-dates.js';

/**
 * The query tools filter and sort what the server returned on our side. They
 * do it on parsed values, never on the raw text: a pattern such as
 * /SUMMARY:(.+)/ misses a property that carries parameters
 * (SUMMARY;LANGUAGE=de:…) or is folded across lines, compares escaped text
 * (`\,`), and /N:(.+)/ also matches inside FN: or ORGANIZER;CN=…: lines.
 *
 * Each object is parsed once, here, and every filter and the sort key read
 * that one parse. One malformed object must not fail the query for all the
 * others: it parses to null, matches no filter and sorts last — it is still
 * returned when no filter is set, as it was before.
 */

/**
 * @typedef {Object} ParsedObject
 * @property {Object} object - the DAV object as fetched ({ url, etag, data })
 * @property {ICAL.Component|null} root - VCALENDAR or VCARD, null if unparseable
 * @property {ICAL.Component|null} main - the VEVENT/VTODO master, or the VCARD
 */

/**
 * Parse fetched DAV objects for filtering.
 *
 * @param {Array<{data?: string}>} objects
 * @param {'vevent'|'vtodo'|'vcard'} kind - the component the query is about
 * @returns {ParsedObject[]}
 */
export function parseObjects(objects, kind) {
  return objects.map((object) => {
    const root = parseRoot(object.data);
    return { object, root, main: mainComponent(root, kind) };
  });
}

function parseRoot(data) {
  if (typeof data !== 'string' || !data.trim()) return null;
  try {
    const jcal = ICAL.parse(data);
    // a body holding several documents parses to a list of them; a DAV
    // resource is one, so the first is the one
    return new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
  } catch {
    return null;
  }
}

/**
 * The component a filter reads. For a recurring event or todo that is the
 * master — the one without RECURRENCE-ID. Overrides are siblings of it in the
 * same object, in whatever order the server stored them, so "the first
 * VEVENT" can be an override.
 */
function mainComponent(root, kind) {
  if (!root) return null;
  if (kind === 'vcard') return root.name === 'vcard' ? root : null;
  const all = root.getAllSubcomponents(kind);
  return all.find((c) => !c.hasProperty('recurrence-id')) ?? all[0] ?? null;
}

/**
 * The RECURRENCE-ID overrides of a recurring event or todo.
 *
 * @param {ParsedObject} parsed
 * @param {'vevent'|'vtodo'} kind
 * @returns {ICAL.Component[]}
 */
export function overridesOf(parsed, kind) {
  if (!parsed.root) return [];
  return parsed.root.getAllSubcomponents(kind)
    .filter((c) => c !== parsed.main && c.hasProperty('recurrence-id'));
}

/**
 * Every value of a property as plain, unescaped text — one string per
 * property instance, so an object with three EMAILs yields three.
 * Structured values (ORG, N, ADR) have their components joined by
 * `separator`; empty components are left out.
 *
 * @param {ICAL.Component|null} component
 * @param {string} name - property name, any case
 * @param {string} [separator]
 * @returns {string[]}
 */
export function textValues(component, name, separator = ' ') {
  if (!component) return [];
  return component.getAllProperties(name.toLowerCase())
    .map((property) => joinText(property.getValues(), separator))
    .filter(Boolean);
}

function joinText(values, separator) {
  return values.flat(Infinity)
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String)
    .join(separator);
}

/**
 * A vCard's names: every FN, and N read in natural order (prefix, given,
 * additional, family, suffix), so "John Smith" matches N:Smith;John;;; just as
 * it matches the FN that usually says the same.
 *
 * @param {ICAL.Component|null} vcard
 * @returns {string[]}
 */
export function contactNames(vcard) {
  if (!vcard) return [];
  const structured = vcard.getAllProperties('n').map((property) => {
    const [family, given, additional, prefix, suffix] = property.getFirstValue() ?? [];
    return joinText([prefix, given, additional, family, suffix].map((v) => v ?? ''), ' ');
  });
  return [...textValues(vcard, 'fn'), ...structured.filter(Boolean)];
}

/**
 * Case-insensitive substring match against any of the values.
 *
 * @param {string[]} values
 * @param {string} needle
 * @returns {boolean}
 */
export function containsText(values, needle) {
  const lower = needle.toLowerCase();
  return values.some((value) => value.toLowerCase().includes(lower));
}

/**
 * Sort key for a date property of the main component: its instant (see
 * instantOf), or null when the property is absent or unreadable — null sorts
 * last in limitResults.
 *
 * @param {ParsedObject} parsed
 * @param {string} name - property name, any case
 * @returns {number|null}
 */
export function dateKey(parsed, name) {
  const property = parsed.main?.getFirstProperty(name.toLowerCase());
  if (!property) return null;
  try {
    const instant = instantOf(property);
    return Number.isFinite(instant) ? instant : null;
  } catch {
    return null;
  }
}

/**
 * Sort key for a text property of the main component: its first value,
 * lower-cased, or null when absent.
 *
 * @param {ParsedObject} parsed
 * @param {string} name - property name, any case
 * @returns {string|null}
 */
export function textKey(parsed, name) {
  const [first] = textValues(parsed.main, name);
  return first ? first.toLowerCase() : null;
}

/**
 * Run a date computation on a parsed component without letting one
 * unreadable value fail the whole query.
 *
 * @template T
 * @param {() => T} compute
 * @returns {T|null}
 */
export function orNull(compute) {
  try {
    return compute();
  } catch {
    return null;
  }
}
