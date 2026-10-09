import ICAL from 'ical.js';
import { seriesMaster, isUpdateFieldsError } from 'tsdav-utils';
import { ValidationError, CalDAVError, CardDAVError, MCP_ERROR_CODES } from './error-handler.js';
import { listedDates, wholeDayExclusions } from './occurrence-names.js';
import { relateSeries, seriesOccurrences, spanOf, touchesRange } from './occurrences.js';

/**
 * Which component of a calendar object a reader shows.
 *
 * A recurring event or todo is stored as one calendar object holding a series
 * master plus override components for single instances: same UID, plus a
 * RECURRENCE-ID (RFC 5545 3.8.4.4), in whatever order the server chose. The
 * master is the one without RECURRENCE-ID. Writes go through tsdav-utils'
 * updateFields, which edits exactly that component (its seriesMaster); every
 * place in dav-mcp that selects a component of a parsed object goes through
 * here, so what is shown, filtered on DUE and counted as busy is the
 * component that was written — never "the first one in the file". The
 * query tools' text filters and sort key read the same selection (see
 * shownEvent and src/tools/shared/query-objects.js).
 *
 * Unlike seriesMaster, this never throws. A read must not fail because a
 * server stores detached instances without their master (as it does for an
 * attendee invited to single occurrences of a series only):
 *
 *  - no component of the type: null.
 *  - a master: it, with every RECURRENCE-ID sibling in `overrides`, ready to
 *    be related to it (ICAL.Event#relateException).
 *  - no master, one instance: that instance (what updateFields edits too).
 *  - no master, several instances: there is nothing to say which one is "the"
 *    object, and updateFields refuses to edit it. The reader falls back to
 *    the FIRST instance in document order as `master`, and lists every
 *    instance (that first one included) in `detached`, so a reader that cares
 *    about all of them — free/busy — can treat each as an occurrence of its
 *    own. `overrides` is empty: there is no series to override.
 *
 * A write that needs the component itself (to check or drop a property after
 * updateFields) should call seriesMaster directly instead: its throw on
 * several detached instances is the same error updateFields raises.
 *
 * @param {ICAL.Component} calendar - the parsed VCALENDAR
 * @param {'vevent'|'vtodo'|'vjournal'} type - component type to look at
 * @returns {{
 *   master: ICAL.Component,
 *   overrides: ICAL.Component[],
 *   detached: ICAL.Component[],
 * } | null}
 */
export function readSeries(calendar, type) {
  const all = calendar.getAllSubcomponents(type);
  if (all.length === 0) return null;

  let master;
  try {
    master = seriesMaster(calendar, type);
  } catch {
    // several instances and no master: see above
    return { master: all[0], overrides: [], detached: all };
  }

  if (master.hasProperty('recurrence-id')) {
    // a lone detached instance
    return { master, overrides: [], detached: [master] };
  }
  return {
    master,
    overrides: all.filter((c) => c !== master && c.hasProperty('recurrence-id')),
    detached: [],
  };
}

/**
 * A queried time range as ms instants, or null when there is none. Goes
 * through Date so every form the schema accepts — with or without
 * milliseconds, "Z" or a "+02:00" offset — lands on the same instant.
 */
