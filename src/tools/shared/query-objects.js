import ICAL from 'ical.js';
import { instantOf } from './ical-dates.js';
import { readSeries } from '../../ical-components.js';
import { readVCard, structuredText, nameComponents, organizationText } from '../../vcard.js';

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
 * @property {ICAL.Component|null} main - the VEVENT/VTODO master (readSeries), or the VCARD
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
    const root = parseRoot(object.data, kind);
    return { object, root, main: mainComponent(root, kind) };
  });
}

function parseRoot(data, kind) {
  if (typeof data !== 'string' || !data.trim()) return null;
  try {
    // vCards go through the reader the display uses (see vcard.js)
    if (kind === 'vcard') return readVCard(data);
    const jcal = ICAL.parse(data);
    // a body holding several documents parses to a list of them; a DAV
    // resource is one, so the first is the one
    return new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal);
  } catch {
    return null;
  }
}

/**
 * The component a filter reads: the one the display shows and update tools
 * write. For an event or todo that is readSeries' master (src/ical-components.js)
 * — a recurring event's occurrences are resolved per query, see shownEvent.
 */
function mainComponent(root, kind) {
  if (!root) return null;
  if (kind === 'vcard') return root.name === 'vcard' ? root : null;
  return readSeries(root, kind)?.master ?? null;
}

/**
 * Every value of a property as plain, unescaped text — one string per
 * property instance, so an object with three EMAILs yields three.
 * Structured values have their non-empty components joined by `separator`
 * (see structuredText).
 *
 * @param {ICAL.Component|null} component
 * @param {string} name - property name, any case
 * @param {string} [separator]
 * @returns {string[]}
 */
export function textValues(component, name, separator = ' ') {
  if (!component) return [];
  return component.getAllProperties(name.toLowerCase())
    .map((property) => structuredText(property.getValues(), separator))
    .filter(Boolean);
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
    const { family, given, additional, prefix, suffix } = nameComponents(property);
    return structuredText([prefix, given, additional, family, suffix], ' ');
  });
  return [...textValues(vcard, 'fn'), ...structured.filter(Boolean)];
}

/**
 * A vCard's organizations, each as the contact display shows it
 * (see organizationText).
 *
 * @param {ICAL.Component|null} vcard
 * @returns {string[]}
 */
export function organizations(vcard) {
  if (!vcard) return [];
  return vcard.getAllProperties('org').map(organizationText).filter(Boolean);
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
