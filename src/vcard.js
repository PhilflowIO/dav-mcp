import ICAL from 'ical.js';

/**
 * The one way dav-mcp reads a vCard — for display and for query filters
 * alike, so a contact shown in a list is also one a filter can find.
 *
 * Two vCard 2.1 forms that Outlook and Android still export are rewritten
 * into what ical.js reads before parsing; nothing else about the card
 * changes.
 *
 * - A parameter without a name: `EMAIL;PREF;INTERNET:john@doe.com`,
 *   `TEL;CELL:…`. ical.js only accepts `name=value` parameters and rejects
 *   the whole card ("Invalid parameters in …"). A bare parameter is a TYPE
 *   value (vCard 2.1 section 2.1.2, RFC 2426 section 4), so it becomes
 *   `TYPE=…` — except the bare encoding `QUOTED-PRINTABLE`.
 * - A quoted-printable value: `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:
 *   Hans M=C3=BCller`, its lines joined by soft line breaks (a trailing `=`).
 *   ical.js would show the escapes as text. The value is decoded in its
 *   CHARSET and the ENCODING and CHARSET parameters dropped, so the card
 *   reads "Hans Müller" everywhere.
 *
 * @param {string} data - the vCard text
 * @returns {ICAL.Component} the VCARD
 * @throws when the card does not parse even then
 */
export function readVCard(data) {
  const jcard = ICAL.parse(normalizeContentLines(data));
  // a body holding several cards parses to a list of them; a DAV resource
  // is one card, so the first is the one
  return new ICAL.Component(Array.isArray(jcard[0]) ? jcard[0] : jcard);
}

function normalizeContentLines(data) {
  return unfold(data).map(normalizeContentLine).join('\r\n');
}

/**
 * The content lines: folded lines (CRLF + space) and quoted-printable soft
 * line breaks (`=` at the end, whitespace after it allowed by RFC 2045)
 * joined. Linear in the size of the card: each physical line is looked at
 * once, and whether a line is quoted-printable is decided once per line.
 */
function unfold(data) {
  const lines = [];
  let parts = null;
  let quotedPrintable = null; // unknown until the parameter list has ended

  const isQuotedPrintableLine = () => {
    if (quotedPrintable === null) {
      const parsed = parseContentLine(parts.join(''));
      if (!parsed) return false; // parameters still running on
      quotedPrintable = isQuotedPrintable(parsed.parameters);
    }
    return quotedPrintable;
  };

  for (const physical of data.split(/\r?\n/)) {
    if (parts) {
      const previous = parts[parts.length - 1];
      const softBreak = /=[ \t]*$/.exec(previous);
      if (softBreak && !startsContentLine(physical) && isQuotedPrintableLine()) {
        parts[parts.length - 1] = previous.slice(0, softBreak.index);
        parts.push(physical);
        continue;
      }
      if (/^[ \t]/.test(physical)) {
        parts.push(physical.slice(1));
        continue;
      }
      lines.push(parts.join(''));
    }
    parts = [physical];
    quotedPrintable = null;
  }
  if (parts) lines.push(parts.join(''));
  return lines;
}

const PROPERTY_NAMES = [
  'ADR', 'AGENT', 'ANNIVERSARY', 'BDAY', 'BEGIN', 'CALADRURI', 'CALURI',
  'CATEGORIES', 'CLASS', 'CLIENTPIDMAP', 'EMAIL', 'END', 'FBURL', 'FN',
  'GENDER', 'GEO', 'IMPP', 'KEY', 'KIND', 'LABEL', 'LANG', 'LOGO', 'MAILER',
  'MEMBER', 'N', 'NAME', 'NICKNAME', 'NOTE', 'ORG', 'PHOTO', 'PRODID',
  'PROFILE', 'RELATED', 'REV', 'ROLE', 'SORT-STRING', 'SOUND', 'SOURCE', 'TEL',
  'TITLE', 'TZ', 'UID', 'URL', 'VERSION', 'XML',
];
const CONTENT_LINE_START = new RegExp(
  `^(?:[A-Za-z0-9-]+\\.)?(?:${PROPERTY_NAMES.join('|')}|X-[A-Z0-9-]+)[;:]`);

/**
 * Whether a physical line starts a property of its own, so a soft line
 * break before it was a dangling `=` (an exporter bug) and must not swallow
 * it — `NOTE;ENCODING=QUOTED-PRINTABLE:abc=` before `END:VCARD` would
 * otherwise leave the card unterminated and the contact gone. The text a
 * soft break continues can hold a colon ("Note: call back"), so only a vCard
 * property name as exporters write it, upper case, counts — and END:VCARD in
 * any case.
 */
function startsContentLine(physical) {
  return /^END:VCARD\s*$/i.test(physical) || CONTENT_LINE_START.test(physical);
}

/**
 * `NAME;PARAM;…:value` split at the first colon outside a quoted parameter
 * value, or null for a line without a value.
 */
