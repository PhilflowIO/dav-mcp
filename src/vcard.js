import ICAL from 'ical.js';

/**
 * The one way dav-mcp reads a vCard — for display and for query filters
 * alike, so a contact shown in a list is also one a filter can find.
 *
 * vCard 2.1 and RFC 2426 (3.0) allow a parameter without a name:
 * `EMAIL;PREF;INTERNET:john@doe.com`, `TEL;CELL:…`. Outlook and Android
 * still export that form. ical.js only accepts `name=value` parameters and
 * rejects the whole card ("Invalid parameters in …"). A bare parameter is a
 * TYPE value in both specs (vCard 2.1 section 2.1.2, RFC 2426 section 4), so it
 * is rewritten to `TYPE=…` before parsing; nothing else about the card
 * changes.
 *
 * @param {string} data - the vCard text
 * @returns {ICAL.Component} the VCARD
 * @throws when the card does not parse even then
 */
export function readVCard(data) {
  const jcard = ICAL.parse(withNamedParameters(data));
  // a body holding several cards parses to a list of them; a DAV resource
  // is one card, so the first is the one
  return new ICAL.Component(Array.isArray(jcard[0]) ? jcard[0] : jcard);
}

function withNamedParameters(data) {
  // unfold first: a parameter list can be folded across lines
  return data
    .replace(/\r?\n[ \t]/g, '')
    .split(/\r?\n/)
    .map(nameBareParameters)
    .join('\r\n');
}

/** `EMAIL;PREF;INTERNET:x` -> `EMAIL;TYPE=PREF;TYPE=INTERNET:x` */
function nameBareParameters(line) {
  const semicolon = line.indexOf(';');
  const colon = line.indexOf(':');
  if (semicolon === -1 || (colon !== -1 && colon < semicolon)) return line;

  // the parameters end at the first colon outside a quoted value
  const parameters = [];
  let current = '';
  let quoted = false;
  let i = semicolon + 1;
  for (; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === ';' || char === ':')) {
      parameters.push(current);
      current = '';
      if (char === ':') break;
    } else {
      current += char;
    }
  }
  if (i >= line.length) return line; // no value: not a content line ical.js can read anyway

  const named = parameters
    .filter((parameter) => parameter !== '')
    .map((parameter) => (parameter.includes('=') ? parameter : `TYPE=${parameter}`));
  return `${line.slice(0, semicolon)};${named.join(';')}${line.slice(i)}`;
}

/**
 * A structured value (N, ORG, ADR) or a plain one as text: the non-empty
 * parts, nested lists included, joined by `separator`.
 *
 * @param {unknown} value - a property value as ical.js returns it
 * @param {string} separator
 * @returns {string}
 */
export function structuredText(value, separator) {
  return [value].flat(Infinity)
    .filter((part) => part !== null && part !== undefined && part !== '')
    .map(String)
    .join(separator);
}

/**
 * The components of an N property. A one-part value (`N:Cher`) arrives as a
 * string, not a list, and is the family name. A component holding several
 * values (vCard 4: `Marie,Jo`) is joined by a space.
 *
 * @param {ICAL.Property} property
 * @returns {{family: string, given: string, additional: string, prefix: string, suffix: string}}
 */
export function nameComponents(property) {
  const value = property.getFirstValue();
  const parts = Array.isArray(value) ? value : [value];
  const [family, given, additional, prefix, suffix] =
    [0, 1, 2, 3, 4].map((index) => structuredText(parts[index], ' '));
  return { family, given, additional, prefix, suffix };
}

/**
 * An ORG property as text: organization, then units, comma-separated, empty
 * parts left out (`ORG:Acme;;Sales` -> "Acme, Sales").
 *
 * @param {ICAL.Property} property
 * @returns {string}
 */
export function organizationText(property) {
  return structuredText(property.getValues(), ', ');
}
