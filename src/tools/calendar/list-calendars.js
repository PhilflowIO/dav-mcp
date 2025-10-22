import { tsdavManager } from '../../tsdav-client.js';
import { formatCalendarList } from '../../formatters.js';

/**
 * List all available calendars from the CalDAV server
 */
export const listCalendars = {
  name: 'list_calendars',
  description: 'List all available calendars from the CalDAV server. Use this to get calendar URLs needed for other operations',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();

    return formatCalendarList(calendars);
  },
};
