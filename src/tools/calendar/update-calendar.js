import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateCalendarSchema } from '../../validation.js';
import { formatCalendarUpdateSuccess } from '../../formatters.js';
import { assertDavSuccess } from '../shared/helpers.js';

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
  description: 'Update an existing calendar\'s properties (display name, description, color, timezone). Use this when user asks to "rename calendar", "change calendar color", or "update calendar properties"',
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
        description: 'Optional: New timezone ID (e.g., Europe/Berlin). Sent to the server as a bare timezone ID, not as the VTIMEZONE the CalDAV standard asks for, so a server may reject or ignore it (issue #78).',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(updateCalendarSchema, args);
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
    if (validated.timezone) {
      // Validate timezone format (basic check)
      if (!validated.timezone.includes('/')) {
        throw new Error(`Invalid timezone format: ${validated.timezone}. Expected format: "Europe/Berlin", "America/New_York", etc.`);
      }
      prop['c:calendar-timezone'] = validated.timezone;
    }

    // Through tsdav, not a bare fetch: the client adds its own auth headers and
    // fetch override, so PROPPATCH authenticates the same way every other
    // request does instead of copying client.authHeaders by hand.
    const response = await client.davRequest({
      url: validated.calendar_url,
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
    await assertDavSuccess(response, `update calendar ${validated.calendar_url}`);

    // Fetch updated calendar to confirm
    const calendars = await client.fetchCalendars();
    const updatedCalendar = calendars.find(c => c.url === validated.calendar_url);

    if (!updatedCalendar) {
      throw new Error(`Calendar not found after update: ${validated.calendar_url}`);
    }

    // Return formatted success
    return formatCalendarUpdateSuccess(updatedCalendar, {
      display_name: validated.display_name,
      description: validated.description,
      color: validated.color,
      timezone: validated.timezone,
    });
  },
};
