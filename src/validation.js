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

// CalDAV Schemas
export const listCalendarsSchema = z.object({});

export const listEventsSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL').optional(),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
});

export const createEventSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  summary: z.string().min(1, 'Summary is required').max(500),
  start_date: dateTimeWithOptionalOffset,
  end_date: dateTimeWithOptionalOffset,
  description: z.string().max(5000).optional(),
  location: z.string().max(500).optional(),
}).refine((data) => new Date(data.end_date) > new Date(data.start_date), {
  message: 'End date must be after start date',
  path: ['end_date'],
});

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
  calendar_url: z.string().url('Invalid calendar URL').optional(),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
  summary_filter: z.string().optional(),
  location_filter: z.string().optional(),
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
  addressbook_url: z.string().url('Invalid addressbook URL').optional(),
  name_filter: z.string().optional(),
  email_filter: z.string().optional(),
  organization_filter: z.string().optional(),
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
  calendar_url: z.string().url('Invalid calendar URL').optional(),
  summary_filter: z.string().optional(),
  status_filter: z.enum(['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']).optional(),
  time_range_start: dateTimeWithOptionalOffset.optional(),
  time_range_end: dateTimeWithOptionalOffset.optional(),
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
    .replace(/\\/g, '\\\\')  // Escape backslashes
    .replace(/;/g, '\\;')    // Escape semicolons
    .replace(/,/g, '\\,')    // Escape commas
    .replace(/\n/g, '\\n');  // Escape newlines
}

/**
 * Sanitize vCard string
 */
export function sanitizeVCardString(str) {
  return sanitizeICalString(str);
}
