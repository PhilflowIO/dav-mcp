import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, freeBusyQuerySchema } from '../../validation.js';
import { formatFreeBusy } from '../../formatters.js';
import { buildTimeRangeOptions } from '../shared/helpers.js';
import { calculateFreeBusy } from '../shared/freebusy.js';

/**
 * Answer "when am I free?" from the events themselves.
 *
 * Deliberately not the native CalDAV free-busy-query REPORT: Google and iCloud
 * do not answer it, Radicale never implemented it, and Nextcloud and Baikal
 * have open bugs, so it fails on most of the servers people actually run.
 * Deriving the answer from the events works everywhere at the cost of needing
 * read access to the calendar.
 */
export const freeBusyQuery = {
  name: 'freebusy_query',
  description: 'Find free and busy time in a date range — use for "when am I free?", "am I available Tuesday afternoon?" or finding a slot for a new meeting. Searches all calendars unless one is given. Events marked TRANSPARENT (does not block time) and cancelled events are ignored; recurring events are expanded.',
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
        description: 'Optional: also list the events behind each busy block, with titles. Off by default — the answer to "when am I free" is the slots, not the meetings.',
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
      const calendar = calendars.find(c => c.url === validated.calendar_url);
      if (!calendar) {
        const availableUrls = calendars.map(c => c.url).join('\n- ');
        throw new Error(
          `Calendar not found: ${validated.calendar_url}\n\n` +
          `Available calendar URLs:\n- ${availableUrls}\n\n` +
          `Tip: Omit calendar_url to consider all calendars.`
        );
      }
      calendarsToSearch = [calendar];
    }

    const timeRangeOptions = buildTimeRangeOptions(
      validated.time_range_start,
      validated.time_range_end
    );

    let events = [];
    for (const calendar of calendarsToSearch) {
      const found = await client.fetchCalendarObjects({ calendar, ...timeRangeOptions });
      events = events.concat(found);
    }

    const range = {
      start: new Date(validated.time_range_start),
      end: new Date(validated.time_range_end),
    };

    const { busy, free } = calculateFreeBusy(events, range);

    return formatFreeBusy({
      busy,
      free,
      range,
      calendarCount: calendarsToSearch.length,
      events: validated.include_event_details ? events : null,
    });
  },
};
