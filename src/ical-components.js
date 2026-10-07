import ICAL from 'ical.js';
import { seriesMaster } from 'tsdav-utils';
import { ValidationError } from './error-handler.js';

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
 * component that was written — never "the first one in the file". (The
 * text filters of calendar_query/todo_query and the list sort key still
 * match the raw text; they are not component selections.)
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
