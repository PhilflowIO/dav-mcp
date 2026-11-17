import { describe, test, expect } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

// The URLs below belong to the server these tests stand in for.
connectTo('https://example.com/');
import {
  validateInput,
  sanitizeICalString,
  sanitizeVCardString,
  createEventSchema,
  listEventsSchema,
  calendarQuerySchema,
  addressBookQuerySchema,
  todoQuerySchema
} from '../src/validation.js';

describe('Validation Module', () => {
  describe('sanitizeICalString', () => {
    test('should escape backslashes', () => {
      const result = sanitizeICalString('test\\string');
      expect(result).toBe('test\\\\string');
    });

    test('should escape semicolons', () => {
      const result = sanitizeICalString('test;string');
      expect(result).toBe('test\\;string');
    });

    test('should escape commas', () => {
      const result = sanitizeICalString('test,string');
      expect(result).toBe('test\\,string');
    });

    test('should escape newlines', () => {
      const result = sanitizeICalString('test\nstring');
      expect(result).toBe('test\\nstring');
    });

    test('should escape CRLF as a single newline', () => {
      expect(sanitizeICalString('test\r\nstring')).toBe('test\\nstring');
    });

    test('should escape a bare carriage return', () => {
      expect(sanitizeICalString('test\rstring')).toBe('test\\nstring');
    });

    test('should leave no raw control characters behind', () => {
      const result = sanitizeICalString('a\r\nSUMMARY:injected\rX-EVIL:1');
      expect(result).not.toMatch(/[\r\n]/);
    });

    test('should handle empty string', () => {
      const result = sanitizeICalString('');
      expect(result).toBe('');
    });

    test('should handle null/undefined', () => {
      expect(sanitizeICalString(null)).toBe('');
      expect(sanitizeICalString(undefined)).toBe('');
    });
  });

  describe('sanitizeVCardString', () => {
    test('should work same as sanitizeICalString', () => {
      const input = 'test;with,special\\chars\n';
      expect(sanitizeVCardString(input)).toBe(sanitizeICalString(input));
    });
  });

  describe('validateInput', () => {
    test('should validate correct event data', () => {
      const validData = {
        calendar_url: 'https://example.com/calendar/',
        time_range_start: '2025-01-01T00:00:00.000Z',
        time_range_end: '2025-12-31T23:59:59.999Z',
      };

      const result = validateInput(listEventsSchema, validData);
      expect(result).toEqual(validData);
    });

    test('should throw on invalid URL', () => {
      const invalidData = {
        calendar_url: 'not-a-url',
      };

      expect(() => validateInput(listEventsSchema, invalidData)).toThrow('Validation failed');
    });

    test('should validate event creation with all fields', () => {
      const validEvent = {
        calendar_url: 'https://example.com/calendar/',
        summary: 'Test Event',
        start_date: '2025-10-15T10:00:00.000Z',
        end_date: '2025-10-15T11:00:00.000Z',
        description: 'Test description',
        location: 'Test location',
      };

      const result = validateInput(createEventSchema, validEvent);
      expect(result).toEqual(validEvent);
    });

    test('should reject event with end before start', () => {
      const invalidEvent = {
        calendar_url: 'https://example.com/calendar/',
        summary: 'Test Event',
        start_date: '2025-10-15T11:00:00.000Z',
        end_date: '2025-10-15T10:00:00.000Z', // Before start!
      };

      expect(() => validateInput(createEventSchema, invalidEvent)).toThrow('End date must be after start date');
    });

    test('should reject event with too long summary', () => {
      const invalidEvent = {
        calendar_url: 'https://example.com/calendar/',
        summary: 'x'.repeat(501), // Max is 500
        start_date: '2025-10-15T10:00:00.000Z',
        end_date: '2025-10-15T11:00:00.000Z',
      };

      expect(() => validateInput(createEventSchema, invalidEvent)).toThrow('Validation failed');
    });
  });

  describe('optionalUrl preprocessing (LLM robustness)', () => {
    describe('calendarQuerySchema', () => {
      test('should accept valid URL', () => {
        const data = {
          calendar_url: 'https://example.com/calendar/',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBe('https://example.com/calendar/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          calendar_url: '',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "unknown" to undefined', () => {
        const data = {
          calendar_url: 'unknown',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "default" to undefined', () => {
        const data = {
          calendar_url: 'default',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "null" string to undefined', () => {
        const data = {
          calendar_url: 'null',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "undefined" string to undefined', () => {
        const data = {
          calendar_url: 'undefined',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "none" to undefined', () => {
        const data = {
          calendar_url: 'none',
          summary_filter: 'meeting',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "N/A" and "n/a" to undefined', () => {
        const data1 = {
          calendar_url: 'N/A',
          summary_filter: 'meeting',
        };
        const result1 = validateInput(calendarQuerySchema, data1);
        expect(result1.calendar_url).toBeUndefined();

        const data2 = {
          calendar_url: 'n/a',
          summary_filter: 'meeting',
        };
        const result2 = validateInput(calendarQuerySchema, data2);
        expect(result2.calendar_url).toBeUndefined();
      });

      test('should reject invalid URLs that are not placeholders', () => {
        const data = {
          calendar_url: 'not-a-valid-url',
        };
        expect(() => validateInput(calendarQuerySchema, data)).toThrow('Invalid calendar URL');
      });
    });

    describe('addressBookQuerySchema', () => {
      test('should accept valid URL', () => {
        const data = {
          addressbook_url: 'https://example.com/addressbook/',
          name_filter: 'John',
        };
        const result = validateInput(addressBookQuerySchema, data);
        expect(result.addressbook_url).toBe('https://example.com/addressbook/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          addressbook_url: '',
          name_filter: 'John',
        };
        const result = validateInput(addressBookQuerySchema, data);
        expect(result.addressbook_url).toBeUndefined();
      });

      test('should transform LLM placeholders to undefined', () => {
        const placeholders = ['unknown', 'default', 'null', 'undefined', 'none', 'N/A', 'n/a'];

        placeholders.forEach(placeholder => {
          const data = {
            addressbook_url: placeholder,
            name_filter: 'John',
          };
          const result = validateInput(addressBookQuerySchema, data);
          expect(result.addressbook_url).toBeUndefined();
        });
      });
    });

    describe('todoQuerySchema', () => {
      test('should accept valid URL', () => {
        const data = {
          calendar_url: 'https://example.com/calendar/',
          summary_filter: 'task',
        };
        const result = validateInput(todoQuerySchema, data);
        expect(result.calendar_url).toBe('https://example.com/calendar/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          calendar_url: '',
          summary_filter: 'task',
        };
        const result = validateInput(todoQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform all LLM placeholders to undefined', () => {
        const placeholders = ['unknown', 'default', 'null', 'undefined', 'none', 'N/A', 'n/a'];

        placeholders.forEach(placeholder => {
          const data = {
            calendar_url: placeholder,
            summary_filter: 'task',
          };
          const result = validateInput(todoQuerySchema, data);
          expect(result.calendar_url).toBeUndefined();
        });
      });
    });

    describe('listEventsSchema', () => {
      test('should accept valid URL', () => {
        const data = {
          calendar_url: 'https://example.com/calendar/',
        };
        const result = validateInput(listEventsSchema, data);
        expect(result.calendar_url).toBe('https://example.com/calendar/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          calendar_url: '',
        };
        const result = validateInput(listEventsSchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should handle combination of URL placeholder and valid time ranges', () => {
        const data = {
          calendar_url: 'unknown',
          time_range_start: '2025-01-01T00:00:00.000Z',
          time_range_end: '2025-12-31T23:59:59.999Z',
        };
        const result = validateInput(listEventsSchema, data);
        expect(result.calendar_url).toBeUndefined();
        expect(result.time_range_start).toBe('2025-01-01T00:00:00.000Z');
        expect(result.time_range_end).toBe('2025-12-31T23:59:59.999Z');
      });
    });
  });
});

// zod 4 narrowed what its datetime and URL checks accept and how they word a
// failure; the time-range parameters and URL messages keep their zod 3 form.
describe('time-range datetimes', () => {
  const range = (start) => ({ calendar_url: 'https://example.com/cal/', time_range_start: start, time_range_end: '2026-03-09T09:00:00Z' });

  test.each([
    '2026-03-02T09:00:00Z',
    '2026-03-02T09:00:00.123Z',
    '2026-03-02T09:00:00+01:00',
    '2026-03-02T09:00:00+0100',
    '2026-03-02T09:00Z',
    '2026-03-02T09:00+01:00',
    '2026-03-02T09:00:00',
  ])('accepts %s', (start) => {
    expect(validateInput(listEventsSchema, range(start)).time_range_start).toBe(start);
  });

  test.each([
    '2026-03-02T09:00:00+01',
    '2026-03-02T09:00',
    '2026-02-30T09:00:00Z',
    '2026-03-02',
    'tomorrow',
  ])('refuses %s', (start) => {
    expect(() => validateInput(listEventsSchema, range(start))).toThrow('time_range_start: Invalid datetime');
  });
});

describe('URL parameter messages', () => {
  test('a malformed URL gets the parameter\'s own message', () => {
    expect(() => validateInput(createEventSchema, {
      calendar_url: 'not a url', summary: 's', start_date: '2026-03-02', end_date: '2026-03-03',
    })).toThrow('calendar_url: Invalid calendar URL');
  });

  test('a missing URL is reported as missing, not as malformed', () => {
    let message;
    try {
      validateInput(createEventSchema, { summary: 's', start_date: '2026-03-02', end_date: '2026-03-03' });
    } catch (error) {
      message = error.message;
    }
    expect(message).toMatch(/calendar_url: .*received undefined/);
    expect(message).not.toMatch('Invalid calendar URL');
  });
});
