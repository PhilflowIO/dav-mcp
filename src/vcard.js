import ICAL from 'ical.js';
import { writeFields } from './tools/shared/ical-dates.js';

/**
 * The one way dav-mcp reads a vCard — for display and for query filters
 * alike, so a contact shown in a list is also one a filter can find.
 *
 * @param {string} data - the vCard text
 * @returns {ICAL.Component} the VCARD
 * @throws when the card does not parse even then
 */
export function readVCard(data) {
  const jcard = ICAL.parse(normalizeVCard(data));
  // a body holding several cards parses to a list of them; a DAV resource
  // is one card, so the first is the one
  return new ICAL.Component(Array.isArray(jcard[0]) ? jcard[0] : jcard);
}

/**
 * Set fields on a vCard the way readVCard reads it: the card is normalized
 * first, so an edit to a vCard 2.1 card writes back the 3.0 card it was read
 * as — decoded, with named parameters — and not a 2.1 card where the new
 * value carries the old CHARSET and ENCODING=QUOTED-PRINTABLE and the
 * untouched lines stay encoded. ical.js could not even parse the card as
 * stored when it has a bare parameter or a soft line break.
 *
 * @param {{data: string}} vCard - the card as fetched
 * @param {Record<string, string>} fields - property name -> value
 * @returns {string} the card to write
 */
export function writeVCardFields(vCard, fields) {
  return writeFields(normalizeVCard(vCard.data), fields);
}

/**
 * A vCard as ical.js reads and writes it: what readVCard parses, and what
 * update_contact edits and writes back, so a card is written as it was read.
 *
 * Outlook and Android still export vCard 2.1, which ical.js does not know:
 *
 * - A parameter without a name: `EMAIL;PREF;INTERNET:john@doe.com`. ical.js
 *   rejects the whole card ("Invalid parameters in …"). A bare parameter is a
 *   TYPE value (vCard 2.1 section 2.1.2, RFC 2426 section 4) and becomes
 *   `TYPE=…`; a bare encoding (`QUOTED-PRINTABLE`, `BASE64`, `8BIT`) becomes
 *   `ENCODING=…`. This applies to 3.0 cards too, where the bare form is legal.
 * - A quoted-printable value: `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:
 *   Hans M=C3=BCller`, continued by soft line breaks (a trailing `=`). It is
 *   decoded in its CHARSET, and ENCODING and CHARSET are dropped.
 * - 2.1 escaping: only `\;` is an escape; `,` and `\` are plain text, and a
 *   line break can only be quoted-printable. ical.js reads every card with
 *   3.0 escaping, which split "Mueller, Jr." into two names.
 *
 * So a 2.1 card becomes the 3.0 card that says the same: VERSION:3.0, its
 * text values escaped the 3.0 way, decoded, without CHARSET, BASE64 as `b`.
 * 3.0 rather than a cleaned-up 2.1, because what is decoded can no longer be
 * 2.1 (a decoded line break has no 2.1 form other than quoted-printable),
 * and because 3.0 is the version every CardDAV server must accept (RFC 6352
 * section 5.1); sabre/dav (Baïkal, Nextcloud) refuses 2.1 outright.
 *
 * @param {string} data - the vCard text
 * @returns {string} the card, CRLF line endings, unfolded
 */
export function normalizeVCard(data) {
  const lines = unfold(data);
  let version21 = false;
  return lines.map((line, index) => {
    if (/^BEGIN:VCARD\s*$/i.test(line)) version21 = isVersion21(lines, index);
    return normalizeContentLine(line, version21);
  }).join('\r\n');
}