function parseContentLine(line) {
  const semicolon = line.indexOf(';');
  const colon = line.indexOf(':');
  if (colon === -1 && semicolon === -1) return null;
  if (semicolon === -1 || (colon !== -1 && colon < semicolon)) {
    return { name: line.slice(0, colon), parameters: [], value: line.slice(colon + 1) };
  }

  const parameters = [];
  let current = '';
  let quoted = false;
  for (let i = semicolon + 1; i < line.length; i++) {
    const char = line[i];
    if (char === '"') quoted = !quoted;
    if (!quoted && (char === ';' || char === ':')) {
      if (current !== '') parameters.push(current);
      current = '';
      if (char === ':') {
        return { name: line.slice(0, semicolon), parameters, value: line.slice(i + 1) };
      }
    } else {
      current += char;
    }
  }
  return null; // no value: not a content line ical.js can read anyway
}

/** A parameter as `[NAME, value]`, the value unquoted; a bare one has no name. */
function splitParameter(parameter) {
  const equals = parameter.indexOf('=');
  if (equals === -1) return [null, parameter];
  return [parameter.slice(0, equals).trim().toUpperCase(),
    parameter.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1')];
}

function isQuotedPrintable(parameters) {
  return parameters.some((parameter) => {
    const [name, value] = splitParameter(parameter);
    return (name === null || name === 'ENCODING') && value.trim().toUpperCase() === 'QUOTED-PRINTABLE';
  });
}

/**
 * `EMAIL;PREF;INTERNET:x` -> `EMAIL;TYPE=PREF;TYPE=INTERNET:x`, and a
 * quoted-printable value decoded, without its ENCODING and CHARSET.
 */
function normalizeContentLine(line) {
  const parsed = parseContentLine(line);
  if (!parsed || parsed.parameters.length === 0) return line;

  let { parameters, value } = parsed;
  if (isQuotedPrintable(parameters)) {
    const charset = parameters.map(splitParameter).find(([name]) => name === 'CHARSET')?.[1];
    value = decodeQuotedPrintable(value, charset);
    parameters = parameters.filter((parameter) => {
      const [name, bare] = splitParameter(parameter);
      return name === null ? bare.trim().toUpperCase() !== 'QUOTED-PRINTABLE'
        : name !== 'ENCODING' && name !== 'CHARSET';
    });
  }

  const named = parameters.map((parameter) => (parameter.includes('=') ? parameter : `TYPE=${parameter}`));
  return `${parsed.name}${named.map((parameter) => `;${parameter}`).join('')}:${value}`;
}

/**
 * A quoted-printable value as text. Each run of `=XX` escapes is one byte
 * sequence, decoded in `charset`; everything else is already text. A line
 * break the value encodes (`=0D=0A`, common in NOTE and ADR) becomes the
 * `\n` escape, because a raw one would end the content line. A `;` stays a
 * component separator, as in vCard 2.1 the value is decoded before it is
 * split.
 *
 * @param {string} value
 * @param {string|undefined} charset - the CHARSET parameter
 * @returns {string}
 */
export function decodeQuotedPrintable(value, charset) {
  const decode = byteDecoder(charset);
  return value
    .replace(/=[ \t]*$/, '')
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) =>
      decode(Uint8Array.from(run.slice(1).split('='), (hex) => parseInt(hex, 16))))
    .replace(/\r\n|\r|\n/g, '\\n');
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A decoder for the bytes of `charset`. Without a CHARSET (vCard 2.1 means
 * ASCII, exporters write UTF-8 or Latin-1), with UTF-8, or with a charset
 * this runtime does not know: UTF-8 if the bytes are valid UTF-8, else
 * windows-1252 (Latin-1 with the printable 0x80-0x9F), so a mislabelled card
 * still reads instead of failing. Never throws.
 */
function byteDecoder(charset) {
  let declared = null;
  try {
    declared = charset ? new TextDecoder(charset) : null;
  } catch {
    // unknown label: decode as if none were given
  }
  if (declared?.encoding === 'windows-1252') return windows1252;
  if (declared && declared.encoding !== 'utf-8') return (bytes) => declared.decode(bytes);
  return (bytes) => {
    try {
      return utf8.decode(bytes);
    } catch {
      return windows1252(bytes);
    }
  };
}

// 0x80-0x9F in windows-1252, by WHATWG Encoding; the five unassigned
// bytes keep their code point
const WINDOWS_1252_HIGH = [
  0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
  0x02C6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8D, 0x017D, 0x8F,
  0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
  0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

/**
 * windows-1252, which WHATWG also uses for the ISO-8859-1 and Latin-1
 * labels. Decoded here rather than by TextDecoder: before Node 22 its
 * windows-1252 is plain Latin-1 and turns 0x80 into a control character
 * instead of "€".
 */
function windows1252(bytes) {
  return Array.from(bytes, (byte) =>
    String.fromCodePoint(byte >= 0x80 && byte <= 0x9F ? WINDOWS_1252_HIGH[byte - 0x80] : byte)).join('');
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
