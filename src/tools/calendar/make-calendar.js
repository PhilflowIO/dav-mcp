import { tsdavManager } from '../../tsdav-client.js';
import { validateInput, makeCalendarSchema } from '../../validation.js';
import { formatSuccess } from '../../formatters.js';
import { MCP_ERROR_CODES } from '../../error-handler.js';
import { getCalendarHome, sanitizeNameForUrl, davFailure, davFailureError } from '../shared/helpers.js';

// How many URLs to try before giving up: <slug>, <slug>-2 … <slug>-10.
const MAX_SLUG_ATTEMPTS = 10;

// tsdav strips the namespace and camelCases element names, and 2.3.5+ keeps a
// "{namespace}" prefix where two namespaces use the same name.
const localNames = (resourcetype) =>
  Object.keys(resourcetype && typeof resourcetype === 'object' ? resourcetype : {})
    .map(key => key.replace(/^\{[^}]*\}/, ''));

function textValue(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return value?._cdata ?? value?._text ?? '';
}

/**
 * What occupies a URL that MKCALENDAR refused?
 *
 * The status code cannot answer that: SabreDAV (Nextcloud, Baikal) says 405
 * "already exists" both for a live calendar and for one in Nextcloud's trash
 * bin, which list_calendars does not show, and a server without MKCALENDAR
 * support says 405 too. So we look. Goes through the client so the request is
 * authenticated; no headers are passed, as that would replace the auth headers
 * in tsdav before 2.3.5.
 *
 * @returns {Promise<{activeCalendar: boolean, displayName: string}|null>}
 *   null if nothing is there or the server would not tell us
 */
async function inspectOccupant(client, url) {
  let responses;
  try {
    responses = await client.propfind({
      url,
      depth: '0',
      props: { 'd:resourcetype': {}, 'd:displayname': {} },
    });
  } catch {
    return null;
  }
  const entry = Array.isArray(responses) ? responses[0] : undefined;
  if (!entry || entry.ok === false || entry.status < 200 || entry.status >= 300) return null;

  const types = localNames(entry.props?.resourcetype);
  return {
    // Nextcloud marks a trashed calendar {http://nextcloud.com/ns}deleted-calendar
    // instead of calendar; it only holds the URL until the trash is emptied.
    activeCalendar: types.includes('calendar') && !types.includes('deletedCalendar'),
    displayName: textValue(entry.props?.displayname),
  };
}

function alreadyExistsError(url, displayName) {
  const error = new Error(
    `A calendar already exists at ${url} (display name: ${displayName ? `"${displayName}"` : 'none'}). ` +
    'No new calendar was created. Use that calendar, or choose a different display_name.'
  );
  error.code = MCP_ERROR_CODES.CONFLICT_ERROR;
  error.details = { url, displayName };
  return error;
}

/**
 * Create a new calendar collection
 */
export const makeCalendar = {
  name: 'make_calendar',
  description: 'Create a new calendar collection on the CalDAV server with optional color, description, timezone, and component types. The URL is derived from display_name. If a calendar already exists at that URL, nothing is created and the error names the existing calendar — use it instead of creating another. If the URL is only held by something else (e.g. a deleted calendar in the trash bin), a numeric suffix is added (-2, -3, ...). Always use the URL returned in the response.',
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

    // Like Nextcloud's own web UI: if the slug is held by something that is
    // not a live calendar, take the next free one.
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

      const occupant = await inspectOccupant(client, url);
      // Nothing there: the server refused for another reason (no MKCALENDAR
      // support, wrong calendar home, no permission). Retrying cannot help.
      if (!occupant) {
        throw davFailureError(failure, `Failed to create calendar ${url}`);
      }
      // A live calendar on the name's own URL, or one with this very name on a
      // numbered URL, is most likely this calendar — created by an earlier call
      // whose answer was lost. A second one would be a duplicate. A differently
      // named calendar on a numbered URL is unrelated and just takes that slot.
      if (occupant.activeCalendar &&
          (attempt === 1 || occupant.displayName === validated.display_name)) {
        throw alreadyExistsError(url, occupant.displayName);
      }
    }

    const error = new Error(
      `Failed to create calendar "${validated.display_name}": ` +
      `${calendarHome}${slug}/ and the next ${MAX_SLUG_ATTEMPTS - 1} numbered URLs are all taken ` +
      `(last response: ${failure.status} ${failure.statusText}${failure.message ? `: ${failure.message}` : ''}).`
    );
    error.httpStatus = failure.status;
    error.details = { status: failure.status, statusText: failure.statusText, serverMessage: failure.message };
    throw error;
  },
};
