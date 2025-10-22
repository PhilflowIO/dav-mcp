import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, updateCalendarSchema } from '../../validation.js';
import { formatCalendarUpdateSuccess } from '../../formatters.js';

/**
 * Update an existing calendar's properties
 */
export const updateCalendar = {
  name: 'update_calendar',
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
        description: 'Optional: New timezone ID (e.g., Europe/Berlin)',
      },
    },
    required: ['calendar_url'],
  },
  handler: async (args) => {
    const validated = validateInput(updateCalendarSchema, args);
    const client = tsdavManager.getCalDavClient();

    // Build WebDAV PROPPATCH XML
    let proppatchXml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    proppatchXml += '<d:propertyupdate xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">\n';
    proppatchXml += '  <d:set>\n';
    proppatchXml += '    <d:prop>\n';

    if (validated.display_name) {
      proppatchXml += `      <d:displayname>${validated.display_name}</d:displayname>\n`;
    }
    if (validated.description) {
      proppatchXml += `      <c:calendar-description>${validated.description}</c:calendar-description>\n`;
    }
    if (validated.color) {
      proppatchXml += `      <x:calendar-color>${validated.color}</x:calendar-color>\n`;
    }
    if (validated.timezone) {
      // Validate timezone format (basic check)
      if (!validated.timezone.includes('/')) {
        throw new Error(`Invalid timezone format: ${validated.timezone}. Expected format: "Europe/Berlin", "America/New_York", etc.`);
      }
      proppatchXml += `      <c:calendar-timezone>${validated.timezone}</c:calendar-timezone>\n`;
    }

    proppatchXml += '    </d:prop>\n';
    proppatchXml += '  </d:set>\n';
    proppatchXml += '</d:propertyupdate>';

    // Use raw fetch with HTTP PROPPATCH method
    const response = await fetch(validated.calendar_url, {
      method: 'PROPPATCH',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        ...client.authHeaders,
      },
      body: proppatchXml,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `PROPPATCH failed with status ${response.status} ${response.statusText}\n` +
        `Response: ${errorText}\n\n` +
        `This may indicate:\n` +
        `- Invalid property value (check timezone format if specified)\n` +
        `- Server does not support calendar property updates\n` +
        `- Permission denied for this calendar`
      );
    }

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
