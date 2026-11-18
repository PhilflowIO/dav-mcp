import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, freeBusyQuerySchema } from '../../validation.js';
import { formatFreeBusy } from '../../formatters.js';
import { buildTimeRangeOptions, findCalendarOrThrow } from '../shared/helpers.js';
import { calculateFreeBusy } from '../shared/freebusy.js';
import { fetchRangeCandidates } from '../shared/range-candidates.js';
import { floatingZoneFor, withFloatingZone, displayZoneFor, withZoneNote } from '../../calendar-zone.js';

/**
 * Answer "when am I free?" from the calendar objects themselves.
 *
 * Deliberately not the native CalDAV free-busy-query REPORT: Google and iCloud
 * do not answer it, Radicale never implemented it, and Nextcloud and Baikal
 * have open bugs, so it fails on most of the servers people actually run.
 * Deriving the answer from the events, and from the VFREEBUSY components a
 * calendar stores (RFC 4791 7.10), works everywhere at the cost of needing
 * read access to the calendar.
 */

/**
 * The calendar-query filter for stored VFREEBUSY components.
 *
 * tsdav's default filter asks for VEVENTs only, and comp-filters in one query
 * all have to match (RFC 4791 9.7.1), so VFREEBUSY needs a query of its own.
 * It carries no time-range: SabreDAV (Nextcloud, Baikal) refuses a time-range
 * on VFREEBUSY as not implemented, and Radicale ignores it. calculateFreeBusy
 * keeps the periods that touch the window.
 */
const STORED_FREEBUSY = [{
  'comp-filter': {
    _attributes: { name: 'VCALENDAR' },
    'comp-filter': { _attributes: { name: 'VFREEBUSY' } },
  },
}];

/**
 * Can this calendar hold VFREEBUSY components? A calendar that names the
 * component types it accepts (supported-calendar-component-set) holds only
 * those; one that names none accepts every type (RFC 4791 5.2.3). Calendars
 * that leave VFREEBUSY out, which is most of them, cost no second query.
 */
function holdsFreeBusy(calendar) {
  const components = calendar.components ?? [];
  return components.length === 0
    || components.some((name) => String(name).toUpperCase() === 'VFREEBUSY');
}

export const freeBusyQuery = {
  name: 'freebusy_query',
  annotations: {
    title: 'Check free/busy',
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'Find free and busy time in a date range — use for "when am I free?", "am I available Tuesday afternoon?" or finding a slot for a new meeting. Searches all calendars unless one is given. Free/busy time a calendar stores (VFREEBUSY, e.g. published by another system) counts too, a tentative or unavailable period marked as such. Events marked TRANSPARENT (does not block time) and cancelled events are ignored; recurring events are expanded, each occurrence at its own time and status, so a single cancelled occurrence is free and a moved one is busy where it moved to. A recurring event too dense to expand fully is named in a warning. Times are shown in the calendar\'s time zone (several calendars in different zones: the zone dav-mcp runs in), named in the answer; list_events shows an event that has a zone of its own in that zone instead.',
  inputSchema: {
    type: 'object',
    properties: {
      time_range_start: {
        type: 'string',
        description: 'Start of the window to examine (ISO 8601, e.g. 2026-05-25T00:00:00Z). Required.',
      },
      time_range_end: {
        type: 'string',
        description: 'End of the window to examine (ISO 8601). Required.',
      },
      calendar_url: {
        type: 'string',
        description: 'Optional: restrict to one calendar. Omit to consider every calendar, which is usually what "am I free" means.',
      },
      include_event_details: {
        type: 'boolean',
        description: 'Optional: also list the events behind the busy blocks, with titles (a recurring one as its occurrence in the range), and the stored free/busy objects behind them. Off by default — the answer to "when am I free" is the slots, not the meetings.',
      },
    },
    required: ['time_range_start', 'time_range_end'],
  },
  handler: async (args) => {
    const validated = validateInput(freeBusyQuerySchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();

    let calendarsToSearch = calendars;
    if (validated.calendar_url) {
      calendarsToSearch = [findCalendarOrThrow(calendars, validated.calendar_url, { omit: 'to consider all calendars' })];
    }

    const timeRangeOptions = buildTimeRangeOptions(
      validated.time_range_start,
      validated.time_range_end
    );

    let events = [];
    // recurring events that could not be checked against the window
    const unchecked = [];
    // each calendar's zone, for a note when one could not be read
    const zones = [];
    // calendars whose stored free/busy could not be asked for
    const unqueried = [];
    for (const calendar of calendarsToSearch) {
      // floating times and dates are read in each calendar's own zone
      const zone = floatingZoneFor(calendar);
      zones.push(zone);
      // calculateFreeBusy keeps what touches the window
      const fetched = await fetchRangeCandidates(client, calendar, timeRangeOptions.timeRange, zone);
      events = events.concat(withFloatingZone(fetched.objects, zone));
      unchecked.push(...fetched.unchecked);
      if (holdsFreeBusy(calendar)) {
        let stored;
        try {
          stored = await client.fetchCalendarObjects({ calendar, filters: STORED_FREEBUSY });
        } catch (error) {
          // the query only adds busy time: a server that refuses it leaves
          // the answer incomplete, not failed
          unqueried.push({ kind: 'query', object: { url: calendar.url }, reason: String(error?.message ?? error) });
          stored = [];
        }
        // a server that ignores the comp-filter answers with the events again
        // (and the recurring objects fetched on top: dedupe across both by URL)
        const seen = new Set([...fetched.objects, ...fetched.unchecked.map(({ object }) => object)].map((object) => object.url));
        events = events.concat(withFloatingZone(stored.filter((object) => !seen.has(object.url)), zone));
      }
    }

    const range = {
      start: new Date(validated.time_range_start),
      end: new Date(validated.time_range_end),
    };

    const { busy, free, blocking, published, incomplete } = calculateFreeBusy(events, range);
    incomplete.push(...unchecked.map(({ object, reason }) => ({ object, summary: '', reason })));

    // shown in the zone the listings read these calendars in (#125)
    const { zone, why } = displayZoneFor(calendarsToSearch);

    return withZoneNote(formatFreeBusy({
      busy,
      free,
      range,
      zone,
      zoneNote: why,
      calendarCount: calendarsToSearch.length,
      events: validated.include_event_details ? blocking : null,
      published: validated.include_event_details ? published : null,
      incomplete: [...unqueried, ...incomplete],
    }), zones);
  },
};