/** whether the card that begins at `lines[begin]` says VERSION:2.1 */
function isVersion21(lines, begin) {
  for (let i = begin + 1; i < lines.length && !/^END:VCARD\s*$/i.test(lines[i]); i++) {
    if (/^VERSION:\s*2\.1\s*$/i.test(lines[i])) return true;
  }
  return false;
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

/**
 * A parameter as `{name, value, text}`: the name upper case, the value
 * unquoted, `text` as written. A bare one is named here: ENCODING for an
 * encoding, else TYPE.
 */
function readParameter(text) {
  const equals = text.indexOf('=');
  if (equals === -1) {
    const value = text.trim();
    return { name: BARE_ENCODINGS.has(value.toUpperCase()) ? 'ENCODING' : 'TYPE', value, text: null };
  }
  return {
    name: text.slice(0, equals).trim().toUpperCase(),
    value: text.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1'),
    text,
  };
}

const BARE_ENCODINGS = new Set(['QUOTED-PRINTABLE', 'BASE64', '8BIT', '7BIT']);

/** the ENCODING parameter's value, upper case, or null */
function encodingOf(parameters) {
  const encoding = parameters.find(({ name }) => name === 'ENCODING');
  return encoding ? encoding.value.toUpperCase() : null;
}

function isQuotedPrintable(parameterTexts) {
  return encodingOf(parameterTexts.map(readParameter)) === 'QUOTED-PRINTABLE';
}

/**
 * One content line as ical.js reads it; see normalizeVCard.
 *
 * @param {string} line - unfolded
 * @param {boolean} version21 - the line belongs to a vCard 2.1
 */
function normalizeContentLine(line, version21) {
  const parsed = parseContentLine(line);
  if (!parsed) return line;
  const propertyName = parsed.name.slice(parsed.name.lastIndexOf('.') + 1).toUpperCase();
  if (version21 && propertyName === 'VERSION') return `${parsed.name}:3.0`;
  if (!version21 && parsed.parameters.length === 0) return line;

  let parameters = parsed.parameters.map(readParameter);
  const encoding = encodingOf(parameters);
  const quotedPrintable = encoding === 'QUOTED-PRINTABLE';

  let { value } = parsed;
  if (quotedPrintable) {
    value = decodeQuotedPrintable(value, parameters.find(({ name }) => name === 'CHARSET')?.value);
  }
  if (version21 && isText(propertyName, parameters)) {
    value = escape21(value, Boolean(ICAL.design.vcard3.property[propertyName.toLowerCase()]?.structuredValue));
  } else if (quotedPrintable) {
    value = value.replace(/\r\n|\r|\n/g, '\\n');
  }

  if (quotedPrintable || version21) {
    parameters = parameters.filter(({ name }) => name !== 'ENCODING' && name !== 'CHARSET');
    // 3.0 knows only ENCODING=b; 8BIT and 7BIT say nothing a 3.0 card needs
    if (version21 && encoding === 'BASE64') parameters.push({ name: 'ENCODING', value: 'b', text: null });
  }
  const written = parameters.map(({ name, value: parameterValue, text }) => text ?? `${name}=${parameterValue}`);
  return `${parsed.name}${written.map((parameter) => `;${parameter}`).join('')}:${value}`;
}

/**
 * Whether ical.js reads the property as text (and so unescapes it). Other
 * types — URIs, dates, binary — take no backslash escapes in either version.
 */
function isText(propertyName, parameters) {
  const valueType = parameters.find(({ name }) => name === 'VALUE')?.value;
  if (valueType) return valueType.toLowerCase() === 'text';
  return ICAL.design.vcard3.property[propertyName.toLowerCase()]?.defaultType === 'text';
}

/**
 * A 2.1 text value (decoded, if it was quoted-printable) in the escaping
 * ical.js reads: a backslash and a comma are plain text, a line break
 * becomes `\n`. `\;` is a literal semicolon — kept escaped in a structured
 * value (N, ADR, ORG), where a bare `;` separates components, and written
 * bare elsewhere, as ical.js unescapes `\;` only in structured values.
 */
function escape21(value, structured) {
  return value.replace(/\\;|\\|,|\r\n|\r|\n/g, (match) => {
    if (match === '\\;') return structured ? match : ';';
    if (match === '\\') return '\\\\';
    if (match === ',') return '\\,';
    return '\\n';
  });
}

/**
 * A quoted-printable value as text. Each run of `=XX` escapes is one byte
 * sequence, decoded in `charset`; everything else is already text. A soft
 * line break left at the end (one that had no continuation) is dropped. In
 * vCard 2.1 the value is decoded before it is split, so a decoded `;` is a
 * component separator.
 *
 * @param {string} value
 * @param {string|undefined} charset - the CHARSET parameter
 * @returns {string}
 */
function decodeQuotedPrintable(value, charset) {
  const decode = byteDecoder(charset);
  return value
    .replace(/=[ \t]*$/, '')
    .replace(/(?:=[0-9A-Fa-f]{2})+/g, (run) =>
      decode(Uint8Array.from(run.slice(1).split('='), (hex) => parseInt(hex, 16))));
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
 * labels. Decoded here rather than by TextDecoder: Node 20's windows-1252
 * is plain Latin-1 and turns 0x80 into a control character
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
