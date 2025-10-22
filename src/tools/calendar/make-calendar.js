import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, makeCalendarSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { getCalendarHome, sanitizeNameForUrl } from '../shared/helpers.js';

/**
 * Create a new calendar collection
 */
export const makeCalendar = {
  name: 'make_calendar',
  description: 'Create a new calendar collection on the CalDAV server with optional color, description, timezone, and component types',
  inputSchema: {
    type: 'object',
    properties: {
      display_name: {
        type: 'string',
        description: 'Display name for the new calendar',
      },
      description: {
        type: 'string',
        description: 'Optional: Calendar description',
      },
      color: {
        type: 'string',
        description: 'Optional: Calendar color in hex format (e.g., #FF5733)',
      },
      timezone: {
        type: 'string',
        description: 'Optional: Timezone ID (e.g., Europe/Berlin)',
      },
      components: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['VEVENT', 'VTODO', 'VJOURNAL']
        },
        description: 'Optional: Supported component types. Default: ["VEVENT", "VTODO"]. Use ["VEVENT"] for events only, ["VTODO"] for tasks only.',
      },
    },
    required: ['display_name'],
  },
  handler: async (args) => {
    const validated = validateInput(makeCalendarSchema, args);
    const client = tsdavManager.getCalDavClient();

    // Get calendar home URL
    const calendarHome = await getCalendarHome(client);

    // Generate new calendar URL with sanitized name
    const sanitizedName = sanitizeNameForUrl(validated.display_name);
    const newCalendarUrl = `${calendarHome}${sanitizedName}/`;

    // Prepare calendar props
    const calendarProps = {
      displayName: validated.display_name,
      description: validated.description,
      calendarColor: validated.color,
      timezone: validated.timezone,
    };

    // Add supported component set if specified
    // NOTE: Radicale ignores this property (known limitation), but works with Nextcloud/Baikal
    // Format: supportedCalendarComponentSet.comp[{_attributes: {name: 'VEVENT'}}]
    if (validated.components && validated.components.length > 0) {
      calendarProps.supportedCalendarComponentSet = {
        comp: validated.components.map(comp => ({ _attributes: { name: comp } }))
      };
    }

    const calendar = await client.makeCalendar({
      url: newCalendarUrl,
      props: calendarProps
    });

    return formatSuccess('Calendar created successfully', {
      displayName: validated.display_name,
      url: newCalendarUrl,
    });
  },
};
