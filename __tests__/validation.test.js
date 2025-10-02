import { describe, test, expect } from '@jest/globals';
import {
  validateInput,
  sanitizeICalString,
  sanitizeVCardString,
  createEventSchema,
  listEventsSchema
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
});
