import { z } from 'zod';
import ICAL from 'ical.js';
import {
  cancelOccurrences, restoreOccurrences, isUpdateFieldsError, expandOccurrences, createRecurrenceBudget,
} from 'tsdav-utils';
import { ValidationError } from '../../error-handler.js';
import { formatSuccess } from '../../formatters.js';
import { describeOccurrenceEdit, seriesNames } from '../../occurrence-names.js';

/**
 * Cancelling and restoring single occurrences of a recurring event or todo,
 * for update_event and update_todo.
 *
 * Since tsdav-utils 0.7.0 an EXDATE written as a field is the COMPLETE list:
 * a model that writes one date to cancel one more occurrence brings back every
 * occurrence cancelled before (#126). So the update tools do not take EXDATE
 * (or RDATE) in `fields` at all; an occurrence is cancelled or restored by
 * name, through tsdav-utils' cancelOccurrences/restoreOccurrences, which add
 * to and take from the list and nothing else:
 *
 *  - cancel_occurrences: each is excluded with an EXDATE in the series' own
 *    form, and its override (a changed version of that occurrence) goes too,
 *    so nothing is left that applies to nothing;
 *  - restore_occurrences: the EXDATE naming each goes, whatever zone or line
 *    it is stored on; a whole-day EXDATE of a timed series brings back only
 *    the occurrence named, the others of that day stay excluded.
 *
 * Names are original starts, as the listings show them (src/occurrence-names.js).
 * They are matched by tsdav-utils without reading a time in the host's zone:
 * cancelOccurrences takes a time without a zone only as the series' own wall
 * clock, and on a UTC series refuses it instead of cancelling the occurrence
 * an hour off (the 'local' reading of floating times the field writes use
 * would do exactly that on a Berlin host).
 *
 * Order within one call: the names refer to the series as it is before the
 * call. Restores are applied first, then cancels, then the fields and dates.
 * So a move in the same call takes the new exclusions along, and an
 * exclusion a new RRULE would leave naming no occurrence can be restored in
 * the same call as the RRULE.
 */

/** one occurrence name, as the listings show it */
// A listing marks a date that excludes a whole day of a timed series as
// "2026-10-06 (whole day)"; that text, copied whole, is the date.
const occurrenceName = z.string().trim()
  .transform((name) => name.replace(/\s*\(whole day\)$/i, ''))
  .pipe(z.string().min(1, 'an occurrence is named by its original start, e.g. "2026-12-24T09:00:00"'));

/** schema of the two parameters, for the update tools' zod objects */
export const occurrenceEditSchema = {
  cancel_occurrences: z.array(occurrenceName).optional(),
  restore_occurrences: z.array(occurrenceName).optional(),
};

/**
 * The superRefine part shared by update_event and update_todo: the lists of
 * dates are not fields. (One occurrence named in both lists is refused once
 * the series is known, by the occurrence it names; see editOccurrences.)
 *
 * @param {Object} data - the parsed arguments
 * @param {z.RefinementCtx} ctx
 * @param {string} tool - the tool's name, for the messages
 */
export function refineOccurrenceEdits(data, ctx, tool) {
  if (data.fields && 'EXDATE' in data.fields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields', 'EXDATE'],
      message: `EXDATE is not set through fields: written there it replaces every exclusion already in the series. ` +
        `Cancel occurrences with cancel_occurrences and bring them back with restore_occurrences, ` +
        `each named by its original start as ${SOURCES[tool === 'update_todo' ? 'vtodo' : 'vevent']} list it`,
    });
  }
  if (data.fields && 'RDATE' in data.fields) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['fields', 'RDATE'],
      message: `RDATE is not set through fields: written there it replaces every extra date already in the series. ` +
        `To cancel an occurrence use cancel_occurrences; to add or remove extra dates of a series, ` +
        `fetch it with ${tool === 'update_todo' ? 'todo_multi_get' : 'calendar_multi_get'} and send the edited object with ${tool}_raw`,
    });
  }
}

/** the codes of a refusal that is about the names given */
const NAME_REFUSALS = new Set([
  'UNKNOWN_OCCURRENCE', 'UNMATCHED_EXDATE', 'NOT_IN_LIST',
  'ZONE_MISMATCH', 'VALUE_TYPE_MISMATCH', 'INVALID_VALUE',
]);

const EDITS = { cancel_occurrences: cancelOccurrences, restore_occurrences: restoreOccurrences };

/** where a model finds the names, per component type */
const SOURCES = {
  vevent: 'calendar_query, list_events or calendar_multi_get',
  vtodo: 'todo_query, list_todos or todo_multi_get',
};

