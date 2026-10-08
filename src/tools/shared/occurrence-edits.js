import { z } from 'zod';
import { cancelOccurrences, restoreOccurrences, isUpdateFieldsError } from 'tsdav-utils';
import { ValidationError } from '../../error-handler.js';
import { formatSuccess } from '../../formatters.js';
import { describeOccurrenceEdit } from '../../occurrence-names.js';

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
const occurrenceName = z.string().trim().min(1, 'an occurrence is named by its original start, e.g. "2026-12-24T09:00:00"');

/** schema of the two parameters, for the update tools' zod objects */
export const occurrenceEditSchema = {
  cancel_occurrences: z.array(occurrenceName).optional(),
  restore_occurrences: z.array(occurrenceName).optional(),
};

/**
 * The superRefine part shared by update_event and update_todo: the lists of
 * dates are not fields, and one occurrence is not cancelled and restored at
 * once.
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
        `each named by its original start as ${tool === 'update_todo' ? 'todo_query' : 'calendar_query'} lists it`,
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
  const cancel = new Set(data.cancel_occurrences ?? []);
  const both = (data.restore_occurrences ?? []).filter((name) => cancel.has(name));
  if (both.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['restore_occurrences'],
      message: `${both.join(', ')} is both in cancel_occurrences and restore_occurrences; name each occurrence in one of them`,
    });
  }
}

/** the codes of a refusal that is about the names given */
const NAME_REFUSALS = new Set([
  'UNKNOWN_OCCURRENCE', 'UNMATCHED_EXDATE', 'NOT_IN_LIST',
  'ZONE_MISMATCH', 'VALUE_TYPE_MISMATCH', 'INVALID_VALUE',
]);

/**
 * Turn a refusal of cancelOccurrences/restoreOccurrences into the error the
 * client gets: one about a name given becomes a ValidationError saying to use
 * the occurrence's start exactly as listed, in this parameter; any other
 * refusal is the library's message as a ValidationError; anything else a
 * failure of the library, passed on as it is.
 *
 * @param {Error} error
 * @param {'cancel_occurrences'|'restore_occurrences'} parameter
 * @param {string} listing - the tool that lists the names
 */
export function explainOccurrenceRefusal(error, parameter, listing) {
  if (!isUpdateFieldsError(error)) return error;
  // the library names its own functions; the caller knows the parameters
  const message = error.message.replace(/\.$/, '')
    .replace(/\bcancelOccurrences\b/g, 'cancel_occurrences')
    .replace(/\brestoreOccurrences\b/g, 'restore_occurrences');
  const details = { code: error.code, remedy: error.remedy, parameter };
  if (NAME_REFUSALS.has(error.code)) {
    const what = parameter === 'restore_occurrences'
      ? `a cancelled occurrence exactly as ${listing} lists it under "Cancelled occurrences"`
      : `the occurrence's original start exactly as ${listing} lists it ("Occurrence ID")`;
    return new ValidationError(`${parameter}: ${message}. Use ${what}, and call again.`, details);
  }
  return new ValidationError(`${parameter}: ${message}`, details);
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
  const listing = type === 'vtodo' ? 'todo_query' : 'calendar_query';
  let edited = data;
  if (restore.length) {
    try {
      edited = restoreOccurrences(edited, restore, { type });
    } catch (error) {
      throw explainOccurrenceRefusal(error, 'restore_occurrences', listing);
    }
  }
  if (cancel.length) {
    try {
      edited = cancelOccurrences(edited, cancel, { type });
    } catch (error) {
      throw explainOccurrenceRefusal(error, 'cancel_occurrences', listing);
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
