import { z } from 'zod';

/**
 * Validation schemas for all MCP tools
 */

// Helper: DateTime string with optional timezone offset
// Accepts both "2026-03-02T09:00:00Z" and "2026-03-02T09:00:00"
const dateTimeWithOptionalOffset = z.union([
  z.string().datetime({ offset: true }), // With timezone (Z or +00:00)
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'Invalid datetime format') // Without timezone
]);

// Helper: a date-only value, which RFC 5545 3.3.4 calls a DATE and which is how
// an all-day event is expressed
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Is this a date-only ("2026-05-25") rather than a datetime value?
 */
export function isDateOnly(value) {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

// Helper: either form. Which one was given decides whether the event is
// all-day, unless the caller says otherwise with an explicit all_day flag.
export const dateOrDateTime = z.union([
  z.string().regex(DATE_ONLY, 'Invalid date format'),
  dateTimeWithOptionalOffset,
]);

/**
 * The day after a date-only value, as a date-only value.
 *
 * Date.parse of "YYYY-MM-DD" is UTC midnight by spec, so adding 24h and
 * reading the date back off the ISO string never crosses a DST seam.
 */
function nextDay(dateOnly) {
  return new Date(Date.parse(dateOnly) + 86400000).toISOString().slice(0, 10);
}

/**
 * Shared checks for a (start, end, all_day) triple.
 *
 * Three things go wrong here if they are not checked explicitly:
 *
 *  - A mixed pair. "2026-05-25" + "2026-05-26T10:00:00Z" is not a coherent
 *    event, and it has to be caught from BOTH sides: keying the check off the
 *    start alone lets a timed start with a date-only end through, which
 *    silently produces an event ending at 00:00 UTC.
 *  - all_day inferred with `||`. `all_day || isDateOnly(start)` makes an
 *    explicit `all_day: false` unreachable, so the flag has ?? semantics here
 *    and a contradiction between flag and format is reported as such.
 *  - An all-day DTEND is exclusive (RFC 5545 3.8.2.2), so a single day is
 *    written as end = start + 1. `end === start` is the phrasing a caller
 *    reaches for first, so the error has to say how to spell it instead.
 */
export function refineDateRange(data, ctx, { startKey, endKey }) {
  const start = data[startKey];
  const end = data[endKey];
  if (start === undefined || end === undefined) return;

  const startIsDate = isDateOnly(start);
  const endIsDate = isDateOnly(end);

  if (startIsDate !== endIsDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [endIsDate ? endKey : startKey],
      message:
        `${startKey} and ${endKey} must both be date-only (YYYY-MM-DD, an all-day event) ` +
        `or must both carry a time; got ${startKey}="${start}" and ${endKey}="${end}"`,
    });
    return;
  }

  const allDay = data.all_day ?? startIsDate;

  if (allDay && !startIsDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [startKey],
      message:
        `all_day is true, so ${startKey}/${endKey} must be date-only (YYYY-MM-DD); ` +
        `got "${start}". Drop the time part, and remember ${endKey} is exclusive`,
    });
    return;
  }

  if (!allDay && startIsDate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [startKey],
      message:
        `all_day is false, but ${startKey}="${start}" carries no time. ` +
        `Give a time (e.g. "${start}T09:00:00Z"), or set all_day to true`,
    });
    return;
  }

  if (allDay && start === end) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [endKey],
      message:
        `An all-day ${endKey} is exclusive: to block ${start} alone, ` +
        `use ${endKey}="${nextDay(start)}"`,
    });
    return;
  }

  if (new Date(end) <= new Date(start)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [endKey],
      message: allDay
        ? `${endKey} must be after ${startKey} and is exclusive: to block ${start} alone, use ${endKey}="${nextDay(start)}"`
        : `End date must be after start date`,
    });
  }
}

// Helper: field map for the field-based update tools (update_event/_todo/_contact)
//
// Both halves of this check are load-bearing. tsdav-utils' updateFields calls
// updatePropertyWithValue(key.toLowerCase(), value), which keys on the property
// NAME alone:
//   - a key carrying a parameter ("DTSTART;VALUE=DATE") does not replace
//     DTSTART, it appends a second one (RFC 5545 3.6.1: MUST NOT occur twice)
//   - a key carrying ":" or a line break injects further properties outright
//   - ical.js escapes line breaks for known TEXT properties, but writes X-* and
//     non-TEXT values verbatim, so values must stay on one line too
const DAV_PROPERTY_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

