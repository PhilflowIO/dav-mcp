import { z } from 'zod';

/**
 * Validation schemas for all MCP tools
 */

// CalDAV Schemas
export const listCalendarsSchema = z.object({});

export const listEventsSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  time_range_start: z.string().datetime().optional(),
  time_range_end: z.string().datetime().optional(),
});

export const createEventSchema = z.object({
  calendar_url: z.string().url('Invalid calendar URL'),
  summary: z.string().min(1, 'Summary is required').max(500),
  start_date: z.string().datetime('Invalid start date format'),
  end_date: z.string().datetime('Invalid end date format'),
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
