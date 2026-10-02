import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, makeCalendarSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { getCalendarHome, sanitizeNameForUrl, davFailure, davFailureError } from '../shared/helpers.js';

// How many URLs to try before giving up: <slug>, <slug>-2 … <slug>-10.
const MAX_SLUG_ATTEMPTS = 10;

/**
 * Did MKCALENDAR fail because something already lives at that URL?
 *
 * SabreDAV (Nextcloud, Baikal) answers 405 "The resource you tried to create
 * already exists" — also when the path is held by a calendar sitting in
 * Nextcloud's trash bin, which list_calendars does not show. RFC 4791 5.3.1
 * allows a 403 with the DAV:resource-must-be-null precondition instead.
 */
function isOccupied(failure) {
  return failure.status === 405 ||
    (failure.status === 403 && /resource-must-be-null/i.test(failure.message || ''));
}

/**
 * Create a new calendar collection
 */
export const makeCalendar = {
  name: 'make_calendar',
  description: 'Create a new calendar collection on the CalDAV server with optional color, description, timezone, and component types. The URL is derived from display_name; if that URL is already taken (e.g. by a calendar in the trash bin), a numeric suffix is added (-2, -3, ...). Always use the URL returned in the response.',
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

    // URL slug from the display name; a name with no ASCII letters or digits
    // would otherwise produce an empty slug and target the calendar home itself
    const slug = sanitizeNameForUrl(validated.display_name) || 'calendar';

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

    // Like Nextcloud's own web UI: if the slug is taken, try the next free one
    // instead of failing — or worse, reporting a calendar that was never made.
    let failure;
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const url = `${calendarHome}${attempt === 1 ? slug : `${slug}-${attempt}`}/`;
      const response = await client.makeCalendar({ url, props: calendarProps });
      failure = await davFailure(response);

      if (!failure) {
        return formatSuccess('Calendar created successfully', {
          displayName: validated.display_name,
          url,
        });
      }
      if (!isOccupied(failure)) {
        throw davFailureError(failure, `Failed to create calendar ${url}`);
      }
    }

    const error = new Error(
      `Failed to create calendar "${validated.display_name}": ` +
      `${calendarHome}${slug}/ and the next ${MAX_SLUG_ATTEMPTS - 1} numbered URLs are all taken ` +
      `(last response: ${failure.status} ${failure.statusText}${failure.message ? `: ${failure.message}` : ''}).`
    );
    error.details = { status: failure.status, statusText: failure.statusText, serverMessage: failure.message };
    throw error;
  },
};
