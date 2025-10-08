import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
  validateInput,
  updateCalendarSchema,
  deleteCalendarSchema,
} from '../src/validation.js';
import {
  formatCalendarUpdateSuccess,
  formatCalendarDeleteSuccess,
} from '../src/formatters.js';

describe('Calendar Management', () => {
  describe('updateCalendarSchema validation', () => {
    test('should accept valid calendar update with display_name', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
        display_name: 'New Calendar Name',
      };
      const result = validateInput(updateCalendarSchema, input);
      expect(result.calendar_url).toBe(input.calendar_url);
      expect(result.display_name).toBe(input.display_name);
    });

    test('should accept valid calendar update with color', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
        color: '#FF5733',
      };
      const result = validateInput(updateCalendarSchema, input);
      expect(result.color).toBe(input.color);
    });

    test('should accept valid calendar update with multiple fields', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
        display_name: 'Updated Calendar',
        description: 'New description',
        color: '#00FF00',
        timezone: 'Europe/Berlin',
      };
      const result = validateInput(updateCalendarSchema, input);
      expect(result.display_name).toBe(input.display_name);
      expect(result.description).toBe(input.description);
      expect(result.color).toBe(input.color);
      expect(result.timezone).toBe(input.timezone);
    });

    test('should reject invalid calendar URL', () => {
      const input = {
        calendar_url: 'not-a-url',
        display_name: 'Test',
      };
      expect(() => validateInput(updateCalendarSchema, input)).toThrow('Invalid calendar URL');
    });

    test('should reject invalid color format', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
        color: 'red',
      };
      expect(() => validateInput(updateCalendarSchema, input)).toThrow();
    });

    test('should reject when no update fields provided', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
      };
      expect(() => validateInput(updateCalendarSchema, input)).toThrow(
        'At least one field'
      );
    });

    test('should accept valid hex color with lowercase', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
        color: '#ff5733',
      };
      const result = validateInput(updateCalendarSchema, input);
      expect(result.color).toBe('#ff5733');
    });
  });

  describe('deleteCalendarSchema validation', () => {
    test('should accept valid calendar URL', () => {
      const input = {
        calendar_url: 'https://dav.example.com/calendars/user/test',
      };
      const result = validateInput(deleteCalendarSchema, input);
      expect(result.calendar_url).toBe(input.calendar_url);
    });

    test('should reject invalid calendar URL', () => {
      const input = {
        calendar_url: 'not-a-url',
      };
      expect(() => validateInput(deleteCalendarSchema, input)).toThrow('Invalid calendar URL');
    });

    test('should reject missing calendar_url', () => {
      const input = {};
      expect(() => validateInput(deleteCalendarSchema, input)).toThrow();
    });
  });

  describe('formatCalendarUpdateSuccess', () => {
    test('should format calendar update success with all fields', () => {
      const calendar = {
        displayName: 'Updated Calendar',
        url: 'https://dav.example.com/calendars/user/test',
      };
      const updatedFields = {
        display_name: 'Updated Calendar',
        description: 'New description',
        color: '#FF5733',
        timezone: 'Europe/Berlin',
      };

      const result = formatCalendarUpdateSuccess(calendar, updatedFields);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Calendar updated successfully');
      expect(result.content[0].text).toContain('Updated Calendar');
      expect(result.content[0].text).toContain('Display name: Updated Calendar');
      expect(result.content[0].text).toContain('Description: New description');
      expect(result.content[0].text).toContain('Color: #FF5733');
      expect(result.content[0].text).toContain('Timezone: Europe/Berlin');
    });

    test('should format calendar update success with single field', () => {
      const calendar = {
        displayName: 'My Calendar',
        url: 'https://dav.example.com/calendars/user/test',
      };
      const updatedFields = {
        display_name: 'My Calendar',
      };

      const result = formatCalendarUpdateSuccess(calendar, updatedFields);

      expect(result.content[0].text).toContain('Calendar updated successfully');
      expect(result.content[0].text).toContain('My Calendar');
      expect(result.content[0].text).not.toContain('Description:');
    });

    test('should handle unnamed calendar', () => {
      const calendar = {
        url: 'https://dav.example.com/calendars/user/test',
      };
      const updatedFields = {
        color: '#00FF00',
      };

      const result = formatCalendarUpdateSuccess(calendar, updatedFields);

      expect(result.content[0].text).toContain('Unnamed Calendar');
    });
  });

  describe('formatCalendarDeleteSuccess', () => {
    test('should format calendar deletion success with warning', () => {
      const calendarUrl = 'https://dav.example.com/calendars/user/test';

      const result = formatCalendarDeleteSuccess(calendarUrl);

      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Calendar deleted successfully');
      expect(result.content[0].text).toContain('Warning');
      expect(result.content[0].text).toContain('permanently deleted');
      expect(result.content[0].text).toContain(calendarUrl);
    });

    test('should include warning emoji', () => {
      const calendarUrl = 'https://dav.example.com/calendars/user/test';

      const result = formatCalendarDeleteSuccess(calendarUrl);

      expect(result.content[0].text).toMatch(/⚠️/);
    });

    test('should include success emoji', () => {
      const calendarUrl = 'https://dav.example.com/calendars/user/test';

      const result = formatCalendarDeleteSuccess(calendarUrl);

      expect(result.content[0].text).toMatch(/✅/);
    });
  });
});
