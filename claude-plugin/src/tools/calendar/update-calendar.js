import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateCalendarSchema } from '../../validation.js';
import { formatCalendarUpdateSuccess } from '../../formatters.js';
import { assertDavSuccess, findCalendarOrThrow } from '../shared/helpers.js';
import { calendarTimezoneValue, readCalendarTimezone, calendarTimezoneOf } from '../../calendar-zone.js';
import { NotFoundError } from '../../error-handler.js';

/**
 * Update an existing calendar's properties
 */
export const updateCalendar = {
  name: 'update_calendar',
  annotations: {
    title: 'Update calendar properties',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  description: 'Update an existing calendar\'s properties (display name, description, color, time zone). The time zone is the one events without a zone of their own (floating times, all-day dates) are read in. Use this when user asks to "rename calendar", "change calendar color", or "update calendar properties"',
  inputSchema: {
    type: 'object',
    properties: {
      calendar_url: {
        type: 'string',
        description: 'The URL of the calendar to update (get from list_calendars)',
      },
      display_name: {
        type: 'string',
        description: 'Optional: New display name for the calendar',
      },
      description: {
        type: 'string',
        description: 'Optional: New description for the calendar',
      },
      color: {
        type: 'string',
        description: 'Optional: New calendar color in hex format (e.g., #FF5733)',
      },
      timezone: {
        type: 'string',
        description: 'Optional: New time zone, an IANA name (e.g., Europe/Berlin, America/New_York, UTC). Sent as the VTIMEZONE CalDAV asks for; the result says which zone the server holds afterwards.',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(updateCalendarSchema, args);
    // refused before anything is sent
    const timezone = validated.timezone !== undefined ? calendarTimezoneValue(validated.timezone) : null;
    const client = tsdavManager.getCalDavClient();

    // Only the properties the caller asked to change. Prefixed keys keep their
    // namespace; tsdav prefixes the rest with d: and escapes text content, so a
    // display name like "Work & Life" is sent as valid XML.
    const prop = {};
    if (validated.display_name) {
      prop.displayname = validated.display_name;
    }
    if (validated.description) {
      prop['c:calendar-description'] = validated.description;
    }
    if (validated.color) {
      prop['x:calendar-color'] = validated.color;
    }
    // RFC 4791 §5.2.2: an iCalendar object holding the zone's VTIMEZONE, not
    // the bare TZID sent before 5.0.0 (#78)
    if (timezone) {
      prop['c:calendar-timezone'] = timezone.text;
    }

    // Only a calendar list_calendars names is changed, decided before the
    // PROPPATCH. The URL check alone admits every collection in the account
    // (the calendar home, the principal), and a URL from event or contact
    // text a model was steered by must not rename those. The same calendar
    // under another spelling of its URL (an escaped character, a missing
    // trailing slash) is still this one; the request goes to the URL the
    // server listed, not to the caller's spelling of it.
    const key = (url) => {
      let path;
      try {
        path = decodeURIComponent(new URL(url).pathname);
      } catch {
        path = String(url);
      }
      return path.replace(/\/+$/, '');
    };
    const listed = (calendars, url) => calendars.find(c => c.url === url)
      ?? calendars.find(c => key(c.url) === key(url));
    const before = await client.fetchCalendars();
    const calendar = listed(before, validated.calendar_url)
      ?? findCalendarOrThrow(before, validated.calendar_url);

    // Through tsdav, not a bare fetch: the client adds its own auth headers and
    // fetch override, so PROPPATCH authenticates the same way every other
    // request does instead of copying client.authHeaders by hand.
    const response = await client.davRequest({
      url: calendar.url,
      init: {
        method: 'PROPPATCH',
        namespace: 'd',
        body: {
          propertyupdate: {
            _attributes: {
              'xmlns:d': 'DAV:',
              'xmlns:c': 'urn:ietf:params:xml:ns:caldav',
              'xmlns:x': 'http://apple.com/ns/ical/',
            },
            set: { prop },
          },
        },
      },
    });
    await assertDavSuccess(response, `update calendar ${calendar.url}`);

    // Fetch updated calendar to confirm
    const updatedCalendar = listed(await client.fetchCalendars(), calendar.url);

    if (!updatedCalendar) {
      throw new NotFoundError(
        `The server accepted the update, but ${calendar.url} is no longer among the calendars it lists, ` +
        'so the result cannot be confirmed. Check the URL with list_calendars.',
        { calendarUrl: calendar.url },
      );
    }

    // Return formatted success
    return formatCalendarUpdateSuccess(updatedCalendar, {
      display_name: validated.display_name,
      description: validated.description,
      color: validated.color,
      // what the server holds now: a server may keep, drop or rewrite it
      ...(timezone && {
        timezone: timezone.tzid,
        timezoneReadBack: readCalendarTimezone(calendarTimezoneOf(updatedCalendar))?.tzid ?? null,
      }),
    });
  },
};