export const davFieldMapSchema = z.record(z.string(), z.string())
  .superRefine((fields, ctx) => {
    for (const [key, value] of Object.entries(fields)) {
      if (!DAV_PROPERTY_NAME.test(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `"${key}" is not a bare property name. Use letters, digits and "-" only (e.g. SUMMARY, X-ZOOM-LINK); parameters such as ";VALUE=DATE" are not supported here`,
        });
      }
      if (/[\r\n]/.test(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `value for "${key}" must not contain line breaks`,
        });
      }
    }
  })
  .optional();

// Helper: Optional URL that gracefully handles LLM placeholder values
// Transforms common LLM-generated placeholders ("", "unknown", "default", etc.) to undefined
const optionalUrl = (message) =>
  z.preprocess(
    (val) => {
      // Transform common LLM placeholder values to undefined
      if (!val ||
          val === '' ||
          val === 'null' ||
          val === 'undefined' ||
          val === 'unknown' ||
          val === 'default' ||
          val === 'none' ||
          val === 'N/A' ||
          val === 'n/a') {
        return undefined;
      }
      return val;
    },
    z.string().url(message).optional()
  );

// Helper: cap on how many objects a query may return. The caller is an LLM
// whose context the result has to fit into, so the default is deliberately
// small; the formatter says how many were left out.
const resultLimit = z.number().int().min(1).max(500).optional();

// CalDAV Schemas
export const listCalendarsSchema = z.object({});

export const listEventsSchema = z.object({
  calendar_url: optionalUrl('Invalid calendar URL'),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
});

export const createEventSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  summary: z.string().min(1, 'Summary is required').max(500),
  start_date: dateOrDateTime,
  end_date: dateOrDateTime,
  all_day: z.boolean().optional(),
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
}).superRefine((data, ctx) => refineDateRange(data, ctx, {
  startKey: 'start_date',
  endKey: 'end_date',
}));

export const updateEventSchema = z.object({
  event_url: z.string().url('Invalid event URL'),
  event_etag: z.string().min(1, 'ETag is required'),
  updated_ical_data: z.string().min(1, 'iCal data is required'),
});

export const deleteEventSchema = z.object({
  event_url: z.string().url('Invalid event URL'),
  event_etag: z.string().min(1, 'ETag is required'),
});

export const calendarQuerySchema = z.object({
  limit: resultLimit,
  calendar_url: optionalUrl('Invalid calendar URL'),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
  summary_filter: z.string().optional(),
  location_filter: z.string().optional(),
}).refine((data) => {
  // Rule 1: If ANY time field used, BOTH must be present
  if (data.time_range_start || data.time_range_end) {
    return data.time_range_start && data.time_range_end;
  }

  // Rule 2: At least ONE filter type must exist
  return !!(data.calendar_url ||
            data.summary_filter ||
            data.location_filter);
}, {
  message: "Provide: (time_range with BOTH dates) OR (text filter) OR (both)"
});

export const freeBusyQuerySchema = z.object({
  time_range_start: dateTimeWithOptionalOffset,
  time_range_end: dateTimeWithOptionalOffset,
  calendar_url: optionalUrl('Invalid calendar URL'),
  include_event_details: z.boolean().optional(),
}).refine((data) => new Date(data.time_range_end) > new Date(data.time_range_start), {
  message: 'time_range_end must be after time_range_start',
  path: ['time_range_end'],
});

export const makeCalendarSchema = z.object({
  display_name: z.string().min(1, 'Display name is required').max(200),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  timezone: z.string().optional(),
  components: z.array(z.enum(['VEVENT', 'VTODO', 'VJOURNAL'])).optional(),
});

export const updateCalendarSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  display_name: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  timezone: z.string().optional(),
}).refine(data => {
  // At least one field must be provided for update
  return data.display_name || data.description || data.color || data.timezone;
}, {
  message: 'At least one field (display_name, description, color, or timezone) must be provided for update',
});

export const deleteCalendarSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
});

export const calendarMultiGetSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  event_urls: z.array(z.string().url('Invalid event URL')).min(1, 'At least one event URL required'),
});

