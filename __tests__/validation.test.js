import { describe, test, expect } from '@jest/globals';
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
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "unknown" to undefined', () => {
        const data = {
          calendar_url: 'unknown',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "default" to undefined', () => {
        const data = {
          calendar_url: 'default',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "null" string to undefined', () => {
        const data = {
          calendar_url: 'null',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "undefined" string to undefined', () => {
        const data = {
          calendar_url: 'undefined',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "none" to undefined', () => {
        const data = {
          calendar_url: 'none',
        };
        const result = validateInput(calendarQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform "N/A" and "n/a" to undefined', () => {
        const data1 = {
          calendar_url: 'N/A',
        };
        const result1 = validateInput(calendarQuerySchema, data1);
        expect(result1.calendar_url).toBeUndefined();

        const data2 = {
          calendar_url: 'n/a',
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
        };
        const result = validateInput(addressBookQuerySchema, data);
        expect(result.addressbook_url).toBe('https://example.com/addressbook/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          addressbook_url: '',
        };
        const result = validateInput(addressBookQuerySchema, data);
        expect(result.addressbook_url).toBeUndefined();
      });

      test('should transform LLM placeholders to undefined', () => {
        const placeholders = ['unknown', 'default', 'null', 'undefined', 'none', 'N/A', 'n/a'];

        placeholders.forEach(placeholder => {
          const data = {
            addressbook_url: placeholder,
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
        };
        const result = validateInput(todoQuerySchema, data);
        expect(result.calendar_url).toBe('https://example.com/calendar/');
      });

      test('should transform empty string to undefined', () => {
        const data = {
          calendar_url: '',
        };
        const result = validateInput(todoQuerySchema, data);
        expect(result.calendar_url).toBeUndefined();
      });

      test('should transform all LLM placeholders to undefined', () => {
        const placeholders = ['unknown', 'default', 'null', 'undefined', 'none', 'N/A', 'n/a'];

        placeholders.forEach(placeholder => {
          const data = {
            calendar_url: placeholder,
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
