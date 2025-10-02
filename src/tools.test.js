/**
 * Tests for Phase 5 Advanced Query & Management Tools
 */

import { tools } from './tools.js';

describe('Phase 5: Advanced Query Tools', () => {
  describe('calendar_query tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'calendar_query');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('Advanced query');
      expect(tool.inputSchema.properties.calendar_url).toBeDefined();
      expect(tool.inputSchema.properties.time_range_start).toBeDefined();
      expect(tool.inputSchema.properties.time_range_end).toBeDefined();
      expect(tool.inputSchema.properties.summary_filter).toBeDefined();
      expect(tool.inputSchema.properties.location_filter).toBeDefined();
      expect(tool.inputSchema.required).toContain('calendar_url');
    });

    test('handler function exists', () => {
      const tool = tools.find(t => t.name === 'calendar_query');
      expect(tool.handler).toBeInstanceOf(Function);
    });
  });

  describe('addressbook_query tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'addressbook_query');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('Advanced query');
      expect(tool.inputSchema.properties.addressbook_url).toBeDefined();
      expect(tool.inputSchema.properties.name_filter).toBeDefined();
      expect(tool.inputSchema.properties.email_filter).toBeDefined();
      expect(tool.inputSchema.properties.organization_filter).toBeDefined();
      expect(tool.inputSchema.required).toContain('addressbook_url');
    });

    test('handler function exists', () => {
      const tool = tools.find(t => t.name === 'addressbook_query');
      expect(tool.handler).toBeInstanceOf(Function);
    });
  });

  describe('make_calendar tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'make_calendar');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('Create a new calendar');
      expect(tool.inputSchema.properties.display_name).toBeDefined();
      expect(tool.inputSchema.properties.description).toBeDefined();
      expect(tool.inputSchema.properties.color).toBeDefined();
      expect(tool.inputSchema.properties.timezone).toBeDefined();
      expect(tool.inputSchema.required).toContain('display_name');
    });

    test('handler function exists', () => {
      const tool = tools.find(t => t.name === 'make_calendar');
      expect(tool.handler).toBeInstanceOf(Function);
    });
  });

  describe('free_busy_query tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'free_busy_query');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('free/busy');
      expect(tool.inputSchema.properties.calendar_url).toBeDefined();
      expect(tool.inputSchema.properties.time_range_start).toBeDefined();
      expect(tool.inputSchema.properties.time_range_end).toBeDefined();
      expect(tool.inputSchema.required).toContain('calendar_url');
      expect(tool.inputSchema.required).toContain('time_range_start');
      expect(tool.inputSchema.required).toContain('time_range_end');
    });

    test('handler function exists', () => {
      const tool = tools.find(t => t.name === 'free_busy_query');
      expect(tool.handler).toBeInstanceOf(Function);
    });
  });

  describe('calendar_multi_get tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'calendar_multi_get');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('multiple specific');
      expect(tool.inputSchema.properties.calendar_url).toBeDefined();
      expect(tool.inputSchema.properties.event_urls).toBeDefined();
      expect(tool.inputSchema.required).toContain('calendar_url');
      expect(tool.inputSchema.required).toContain('event_urls');
    });
  });

  describe('addressbook_multi_get tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'addressbook_multi_get');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('multiple specific');
      expect(tool.inputSchema.properties.addressbook_url).toBeDefined();
      expect(tool.inputSchema.properties.contact_urls).toBeDefined();
      expect(tool.inputSchema.required).toContain('addressbook_url');
      expect(tool.inputSchema.required).toContain('contact_urls');
    });
  });

  describe('is_collection_dirty tool', () => {
    test('has correct schema definition', () => {
      const tool = tools.find(t => t.name === 'is_collection_dirty');

      expect(tool).toBeDefined();
      expect(tool.description).toContain('changed');
      expect(tool.inputSchema.properties.collection_url).toBeDefined();
      expect(tool.inputSchema.properties.collection_ctag).toBeDefined();
      expect(tool.inputSchema.required).toContain('collection_url');
      expect(tool.inputSchema.required).toContain('collection_ctag');
    });
  });

  describe('Tool count', () => {
    test('has 17 tools total', () => {
      expect(tools).toHaveLength(17);
    });

    test('has all expected tool names', () => {
      const expectedTools = [
        // CalDAV (10 tools)
        'list_calendars',
        'list_events',
        'create_event',
        'update_event',
        'delete_event',
        'calendar_query',
        'make_calendar',
        'free_busy_query',
        'calendar_multi_get',
        'is_collection_dirty',
        // CardDAV (7 tools)
        'list_addressbooks',
        'list_contacts',
        'create_contact',
        'update_contact',
        'delete_contact',
        'addressbook_query',
        'addressbook_multi_get',
      ];

      const toolNames = tools.map(t => t.name);
      expectedTools.forEach(name => {
        expect(toolNames).toContain(name);
      });
    });
  });
});
