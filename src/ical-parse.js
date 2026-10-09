import ICAL from 'ical.js';
import { ValidationError } from './error-handler.js';

/**
 * The most parameters dav-mcp reads on one property (content line).
 *
 * ical.js reads a parameter list one `name=value` at a time and, for each,
 * searches the rest of the line for the colon that ends the list, so a line
 * costs (parameters x line length): a 1 MB line of 500 000 parameters took
 * 11 s in ICAL.parse (issue #109), a stall of the whole server, as parsing
 * is synchronous. Measured on ical.js 2.2.1 (a line of the given size, its
 * parameters spread over it):
 *
 *   parameters   1 MB line   10 MB line
 *          100        3 ms        13 ms
 *        1 000       11 ms        81 ms
 *       10 000       40 ms       675 ms
 *       50 000      212 ms     3 686 ms
 *
 * At 1 000 the parameter search costs no more than reading the same bytes
 * does anyway (a 1 MB photo: ~17 ms), and no real data comes near it: RFC
 * 6350 and RFC 5545 define about 15 parameters per property, real cards and
 * events carry fewer than ten (`TEL;TYPE=CELL;TYPE=VOICE;TYPE=pref`). The
 * same cost and the same bound hold for vCards and iCalendar, as both go
 * through this one parser.
 */
export const MAX_PARAMETERS = 1000;

/**
 * Parse vCard or iCalendar text with ical.js, after checking that no
 * property carries more than MAX_PARAMETERS parameters. Every parse of text
 * in dav-mcp goes through here.
 *
 * @param {string} text
 * @returns {Array} the jCal / jCard ICAL.parse returns
 * @throws {ValidationError} TOO_MANY_PARAMETERS, before any parsing
 */
export function parseICal(text) {
  assertParseBounded(text);
  return ICAL.parse(text);
}

/**
 * Refuse text with a property over MAX_PARAMETERS parameters, in time linear
 * in the text. For text handed to a parser outside dav-mcp (tsdav-utils'
 * updateFields and occurrence edits), which runs ical.js on it as well.
 *
 * The parameter list is read the way ical.js reads it, so nothing it would
 * iterate over goes uncounted: the line is unfolded (a line break followed
 * by a space or tab continues it), the list ends at the first colon outside
 * a quoted value, a quoted value starts only right after `=` (anywhere else
 * a quote is text to ical.js) and runs to the next quote. Each `;` before
 * that colon is a parameter. Semicolons in the value are not counted.
 *
 * @param {string|{data: string}} object - the text, or an object holding it
 * @throws {ValidationError} TOO_MANY_PARAMETERS
 */
export function assertParseBounded(object) {
  const text = typeof object === 'string' ? object : object?.data;
  if (typeof text !== 'string') return;
  let lineStart = 0;
  while (lineStart < text.length) {
    const end = scanParameters(text, lineStart);
    lineStart = endOfLine(text, end);
  }
}

/** whether text[i] is a line break that the next line continues (a fold) */
function foldAt(text, i) {
  const next = text[i + 1];
  return next === ' ' || next === '\t';
}

/**
 * Count the parameters of the content line at `start`; throws when over the
 * bound. Returns where the scan stopped: the colon that ended the parameter
 * list, or the end of the line.
 */
function scanParameters(text, start) {
  let count = 0;
  let nameEnd = -1;
  let quoted = false;
  let previous = '';
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (char === '\n') {
      if (!foldAt(text, i)) return i;
      i++; // the space or tab that marks the fold
      continue;
    }
    if (char === '\r') continue;
    if (quoted) {
      if (char === '"') quoted = false;
    } else if (char === '"' && previous === '=') {
      quoted = true;
    } else if (char === ':') {
      return i;
    } else if (char === ';') {
      if (nameEnd === -1) nameEnd = i;
      if (++count > MAX_PARAMETERS) throw tooManyParameters(text, start, nameEnd);
    }
    previous = char;
  }
  return text.length;
}

/** the start of the content line after the one `from` lies in */
function endOfLine(text, from) {
  let i = from;
  for (;;) {
    const lineBreak = text.indexOf('\n', i);
    if (lineBreak === -1) return text.length;
    if (!foldAt(text, lineBreak)) return lineBreak + 1;
    i = lineBreak + 1;
  }
}

function tooManyParameters(text, start, nameEnd) {
  // the name as written, unfolded, cut short: no value, no personal data
  const property = text.slice(start, Math.min(nameEnd, start + 200)).replace(/\r?\n[ \t]/g, '').slice(0, 64);
  return new ValidationError(
    `The ${property} property has more than ${MAX_PARAMETERS} parameters. dav-mcp does not read a vCard or ` +
    `calendar object like that: no real one has more than a few dozen, and parsing one takes time that grows ` +
    `with the number of parameters times the length of the line (half a million stall the server for seconds). ` +
    `It can still be deleted, or replaced whole with update_contact_raw, update_event_raw or update_todo_raw.`,
    { code: 'TOO_MANY_PARAMETERS', property, limit: MAX_PARAMETERS },
  );
}