/** the master of an object and what it excludes, named; null if unreadable */
function seriesOf(data, type) {
  try {
    const calendar = new ICAL.Component(ICAL.parse(data));
    const all = calendar.getAllSubcomponents(type);
    const master = all.find((c) => !c.hasProperty('recurrence-id'));
    if (!master) return null;
    return seriesNames(master, all.filter((c) => c !== master && c.hasProperty('recurrence-id')), type);
  } catch {
    return null;
  }
}

/** the original starts of the occurrences on the day a name gives, in the series' form */
function occurrencesThatDay(data, name, type) {
  const day = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(name);
  if (!day) return [];
  const date = `${day[1]}-${day[2]}-${day[3]}`;
  const at = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(at)) return [];
  try {
    const { occurrences } = expandOccurrences(data, {
      budget: createRecurrenceBudget(), type,
      // a day on any wall clock lies within a day either side of the UTC day
      from: new Date(at - 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      until: new Date(at + 2 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
    return occurrences.map((o) => o.recurrenceId.value).filter((value) => value.startsWith(date));
  } catch {
    return [];
  }
}

/**
 * Turn a refusal of cancelOccurrences/restoreOccurrences into the error the
 * client gets.
 *
 * A refusal about the names given is composed here, in dav-mcp's terms only:
 * which names, why (no occurrence — with the ones that day; not cancelled —
 * with the ones that are; not in the series' form), and the one remedy, to
 * use the name exactly as the listings show it. The library's own message
 * names its functions, a remedy of its own and values in the compact iCalendar
 * form, so it is not passed on for these. The names at fault are found by
 * trying each on its own. Any other refusal is the library's message as a
 * ValidationError; anything else a failure of the library, passed on as it is.
 *
 * @param {Error} error
 * @param {'cancel_occurrences'|'restore_occurrences'} parameter
 * @param {{data: string, names: string[], type: 'vevent'|'vtodo'}} call - the object
 *   the edit was applied to, the names given, the component type
 */
export function explainOccurrenceRefusal(error, parameter, { data, names, type }) {
  if (!isUpdateFieldsError(error)) return error;
  const details = { code: error.code, remedy: error.remedy, parameter };
  if (!NAME_REFUSALS.has(error.code)) {
    const message = error.message.replace(/\.$/, '')
      .replace(/\bcancelOccurrences\b/g, 'cancel_occurrences')
      .replace(/\brestoreOccurrences\b/g, 'restore_occurrences');
    return new ValidationError(`${parameter}: ${message}`, details);
  }

  const series = seriesOf(data, type);
  const refused = names.map((name) => {
    try {
      EDITS[parameter](data, [name], { type });
      return null;
    } catch (each) {
      return isUpdateFieldsError(each) && NAME_REFUSALS.has(each.code) ? { name, code: each.code } : null;
    }
  }).filter(Boolean);
  if (!refused.length) refused.push({ name: names.join(', '), code: error.code });

  const reasons = refused.map(({ name, code }) => {
    if (code === 'NOT_IN_LIST') {
      // the values as restore_occurrences takes them, quoted: copyable
      const cancelled = (series?.exclusions ?? []).map(({ text }) => `"${text}"`);
      return `"${name}" is not cancelled (${cancelled.length ? `cancelled are: ${cancelled.slice(0, 10).join(', ')}${cancelled.length > 10 ? ', ...' : ''}` : 'nothing is cancelled'})`;
    }
    if (code === 'UNKNOWN_OCCURRENCE' || code === 'UNMATCHED_EXDATE') {
      const thatDay = occurrencesThatDay(data, name, type);
      return `"${name}" is no occurrence of this series${thatDay.length ? ` (that day it has ${thatDay.map((id) => `"${id}"`).join(', ')})` : ''}`;
    }
    return `"${name}" is not an occurrence name of this series`;
  });
  const form = series?.naming
    ? ` Occurrences are named by their original start as ${series.naming.describe}` +
      ` (e.g. "${series.naming.name(series.naming.master.getFirstPropertyValue('dtstart'), series.naming.tzid).text}").`
    : '';
  const listed = parameter === 'restore_occurrences' ? '"Cancelled occurrences"' : '"Occurrence ID"';
  return new ValidationError(
    `${parameter}: ${reasons.join('; ')}.${form} Use the name exactly as ${SOURCES[type]} list it (${listed}), and call again.`,
    { ...details, names: refused.map(({ name }) => name) },
  );
}

/**
 * The key a name gives an occurrence: its instant where it names one (with
 * Z or an offset, or a wall clock in the series' zone), else its text — so
 * "2026-12-17T10:00:00" and "2026-12-17T09:00:00Z" on a Berlin series are
 * the same occurrence.
 */
function occurrenceKey(name, naming) {
  const date = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(name);
  if (date) return `D:${date[1]}-${date[2]}-${date[3]}`;
  const compact = name.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/, '$1-$2-$3T$4:$5:$6');
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(compact)) {
    const at = Date.parse(compact);
    return Number.isNaN(at) ? `T:${name}` : `I:${at}`;
  }
  const wall = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(compact)
    ? (compact.length === 16 ? `${compact}:00` : compact) : null;
  const at = wall && naming.instantOfWall(wall);
  return at !== null && at !== undefined && wall ? `I:${at}` : `T:${wall ?? name}`;
}

/** names that are in both lists, compared by the occurrence they name */
function sameOccurrences(cancel, restore, naming) {
  const cancelled = new Set(cancel.map((name) => occurrenceKey(name, naming)));
  return restore.filter((name) => cancelled.has(occurrenceKey(name, naming)));
}

/**
 * A field write the library refused because the series would keep an
 * exclusion or override naming no occurrence (a new RRULE, say). Its message
 * suggests a complete EXDATE list, which update_event/update_todo do not
 * take; the working paths are restore_occurrences in the same call, or the
 * raw tool. Any other error is returned as it is.
 *
 * @param {Error} error
 * @param {'vevent'|'vtodo'} type
 */
export function explainFieldRefusal(error, type) {
  if (!isUpdateFieldsError(error, 'ORPHANED_EXCEPTIONS')) return error;
  const [tool, fetch] = type === 'vtodo' ? ['update_todo', 'todo_multi_get'] : ['update_event', 'calendar_multi_get'];
  const reason = error.message.replace(/\.$/, '').split(/\. (?=Give |Leave |Or )/)[0];
  return new ValidationError(
    `${reason}. Bring those occurrences back with restore_occurrences in this same ${tool} call ` +
    `(restores are applied before the fields), or cancel them first; to rewrite the series ` +
    `with its exclusions, fetch it with ${fetch} and send the edited object with ${tool}_raw.`,
    { code: error.code, remedy: error.remedy, ...(error.property && { property: error.property }) },
  );
}

/**
 * Apply restore_occurrences, then cancel_occurrences, to a calendar object.
 *
 * @param {string} data - the object as fetched
 * @param {{cancel?: string[], restore?: string[]}} names
 * @param {'vevent'|'vtodo'} type
 * @returns {{data: string, change: Object|null}} the edited object, and what
 *   changed for the reply (null when nothing was asked)
 */
export function editOccurrences(data, { cancel = [], restore = [] }, type) {
  if (!cancel.length && !restore.length) return { data, change: null };
  const series = seriesOf(data, type);
  if (!series) {
    // the library would take the start of a single event as its one
    // occurrence and exclude it: an event that never happens, not a cancel
    const [noun, remove] = type === 'vtodo' ? ['todo', 'delete_todo'] : ['event', 'delete_event'];
    throw new ValidationError(
      `${cancel.length ? 'cancel_occurrences' : 'restore_occurrences'}: this ${noun} does not recur ` +
      `(no RRULE or RDATE), so it has no occurrences to cancel or restore. To remove it, use ${remove}; ` +
      `to mark it cancelled, set fields.STATUS "CANCELLED".`,
      { code: 'NOT_RECURRING', parameter: cancel.length ? 'cancel_occurrences' : 'restore_occurrences' },
    );
  }
  const both = sameOccurrences(cancel, restore, series.naming);
  if (both.length) {
    throw new ValidationError(
      `restore_occurrences: ${both.map((name) => `"${name}"`).join(', ')} name${both.length === 1 ? 's' : ''} ` +
      `an occurrence that cancel_occurrences names too; name each occurrence in one of them`,
      { code: 'CANCEL_AND_RESTORE', names: both },
    );
  }
  let edited = data;
  if (restore.length) {
    try {
      edited = restoreOccurrences(edited, restore, { type });
    } catch (error) {
      throw explainOccurrenceRefusal(error, 'restore_occurrences', { data: edited, names: restore, type });
    }
  }
  if (cancel.length) {
    try {
      edited = cancelOccurrences(edited, cancel, { type });
    } catch (error) {
      throw explainOccurrenceRefusal(error, 'cancel_occurrences', { data: edited, names: cancel, type });
    }
  }
  return { data: edited, change: describeOccurrenceEdit(data, edited, type) };
}

/**
 * The reply for an update that writes nothing: the object is left as it is,
 * so its etag stays valid and no new one is reported.
 *
 * @param {'Event'|'Todo'} noun
 * @param {string} why
 * @param {Object|null} [change] - what editOccurrences found, if it ran
 */
export function notChanged(noun, why, change = null) {
  return formatSuccess(`${noun} not changed`, {
    written: false,
    message: `Not written: ${why}; nothing was sent to the server`,
    ...(change && { occurrences: change }),
  });
}