function msRange(timeRange) {
  if (!timeRange?.start || !timeRange?.end) return null;
  const start = new Date(timeRange.start).getTime();
  const end = new Date(timeRange.end).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

/**
 * The event as a reader shows it — the one place that decides, so the event
 * list and calendar_query's SUMMARY/LOCATION filters read the same thing.
 *
 *  - No time range: the series master (readSeries). A search without a range
 *    therefore only searches the series, not its renamed occurrences.
 *  - A time range and a recurring series: the earliest occurrence that
 *    touches the range once its overrides apply (src/occurrences.js — the
 *    same test free/busy uses, so a meeting running into the range is in
 *    it) — the earliest one `matches` accepts, when a search passes it. An
 *    occurrence moved into the range from outside it counts, one moved out
 *    of it does not, and it is listed with its own title, place and date.
 *    A cancelled occurrence is still an occurrence; the display says so.
 *  - A time range and several detached instances without a master: the
 *    first instance touching the range (that `matches` accepts, if given),
 *    else the first in document order.
 *
 * @param {ICAL.Component} calendar - the parsed VCALENDAR
 * @param {{start: string, end: string}|null} timeRange
 * @param {((vevent: ICAL.Component) => boolean)|null} [matches] - the search
 * @param {Object} [budget] - the tool call's expansion budget (requestBudget);
 *   a fresh one when not given
 * @returns {{
 *   vevent: ICAL.Component, event: ICAL.Event,
 *   occurrence: Object|null, item: ICAL.Event,
 *   outsideRange: boolean, expansionTruncated: boolean,
 * } | null}
 */
export function shownEvent(calendar, timeRange = null, matches = null, budget = undefined) {
  const series = readSeries(calendar, 'vevent');
  if (!series) return null;
  const range = msRange(timeRange);

  let vevent = series.master;
  if (range && series.detached.length > 1) {
    const inRange = series.detached.filter((instance) => touches(new ICAL.Event(instance), range));
    vevent = inRange.find((instance) => !matches || matches(instance)) ?? inRange[0] ?? vevent;
  }
  const related = relateSeries(vevent, series.overrides);
  const { event } = related;

  let occurrence = null;
  let outsideRange = false;
  let expansionTruncated = false;
  let expansionReason = null;
  if (range && event.isRecurring()) {
    const filter = matches ? (o) => matches(o.item.component) : null;
    const result = seriesOccurrences(related, range, { filter, first: true, budget });
    occurrence = result.occurrences[0] ?? null;
    // capped: the occurrence found may not be the earliest, or none was found
    expansionTruncated = result.truncated;
    expansionReason = result.reason ?? null;
    outsideRange = !occurrence && !result.truncated;
  }

  return {
    vevent, event, occurrence,
    item: occurrence ? occurrence.item : event,
    outsideRange, expansionTruncated, expansionReason,
  };
}

function touches(event, range) {
  if (!event.startDate) return false;
  const { start, end } = spanOf({ startDate: event.startDate, endDate: event.endDate, item: event });
  return touchesRange(start, end, range);
}

/**
 * Does an event or occurrence occupy time? TRANSP:TRANSPARENT is the RFC 5545
 * way of saying "this does not block me", and a cancelled one does not
 * either. Values are case-insensitive. Read on the component itself: an
 * override is a full component, so one without STATUS of a cancelled series
 * is not cancelled.
 *
 * @param {ICAL.Component} vevent
 * @returns {boolean}
 */
export function blocksTime(vevent) {
  const value = (name) => String(vevent.getFirstPropertyValue(name) ?? '').toUpperCase();
  return value('transp') !== 'TRANSPARENT' && value('status') !== 'CANCELLED';
}

/**
 * A todo's STATUS as shown and filtered on: upper-cased (RFC 5545 values are
 * case-insensitive), NEEDS-ACTION when absent — RFC 5545 3.8.1.11 gives no
 * default, but a todo nobody marked is pending.
 *
 * @param {ICAL.Component} vtodo
 * @returns {string}
 */
export function todoStatus(vtodo) {
  return String(vtodo.getFirstPropertyValue('status') || 'NEEDS-ACTION').toUpperCase();
}

const KINDS = {
  vevent: { noun: 'event', update: 'update_event', raw: 'update_event_raw', fetch: 'calendar_multi_get' },
  vtodo: { noun: 'todo', update: 'update_todo', raw: 'update_todo_raw', fetch: 'todo_multi_get' },
};

/**
 * Refuse a field update the object cannot take, before anything is written.
 *
 * A field update edits the series master. An object holding several
 * instances and no master has none, so updateFields throws — with a message
 * that knows nothing about the tools here and surfaces as an internal error.
 * This checks the object itself (readSeries, i.e. the same seriesMaster rule)
 * and answers with a validation error naming the route that does work:
 * fetch the whole object, edit the instance meant, write it back raw.
 *
 * An object that does not parse is left to the write, which reports that.
 *
 * @param {string|{data: string}} object - the calendar object as fetched
 * @param {'vevent'|'vtodo'} type
 * @throws {ValidationError} when there are several instances and no master
 */
export function assertFieldUpdatable(object, type) {
  let calendar;
  try {
    calendar = new ICAL.Component(ICAL.parse(typeof object === 'string' ? object : object.data));
  } catch {
    return;
  }
  const series = readSeries(calendar, type);
  if (!series || series.detached.length < 2) return;

  const { noun, update, raw, fetch } = KINDS[type];
  throw new ValidationError(
    `This ${noun} is stored as ${series.detached.length} single occurrences (each with a ` +
    `RECURRENCE-ID) and no series master, so ${update} cannot tell which one to change. ` +
    `Fetch it with ${fetch} (its Raw Data block holds the full iCalendar text and the etag), ` +
    `edit the ${type.toUpperCase()} of the occurrence you mean, and send the whole object ` +
    `with ${raw}.`
  );
}

/** The tools of each kind of object a write can be aimed at, vCards included */
const WRITE_TOOLS = {
  ...KINDS,
  vcard: { noun: 'contact', update: 'update_contact', raw: 'update_contact_raw', fetch: 'addressbook_multi_get' },
};

/** the field-update tool for a component type the object may hold instead */
const FIELD_TOOL = { VEVENT: 'update_event', VTODO: 'update_todo' };

/**
 * Codes for a call dav-mcp itself got wrong (an option or an argument of the
 * wrong shape). No input from the caller can cause or fix them, so they stay
 * internal errors.
 */
const OUR_MISTAKES = new Set(['INVALID_INPUT', 'INVALID_TYPE', 'INVALID_FLOATING_TIME', 'INVALID_ABSOLUTE_TIME']);

/** the parameter an event tool takes a property through, where it is not fields */
const EVENT_PARAMETER = { DTSTART: 'start_date', DTEND: 'end_date' };

/**
 * What to do with an object that holds no component of the tool's type, from
 * the types the library's message lists ("(it holds: VJOURNAL)"). The code
 * says what happened; the list is only read to name the right tool.
 */
function wrongTypeHint(message, { noun, update }) {
  const held = /\(it holds: ([A-Z, ]+)\)/.exec(message)?.[1].split(/,\s*/) ?? [];
  const tools = held.map((name) => FIELD_TOOL[name] ? `${FIELD_TOOL[name]} for its ${name}` : null)
    .filter(Boolean);
  const hint = `This object holds no ${noun}, so ${update} cannot change it.`;
  if (tools.length) return `${hint} Use ${tools.join(', or ')}.`;
  return held.length
    ? `${hint} dav-mcp has no field-update tool for ${held.join(', ')}.`
    : hint;
}

/**
 * The library's message in the terms of these tools. It names options and
 * functions of its own API — cancelOccurrences, a "replace" list mode,
 * absoluteTime "as-given" — that a tool caller cannot give; those are turned
 * into the parameters that do the same, or the sentence that offers them is
 * left out (the hint after it says what works).
 */
function inToolTerms(message, error, tools) {
  let text = message
    .replace(/\bcancelOccurrences\b/g, 'cancel_occurrences')
    .replace(/\brestoreOccurrences\b/g, 'restore_occurrences')
    .replace(/, which removes the override too/g, ', which removes its changed version (override) too')
    .replace(/, or leave absoluteTime "as-given"/g, '')
    // EXDATE and RDATE are no fields of the update tools; the hint says what is
    .replace(/: give (EXDATE|RDATE) in the same call/g, '')
    .replace(/Give RRULE, UNTIL and EXDATE explicitly in the same call/g,
      'Give RRULE and UNTIL explicitly in the same call (and the exclusions through restore_occurrences/cancel_occurrences)');
  // the remedy sentences of a refused rule change ask for a complete EXDATE
  // list, which these tools do not take: orphanHint says what works instead
  if (error.code === 'ORPHANED_EXCEPTIONS') {
    text = text.replace(/\.? ?(Give RRULE \(or RDATE\) in the same call|Give the complete EXDATE list)[\s\S]*$/, '');
  }
  return text.replace(/ ?\(list mode "replace"\)/g, '');
}

/** what works when a rule change would leave exclusions or overrides naming nothing */
function orphanHint({ update, raw, fetch }) {
  return `Give an RRULE (fields.RRULE) that keeps those occurrences, or bring back the exclusions that ` +
    `would name nothing with restore_occurrences in this same ${update} call (restores are applied ` +
    `before the fields). To move or remove a changed occurrence (override), fetch the object with ` +
    `${fetch} and send the edited whole with ${raw}.`;
}

/**
 * A move refused because a list of dates cannot follow it. EXDATE and RDATE
 * are no fields of the update tools, so the hint names what works: for
 * whole-day exclusions, bring each day back and cancel the occurrences it
 * held by their time, in the same call (the move then takes them along),
 * with the names spelled out; for extra dates, the raw tool.
 */
function listHint(error, object, tools) {
  const { update, raw, fetch } = tools;
  if (error.property === 'RDATE') {
    return `Extra dates (RDATE) are not edited by ${update}: fetch the object with ${fetch}, give each ` +
      `RDATE the time of day of the new start (or remove it), and send the whole object with ${raw}; ` +
      `then move the series.`;
  }
  const type = update === 'update_todo' ? 'vtodo' : 'vevent';
  const data = typeof object === 'string' ? object : object?.data;
  const days = data ? wholeDayExclusions(data, type) : [];
  const restore = days.map(({ date }) => `"${date}"`);
  const cancel = days.flatMap(({ occurrences }) => occurrences.map((name) => `"${name}"`));
  if (!restore.length) {
    return `Bring back the whole-day exclusions it names with restore_occurrences and cancel the ` +
      `occurrences of those days by their time with cancel_occurrences, in this same ${update} call ` +
      `with the move; the move then takes them along.`;
  }
  return `A whole-day exclusion cannot move by a time of day, but an exclusion of each occurrence can: ` +
    `in this same ${update} call with the move, give restore_occurrences [${restore.join(', ')}]` +
    `${cancel.length ? ` and cancel_occurrences [${cancel.join(', ')}]` : ''} (names as the series is now, ` +
    `added to any you give already); the move then takes them along.`;
}

/** The hint for a refusal, in this tool's terms, chosen by the library's remedy */
function remedyHint(error, type, tools, object) {
  const { update, raw, fetch } = tools;
  if (type && ['EXDATE', 'RDATE'].includes(error.property) && error.remedy === 'same-call') {
    return listHint(error, object, tools);
  }
  switch (error.remedy) {
    case 'same-call': {
      // the message names what to give (RRULE, UNTIL, EXDATE, RDATE);
      // `property` and `suggestion` make the example concrete
      const name = error.property ?? 'RRULE';
      const example = error.suggestion ? `fields.${name} "${error.suggestion}"` : `fields.${name}`;
      return `Give what it names in fields of this same ${update} call (e.g. ${example}).`;
    }
    case 'rewrite-object':
      return `To change a single occurrence, or to rewrite the whole object: fetch it with ` +
        `${fetch} (its Raw Data block holds the full text and the etag), edit it, and send ` +
        `the whole object with ${raw}.`;
    case 'fix-value': {
      if (!error.property) return '';
      const parameter = type === 'vevent' && EVENT_PARAMETER[error.property];
      return `Correct ${error.property}${parameter ? ` (${parameter})` : ''} and call ${update} again.`;
    }
    default:
      return '';
  }
}

/**
 * Turn what tsdav-utils' updateFields threw into the error the client gets.
 *
 * Every refusal is an UpdateFieldsError with a stable `code` and a `remedy`;
 * anything else is a failure of the library, passed on as it is. Refusals are
 * the caller's input meeting this object, so they become a ValidationError:
 * the library's message, which says why and often what to give instead (the
 * rule with the new start's weekday, say), plus how that remedy is spelled in
 * this server — fields of the same call, or the multi-get and raw tools.
 *
 * Two kinds of refusal are not the caller's to fix and are not reported as
 * such: a call dav-mcp made wrongly (an option or argument of the wrong shape)
 * stays an internal error, and a stored object that does not parse is a
 * CalDAV/CardDAV error — the object on the server is broken, not the input.
 *
 * @param {Error} error - what updateFields threw
 * @param {'vevent'|'vtodo'} [type] - the component the tool writes; none for a vCard
 * @param {string|{data: string}} [object] - what was written to, so a hint can
 *   name the occurrences concerned
 * @returns {Error} the error to throw
 */
export function explainWriteRefusal(error, type, object = null) {
  if (!isUpdateFieldsError(error)) return error;

  const tools = WRITE_TOOLS[type ?? 'vcard'];
  const message = inToolTerms(error.message.replace(/\.$/, ''), error, tools);

  if (OUR_MISTAKES.has(error.code)) {
    const fault = new Error(`dav-mcp called tsdav-utils wrongly (${error.code}): ${message}`, { cause: error });
    fault.code = MCP_ERROR_CODES.INTERNAL_ERROR;
    return fault;
  }
  if (error.code === 'INVALID_ICALENDAR') {
    const Broken = type ? CalDAVError : CardDAVError;
    return new Broken(
      `The stored ${tools.noun} cannot be parsed, so it was not changed (${message}). ` +
      `To repair it, fetch it with ${tools.fetch} and send a corrected object with ${tools.raw}.`,
      { code: error.code }
    );
  }

  const hint = error.code === 'COMPONENT_NOT_FOUND'
    ? wrongTypeHint(error.message, tools)
    : error.code === 'ORPHANED_EXCEPTIONS' && type
      ? orphanHint(tools)
      : remedyHint(error, type, tools, object);
  return new ValidationError(hint ? `${message}. ${hint}` : message, {
    code: error.code, remedy: error.remedy,
    ...(error.property && { property: error.property }),
    ...(error.suggestion && { suggestion: error.suggestion }),
  });
}

/**
 * What a field update did to a recurring series, for the reply.
 *
 * A new start moves the whole series: tsdav-utils rewrites a weekday the rule
 * restates and shifts every override, EXDATE and RDATE by the same distance.
 * The caller named one date; the model has to be able to tell the user what
 * else changed, so the reply lists it.
 *
 * @param {string|{data: string}} before - the object as fetched
 * @param {string} after - the object as written
 * @param {'vevent'|'vtodo'} type
 * @returns {null | {
 *   summary: string,
 *   dtstart?: {from: string, to: string},
 *   rrule?: {from: string|null, to: string|null},
 *   overrides_moved: number, exdates_moved: number, rdates_moved: number,
 * }} null when the object is no series or the write left its shape alone
 */
export function describeSeriesChange(before, after, type) {
  const read = (object) => {
    try {
      const calendar = new ICAL.Component(ICAL.parse(typeof object === 'string' ? object : object.data));
      return readSeries(calendar, type);
    } catch {
      return null;
    }
  };
  const [old, now] = [read(before), read(after)];
  if (!old || !now || old.detached.length || now.detached.length) return null;

  const isSeries = (series) => ['rrule', 'rdate'].some((name) => series.master.hasProperty(name));
  if (!isSeries(old) && !isSeries(now)) return null;

  const line = (component, name) => component.getFirstProperty(name)?.toICALString() ?? null;
  // compared by occurrence name in each series' own form (occurrence-names),
  // not by stored text or position: a list restated in another zone or order
  // moved nothing, and an override is matched by what it names
  const [was, is] = [listedDates(old.master, old.overrides), listedDates(now.master, now.overrides)];
  const gone = (key) => (was?.[key] ?? []).filter((name) => !(is?.[key] ?? []).includes(name)).length;

  const change = {
    overrides_moved: gone('overrides'),
    exdates_moved: gone('exdates'),
    rdates_moved: gone('rdates'),
  };
  const parts = [];
  const [startFrom, startTo] = [line(old.master, 'dtstart'), line(now.master, 'dtstart')];
  if (startFrom !== startTo) {
    change.dtstart = { from: startFrom, to: startTo };
    parts.push(`series start ${startFrom} -> ${startTo}`);
  }
  const [ruleFrom, ruleTo] = [line(old.master, 'rrule'), line(now.master, 'rrule')];
  if (ruleFrom !== ruleTo) {
    change.rrule = { from: ruleFrom, to: ruleTo };
    parts.push(`rule ${ruleFrom ?? '(none)'} -> ${ruleTo ?? '(none)'}`);
  }
  const moved = [
    [change.overrides_moved, 'changed occurrence (override)', 'changed occurrences (overrides)'],
    [change.exdates_moved, 'cancelled date (EXDATE)', 'cancelled dates (EXDATE)'],
    [change.rdates_moved, 'extra date (RDATE)', 'extra dates (RDATE)'],
  ].filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
  if (moved.length) parts.push(`moved along: ${moved.join(', ')}`);

  if (!parts.length) return null;
  return { summary: parts.join('; '), ...change };
}
