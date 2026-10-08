import { describe, test, expect } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

connectTo('https://dav.example.com/');

// A write tool that silently drops a parameter it does not know reports
// success for a change it never made: dav-mcp 4.3.1 dropped
// cancel_occurrences and answered "Updated 0 field(s)", and the model told
// the user the occurrence was cancelled (#126). Write tools refuse unknown
// parameters, naming them — and accept every parameter they advertise.
const { tools } = await import('../src/tools/index.js');

const WRITE_TOOLS = [
  'create_event', 'update_event', 'update_event_raw', 'delete_event',
  'make_calendar', 'update_calendar', 'delete_calendar',
  'create_contact', 'update_contact', 'update_contact_raw', 'delete_contact',
  'create_todo', 'update_todo', 'update_todo_raw', 'delete_todo',
];

const failure = async (call) => {
  try {
    await call;
  } catch (error) {
    return error.message;
  }
  throw new Error('expected the call to fail');
};

describe('write tools refuse parameters they do not take', () => {
  test('every write tool is covered', () => {
    expect(WRITE_TOOLS.filter((name) => !tools.some((t) => t.name === name))).toEqual([]);
  });

  test.each(WRITE_TOOLS)('%s names the unknown parameter and none it advertises', async (name) => {
    const tool = tools.find((t) => t.name === name);
    const advertised = Object.keys(tool.inputSchema.properties ?? {});
    // any value: the shapes may be wrong, the names are what is checked
    const args = Object.fromEntries(advertised.map((key) => [key, 'x']));
    const message = await failure(tool.handler({ ...args, cancel_ocurrences: ['2026-10-12T09:00:00'] }));

    const unknown = /unknown parameters?: ([^(]+) \(this tool does not take/.exec(message);
    expect(unknown).not.toBeNull();
    expect(unknown[1].split(', ').map((s) => s.trim())).toEqual(['cancel_ocurrences']);
  });

  test('update_event with only an unknown parameter writes nothing', async () => {
    const tool = tools.find((t) => t.name === 'update_event');
    const message = await failure(tool.handler({
      event_url: 'https://dav.example.com/calendars/user/work/e.ics', event_etag: '"1"', exclude_dates: ['2026-10-12'],
    }));
    expect(message).toBe('Validation failed: unknown parameter: exclude_dates (this tool does not take it; see its input schema)');
  });
});
