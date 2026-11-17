/**
 * iCalendar content lines (RFC 5545 3.1), for the few places that read an
 * object's text without ical.js: ical.js refuses a whole object for one
 * malformed value, and free/busy keeps what it can read of a stored
 * VFREEBUSY (src/tools/shared/freebusy.js).
 *
 * Linear in the text.
 */

/**
 * The logical lines of a text: split at CRLF, LF or a lone CR, and a line
 * that starts with a space or a tab continued onto the one before (folding).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function unfoldLines(text) {
  const lines = [];
  for (const physical of text.split(/\r\n|\r|\n/)) {
    if ((physical.startsWith(' ') || physical.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += physical.slice(1);
    } else {
      lines.push(physical);
    }
  }
  return lines;
}

const NAME = /^[A-Za-z0-9-]+$/;

/**
 * One content line: name *(";" param) ":" value, where a param is
 * name "=" param-value *("," param-value) and a param-value may be a
 * quoted-string, inside which ";", ":" and "," are text. The value is what
 * follows the first colon outside quotes.
 *
 * @param {string} line - a logical line (unfoldLines)
 * @returns {{name: string, params: Map<string, string[]>, value: string}|null}
 *   name and parameter names upper-cased; null for a line that is not a
 *   content line
 */
export function parseContentLine(line) {
  let at = 0;
  const token = () => {
    const from = at;
    while (at < line.length && /[A-Za-z0-9-]/.test(line[at])) at += 1;
    return line.slice(from, at);
  };
  const name = token();
  if (!NAME.test(name)) return null;
  const params = new Map();
  while (line[at] === ';') {
    at += 1;
    const param = token();
    if (!NAME.test(param) || line[at] !== '=') return null;
    const values = [];
    do {
      at += 1;
      if (line[at] === '"') {
        const close = line.indexOf('"', at + 1);
        if (close === -1) return null;
        values.push(line.slice(at + 1, close));
        at = close + 1;
      } else {
        const from = at;
        while (at < line.length && !'";:,'.includes(line[at])) at += 1;
        values.push(line.slice(from, at));
      }
    } while (line[at] === ',');
    params.set(param.toUpperCase(), values);
  }
  if (line[at] !== ':') return null;
  return { name: name.toUpperCase(), params, value: line.slice(at + 1) };
}
