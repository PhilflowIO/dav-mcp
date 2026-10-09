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
 * What is counted is an upper bound on the passes ical.js makes over a line,
 * not a copy of its tokenizer (quotes, multi-values and line endings are
 * where a copy drifts from the original and lets a line through). ical.js
 * reads parameters only when the line's first `;` comes before its first
 * `:`, or the line has no `:`. Then each pass of its parameter loop consumes
 * a `=` it has not used yet, and each pass after the first a `;` it has not
 * used yet, so it makes at most min(`=` count, `;` count + 1) passes over
 * the rest of the line — whatever is quoted. Counted on the unfolded line,
 * from that first `;` to the end of the line.
 *
 * @param {string|{data: string}} object - the text, or an object holding it
 * @throws {ValidationError} TOO_MANY_PARAMETERS
 */
export function assertParseBounded(object) {
  const text = typeof object === 'string' ? object : object?.data;
  if (typeof text !== 'string') return;
  let start = 0;
  while (start < text.length) start = checkLine(text, start);
}

const LF = 10;
const SPACE = 32;
const TAB = 9;
const COLON = 58;
const SEMICOLON = 59;
const EQUALS = 61;

/** whether the line break at `i` is a fold: the next line continues it */
function foldAt(text, i) {
  const next = text.charCodeAt(i + 1);
  return next === SPACE || next === TAB;
}

/**
 * Check the content line at `start`; throws when ical.js would pass over it
 * more than MAX_PARAMETERS times. Returns where the next line starts.
 */
function checkLine(text, start) {
  let parametersAt = -1; // the first ";", when it comes before any ":"
  let equals = 0;
  let semicolons = 0;
  for (let i = start; i < text.length; i++) {
    const char = text.charCodeAt(i);
    if (char === LF) {
      if (!foldAt(text, i)) return i + 1;
      i++; // the space or tab that marks the fold
    } else if (parametersAt === -1) {
      if (char === COLON) return nextLine(text, i);
      if (char === SEMICOLON) {
        parametersAt = i;
        semicolons = 1;
      }
    } else if (char === SEMICOLON || char === EQUALS) {
      if (char === SEMICOLON) semicolons++;
      else equals++;
      if (Math.min(equals, semicolons + 1) > MAX_PARAMETERS) {
        throw tooManyParameters(propertyName(text, start, parametersAt));
      }
    }
  }
  return text.length;
}

/** the start of the content line after the one `from` lies in */
function nextLine(text, from) {
  let i = from;
  for (;;) {
    const lineBreak = text.indexOf('\n', i);
    if (lineBreak === -1) return text.length;
    if (!foldAt(text, lineBreak)) return lineBreak + 1;
    i = lineBreak + 1;
  }
}

/** the name as written, unfolded, cut short: no value, no personal data */
function propertyName(text, start, end) {
  return text.slice(start, Math.min(end, start + 200)).replace(/\r?\n[ \t]/g, '').slice(0, 64);
}

/**
 * The refusal of a property over the bound — here, and in the vCard
 * normalizer, which counts the same parameters on its own way to ical.js.
 *
 * @param {string} name - its name as written; only letters, digits, "." and
 *   "-" of it, at most 32, are repeated
 * @returns {ValidationError}
 */
export function tooManyParameters(name) {
  // the name is written by whoever wrote the object and ends up in the
  // model's context: keep it to what a property name is made of, and short
  const property = name.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 32) || 'unnamed';
  return new ValidationError(
    `The ${property} property has more than ${MAX_PARAMETERS} parameters. dav-mcp does not read a vCard or ` +
    `calendar object like that: no real one has more than a few dozen, and parsing one takes time that grows ` +
    `with the number of parameters times the length of the line (half a million stall the server for seconds). ` +
    `It can still be deleted, or replaced whole with update_contact_raw, update_event_raw or update_todo_raw.`,
    { code: 'TOO_MANY_PARAMETERS', property, limit: MAX_PARAMETERS },
  );
}

/**
 * Why an object could not be parsed, for the caller: the bound, or that it
 * is not valid at all. Never the parser's own message, which quotes the
 * offending line (personal data).
 *
 * @param {unknown} error - what parsing threw
 * @param {string} format - 'iCalendar' or 'vCard'
 * @returns {string}
 */
export function unreadableReason(error, format) {
  if (error?.details?.code === 'TOO_MANY_PARAMETERS') {
    return `its ${error.details.property} property has more than ${error.details.limit} parameters`;
  }
  return `it is not valid ${format}`;
}