// CardDAV Schemas
export const listAddressbooksSchema = z.object({});

export const listContactsSchema = z.object({
  addressbook_url: z.string().url('Invalid addressbook URL'),
});

export const createContactSchema = z.object({
  addressbook_url: z.string().url('Invalid addressbook URL'),
  full_name: z.string().min(1, 'Full name is required').max(200),
  family_name: z.string().max(100).optional(),
  given_name: z.string().max(100).optional(),
  email: z.string().email('Invalid email format').optional(),
  phone: z.string().max(50).optional(),
  organization: z.string().max(200).optional(),
  note: z.string().max(1000).optional(),
});

export const updateContactSchema = z.object({
  vcard_url: z.string().url('Invalid vCard URL'),
  vcard_etag: z.string().min(1, 'ETag is required'),
  updated_vcard_data: z.string().min(1, 'vCard data is required'),
});

export const deleteContactSchema = z.object({
  vcard_url: z.string().url('Invalid vCard URL'),
  vcard_etag: z.string().min(1, 'ETag is required'),
});

export const addressBookQuerySchema = z.object({
  limit: resultLimit,
  addressbook_url: optionalUrl('Invalid addressbook URL'),
  name_filter: z.string().optional(),
  email_filter: z.string().optional(),
  organization_filter: z.string().optional(),
}).refine((data) => {
  // At least one filter required
  return !!(data.name_filter ||
            data.email_filter ||
            data.organization_filter);
}, {
  message: "At least one filter required: name_filter, email_filter, or organization_filter"
});

export const addressBookMultiGetSchema = z.object({
  addressbook_url: z.string().url('Invalid addressbook URL'),
  contact_urls: z.array(z.string().url('Invalid contact URL')).min(1, 'At least one contact URL required'),
});

// VTODO (Task) Schemas
export const listTodosSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
});

export const createTodoSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  summary: z.string().min(1, 'Summary is required').max(500),
  description: z.string().max(5000).optional(),
  due_date: z.string().optional(), // ISO 8601 with timezone
  priority: z.number().int().min(0).max(9).optional(), // 0=undefined, 1=highest, 9=lowest
  status: z.enum(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']).optional(),
  percent_complete: z.number().int().min(0).max(100).optional(),
});

export const updateTodoSchema = z.object({
  todo_url: z.string().url('Invalid todo URL'),
  todo_etag: z.string().min(1, 'ETag is required'),
  updated_ical_data: z.string().min(1, 'iCal data is required'),
});

export const deleteTodoSchema = z.object({
  todo_url: z.string().url('Invalid todo URL'),
  todo_etag: z.string().min(1, 'ETag is required'),
});

export const todoQuerySchema = z.object({
  limit: resultLimit,
  calendar_url: optionalUrl('Invalid calendar URL'),
  summary_filter: z.string().optional(),
  status_filter: z.enum(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']).optional(),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
}).refine((data) => {
  // Rule 1: If ANY time field used, BOTH must be present
  if (data.time_range_start || data.time_range_end) {
    return data.time_range_start && data.time_range_end;
  }

  // Rule 2: At least ONE filter type must exist
  return !!(data.calendar_url ||
            data.summary_filter ||
            data.status_filter);
}, {
  message: "Provide: (time_range with BOTH dates) OR (text/status filter) OR (both)"
});

export const todoMultiGetSchema = z.object({
  todo_urls: z.array(z.string().url('Invalid todo URL')).min(1, 'At least one todo URL required'),
});

/**
 * Validate input against a schema
 */
export function validateInput(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ');
    throw new Error(`Validation failed: ${errors}`);
  }
  return result.data;
}

/**
 * Sanitize string for iCal/vCard format (escape special characters)
 */
export function sanitizeICalString(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')    // Escape backslashes
    .replace(/;/g, '\\;')      // Escape semicolons
    .replace(/,/g, '\\,')      // Escape commas
    .replace(/\r\n?/g, '\\n')  // Escape CRLF and bare CR (before the LF rule,
    .replace(/\n/g, '\\n');    // so that a CRLF collapses into one escape)
}

/**
 * Sanitize vCard string
 */
export function sanitizeVCardString(str) {
  return sanitizeICalString(str);
}
