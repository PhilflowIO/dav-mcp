#!/usr/bin/env node
/**
 * Writes the MCP mocks of the Claude plugin's eval suite
 * (claude-plugin/evals/mocks/ and claude-plugin/evals/<case>/mocks/).
 *
 * The mock bodies are not written by hand: every one is what the real tool
 * handler returns — formatter output, write results, and errors through the
 * same createToolErrorResponse the stdio server uses — run against an
 * in-memory DAV client holding made-up data. A change to a formatter or to a
 * tool's output shows up in the mocks the next time this runs, so the evals
 * keep testing Claude against what dav-mcp really says.
 *
 * Exception: an authentication failure while dav-mcp logs in happens before
 * any tool handler runs, so it never reaches createToolErrorResponse. Its
 * text is captured from the real stdio server against a local listener that
 * answers every request with 401 (see captureLoginFailure). No real account
 * is involved anywhere.
 *
 * Limit: `claude plugin eval` answers each tool from one fixed file, so a
 * read after a write in a run still returns the data from before the write.
 * A case that needs a changed answer uses an agent mock (see conflict-en).
 *
 * Usage: node scripts/generate-eval-mocks.js
 */

import { createServer } from 'node:http';
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ICAL from 'ical.js';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Europe/Berlin';
// create tools name new objects after Date.now(); a fixed clock keeps the mocks stable
Date.now = () => Date.UTC(2026, 9, 8, 9, 0, 0);
process.env.NODE_ENV ??= 'test';

const root = fileURLToPath(new URL('../', import.meta.url));
const evalsDir = join(root, 'claude-plugin', 'evals');
const SERVER = 'dav-mcp';

const { tools, toListedTool } = await import('../src/tools/index.js');
const { tsdavManager } = await import('../src/tsdav-client.js');
const { createToolErrorResponse } = await import('../src/error-handler.js');
const { RequestOrigins, activateRequestOrigins } = await import('../src/request-origins.js');

// ---------------------------------------------------------------- fake data

const BASE = 'https://dav.example.com';
const CAL = `${BASE}/calendars/alex`;
const AB = `${BASE}/addressbooks/alex`;

// what dav-mcp does after logging in: URLs are only accepted on the configured server
activateRequestOrigins(new RequestOrigins({ serverUrl: `${BASE}/` }));

const VTIMEZONE_BERLIN = [
  'BEGIN:VTIMEZONE', 'TZID:Europe/Berlin',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'END:STANDARD',
  'END:VTIMEZONE',
];

/** A Nextcloud-style VEVENT in Europe/Berlin. */
function vevent({ uid, summary, start, end, extra = [] }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nextcloud calendar//EN',
    ...VTIMEZONE_BERLIN,
    'BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T080000Z',
    `DTSTART;TZID=Europe/Berlin:${start}`, `DTEND;TZID=Europe/Berlin:${end}`,
    `SUMMARY:${summary}`, ...extra,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function vtodo({ uid, summary, due, status = 'NEEDS-ACTION' }) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Nextcloud tasks//EN',
    'BEGIN:VTODO', `UID:${uid}`, 'DTSTAMP:20261001T080000Z', `SUMMARY:${summary}`,
    `DUE;VALUE=DATE:${due}`, `STATUS:${status}`,
    'END:VTODO', 'END:VCALENDAR', '',
  ].join('\r\n');
}

function vcard({ uid, fn, n, tel, email, org }) {
  return [
    'BEGIN:VCARD', 'VERSION:3.0', `UID:${uid}`, `FN:${fn}`, `N:${n}`,
    ...(tel ? [`TEL;TYPE=CELL:${tel}`] : []),
    ...(email ? [`EMAIL;TYPE=WORK:${email}`] : []),
    ...(org ? [`ORG:${org}`] : []),
    'END:VCARD', '',
  ].join('\r\n');
}

const calendars = [
  { url: `${CAL}/personal/`, displayName: 'Personal', components: ['VEVENT', 'VTODO'], ctag: '1' },
  { url: `${CAL}/work/`, displayName: 'Work', components: ['VEVENT', 'VTODO'], ctag: '1' },
];
const addressBooks = [{ url: `${AB}/contacts/`, displayName: 'Contacts', ctag: '1' }];

const EVENTS = {
  dentist: {
    url: `${CAL}/personal/dentist-21.ics`, etag: '"etag-dentist-7"',
    data: vevent({ uid: 'dentist-21', summary: 'Zahnarzt Dr. Weber', start: '20261021T083000', end: '20261021T091500', extra: ['LOCATION:Praxis Dr. Weber\\, Bergstr. 12'] }),
  },
  designReview: {
    url: `${CAL}/work/design-review.ics`, etag: '"etag-review-2"',
    data: vevent({ uid: 'design-review', summary: 'Design review', start: '20260901T140000', end: '20260901T153000', extra: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] }),
  },
  // a weekday standup with one day already taken out (EXDATE), as calendar apps write it
  standup: {
    url: `${CAL}/work/standup.ics`, etag: '"etag-standup-3"',
    data: vevent({ uid: 'standup', summary: 'Daily standup', start: '20260105T091500', end: '20260105T093000', extra: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'EXDATE;TZID=Europe/Berlin:20261224T091500'] }),
  },
  budgetV1: {
    url: `${CAL}/work/budget-review.ics`, etag: '"etag-budget-1"',
    data: vevent({ uid: 'budget-review', summary: 'Budget review', start: '20261014T100000', end: '20261014T110000' }),
  },
  budgetV2: {
    url: `${CAL}/work/budget-review.ics`, etag: '"etag-budget-2"',
    data: vevent({ uid: 'budget-review', summary: 'Budget review', start: '20261014T150000', end: '20261014T160000', extra: ['DESCRIPTION:Moved to the afternoon - Jana'] }),
  },
  lunch: {
    url: `${CAL}/personal/lunch-sam.ics`, etag: '"etag-lunch-1"',
    data: vevent({ uid: 'lunch-sam', summary: 'Lunch with Sam', start: '20261015T123000', end: '20261015T133000' }),
  },
};

const CONTACTS = {
  lena: {
    // 030 23125 0xx is the range German media use for fictional numbers
    url: `${AB}/contacts/lena-hoffmann.vcf`, etag: '"etag-lena-4"',
    data: vcard({ uid: 'lena-hoffmann', fn: 'Lena Hoffmann', n: 'Hoffmann;Lena;;;', tel: '+49 30 23125 012', email: 'lena.hoffmann@example.org', org: 'Hoffmann Design' }),
  },
};

const TODOS = {
  report: { url: `${CAL}/personal/todo-report.ics`, etag: '"etag-todo-1"', data: vtodo({ uid: 'todo-report', summary: 'Send quarterly report', due: '20261016' }) },
};

// ------------------------------------------------------------- fake client

/** The fetch Response tsdav hands back from a write; `url` is the PUT target. */
function written(status, etag, url = '', statusText = '') {
  const response = new Response(null, { status, statusText, headers: etag ? { etag } : {} });
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

/**
 * An in-memory stand-in for tsdav's DAVClient, holding only what a
 * scenario puts in it. `writes` decides how the server answers a PUT
 * (default: 204 with a fresh ETag), so a scenario can return a 412.
 */
function fakeClient({ events = [], todos = [], contacts = [], writes = ({ calendarObject, vCard }) => written(204, '"etag-after-update"', (calendarObject ?? vCard)?.url) } = {}) {
  const inCalendar = (objects, calendar) => objects.filter(o => o.url.startsWith(calendar.url));
  const all = [...events, ...todos, ...contacts];
  // calendar-multiget / addressbook-multiget REPORT, answered as tsdav parses a multistatus
  const multiget = async ({ init }) => {
    const report = Object.values(init.body)[0];
    const hrefs = [].concat(report['d:href'] ?? []);
    const dataKey = Object.keys(init.body)[0].includes('addressbook') ? 'addressData' : 'calendarData';
    const entries = hrefs.flatMap(href => {
      const object = all.find(o => new URL(o.url).pathname === href);
      return object ? [{ href, status: 200, ok: true, raw: { multistatus: {} }, props: { getetag: object.etag, [dataKey]: object.data } }] : [];
    });
    return entries.length ? entries : [{ status: 207, ok: true }];
  };
  return {
    fetchCalendars: async () => calendars,
    // a CalDAV time-range filter: objects with an occurrence overlapping the range
    fetchCalendarObjects: async ({ calendar, objectUrls, timeRange }) => inCalendar(events, calendar)
      .filter(o => !objectUrls || objectUrls.includes(o.url))
      .filter(o => !timeRange || overlaps(o.data, new Date(timeRange.start), new Date(timeRange.end))),
    fetchTodos: async ({ calendar }) => inCalendar(todos, calendar),
    fetchAddressBooks: async () => addressBooks,
    fetchVCards: async ({ addressBook, objectUrls }) => inCalendar(contacts, addressBook)
      .filter(o => !objectUrls || objectUrls.includes(o.url)),
    createCalendarObject: async ({ calendar, filename }) => written(201, '"etag-new-1"', calendar.url + filename),
    createTodo: async ({ calendar, filename }) => written(201, '"etag-new-1"', calendar.url + filename),
    createVCard: async ({ addressBook, filename }) => written(201, '"etag-new-1"', addressBook.url + filename),
    updateCalendarObject: async (args) => writes(args),
    updateTodo: async (args) => writes(args),
    updateVCard: async (args) => writes(args),
    deleteCalendarObject: async () => written(204),
    deleteTodo: async () => written(204),
    deleteVCard: async () => written(204),
    deleteObject: async () => written(204),
    makeCalendar: async () => [{ ok: true, status: 201 }],
    propfind: async () => [{ ok: true, status: 207, props: {} }],
    davRequest: multiget,
  };
}

/** Whether any occurrence of the event in `data` overlaps [start, end). */
function overlaps(data, start, end) {
  const vevent = new ICAL.Component(ICAL.parse(data)).getFirstSubcomponent('vevent');
  const event = new ICAL.Event(vevent);
  const iterator = event.iterator();
  for (let next = iterator.next(); next; next = iterator.next()) {
    const occurrence = event.getOccurrenceDetails(next);
    const from = occurrence.startDate.toJSDate();
    if (from >= end) return false;
    if (occurrence.endDate.toJSDate() > start) return true;
  }
  return false;
}

/** Run one tool the way the stdio server does and return [text, isError]. */
async function run(toolName, args, scenario = {}) {
  const client = fakeClient(scenario);
  tsdavManager.calDavClient = client;
  tsdavManager.cardDavClient = client;
  const tool = tools.find(t => t.name === toolName);
  if (!tool) throw new Error(`no tool ${toolName}`);
  let result;
  try {
    result = await tool.handler(args);
  } catch (error) {
    result = createToolErrorResponse(error, false);
  }
  return [result.content.map(c => c.text).join('\n'), result.isError === true];
}

// ---------------------------------------------- 401 while dav-mcp logs in

/**
 * Start the real stdio server against a local listener that answers every
 * request with 401, call one tool through the MCP SDK client, and return the
 * text a client gets. The login is retried on the tool call and its failure
 * comes back as the tool's error result; a JSON-RPC error is still caught
 * below, so a regression shows up in the mock rather than crashing the run.
 */
async function captureLoginFailure(toolName, args) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const listener = createServer((req, res) => {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="dav"' });
    res.end('Unauthorized');
  });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${listener.address().port}/remote.php/dav/`;
  // The server reads ../.env next to its own files, and an inherited
  // AUTH_METHOD=OAuth or LOG_TOOL_CALLS=true would reach a real token
  // endpoint or write a log. So it runs from a copy with no .env, with only
  // the variables set here.
  const copy = mkdtempSync(join(tmpdir(), 'dav-mcp-mockgen-'));
  cpSync(join(root, 'src'), join(copy, 'src'), { recursive: true });
  cpSync(join(root, 'package.json'), join(copy, 'package.json'));
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'junction');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(copy, 'src', 'server-stdio.js')],
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      AUTH_METHOD: 'Basic',
      CALDAV_SERVER_URL: url,
      CALDAV_USERNAME: 'alex',
      CALDAV_PASSWORD: 'wrong-password',
      LOG_TOOL_CALLS: 'false',
      LOG_LEVEL: 'silent',
    },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'eval-mock-generator', version: '1.0.0' });
  try {
    await client.connect(transport);
    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      return [result.content.map(c => c.text).join('\n').replaceAll(url, `${BASE}/remote.php/dav/`), result.isError === true];
    } catch (error) {
      // the listener's random port would make every run rewrite the mock
      return [error.message.replaceAll(url, `${BASE}/remote.php/dav/`), true];
    }
  } finally {
    await client.close();
    listener.close();
    rmSync(copy, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- writing

function writeMock(dir, tool, [text, isError], front = {}) {
  const fm = { ...front, ...(isError ? { error: true } : {}) };
  const head = Object.keys(fm).length
    ? `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n`
    : '';
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tool}.md`), head + text.trimEnd() + '\n');
}

const suiteMocks = join(evalsDir, 'mocks', SERVER);
const caseMocks = (name) => join(evalsDir, name, 'mocks', SERVER);

// regenerate from scratch so a removed mock does not linger
rmSync(suiteMocks, { recursive: true, force: true });
for (const entry of readdirSync(evalsDir, { withFileTypes: true })) {
  const dir = join(evalsDir, entry.name, 'mocks');
  if (entry.isDirectory() && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

mkdirSync(suiteMocks, { recursive: true });
writeFileSync(join(suiteMocks, '_tools.json'), JSON.stringify({ tools: tools.map(toListedTool) }, null, 2) + '\n');

// Suite-wide answers: a small, ordinary account. Cases override what they test.
const everyday = { events: [EVENTS.lunch], todos: [TODOS.report], contacts: [CONTACTS.lena] };
const E = EVENTS.lunch.url;
const T = TODOS.report.url;
const V = CONTACTS.lena.url;
const suite = {
  list_calendars: {},
  list_events: { calendar_url: `${CAL}/personal/` },
  calendar_query: { summary_filter: 'no such event' },
  calendar_multi_get: { calendar_url: `${CAL}/personal/`, event_urls: [E] },
  freebusy_query: { time_range_start: '2026-10-15T06:00:00Z', time_range_end: '2026-10-15T16:00:00Z' },
  create_event: { calendar_url: `${CAL}/personal/`, summary: 'New event', start_date: '2026-10-20T10:00:00', end_date: '2026-10-20T11:00:00' },
  update_event: { event_url: E, event_etag: '"etag-lunch-1"', fields: { SUMMARY: 'Lunch with Sam' } },
  update_event_raw: { event_url: E, event_etag: '"etag-lunch-1"', updated_ical_data: EVENTS.lunch.data },
  delete_event: { event_url: E, event_etag: '"etag-lunch-1"' },
  make_calendar: { display_name: 'New calendar' },
  update_calendar: { calendar_url: `${CAL}/personal/`, display_name: 'Personal' },
  delete_calendar: { calendar_url: `${CAL}/personal/` },
  list_addressbooks: {},
  list_contacts: { addressbook_url: `${AB}/contacts/` },
  addressbook_query: { name_filter: 'no such contact' },
  addressbook_multi_get: { addressbook_url: `${AB}/contacts/`, contact_urls: [V] },
  create_contact: { addressbook_url: `${AB}/contacts/`, full_name: 'New Contact' },
  update_contact: { vcard_url: V, vcard_etag: '"etag-lena-4"', fields: { NOTE: 'updated' } },
  update_contact_raw: { vcard_url: V, vcard_etag: '"etag-lena-4"', updated_vcard_data: CONTACTS.lena.data },
  delete_contact: { vcard_url: V, vcard_etag: '"etag-lena-4"' },
  list_todos: { calendar_url: `${CAL}/personal/` },
  todo_query: { summary_filter: 'no such task' },
  todo_multi_get: { todo_urls: [T] },
  create_todo: { calendar_url: `${CAL}/personal/`, summary: 'New task' },
  update_todo: { todo_url: T, todo_etag: '"etag-todo-1"', fields: { STATUS: 'COMPLETED' } },
  update_todo_raw: { todo_url: T, todo_etag: '"etag-todo-1"', updated_ical_data: TODOS.report.data },
  delete_todo: { todo_url: T, todo_etag: '"etag-todo-1"' },
};
if (Object.keys(suite).length !== tools.length) throw new Error('every tool needs a suite-wide mock');
for (const [tool, args] of Object.entries(suite)) {
  writeMock(suiteMocks, tool, await run(tool, args, everyday));
}

// Per-case answers. The arguments are the call the case expects; a fixed
// mock answers every call with this text.
const cases = {
  'find-event-de': {
    calendar_query: [{ summary_filter: 'Zahnarzt' }, { events: [EVENTS.dentist, EVENTS.lunch] }],
  },
  'find-contact-de': {
    addressbook_query: [{ name_filter: 'Lena Hoffmann' }, { contacts: [CONTACTS.lena] }],
  },
  'schedule-day-de': {
    calendar_query: [{ time_range_start: '2026-10-14T22:00:00Z', time_range_end: '2026-10-15T22:00:00Z' }, { events: [EVENTS.lunch] }],
    freebusy_query: [{ time_range_start: '2026-10-14T22:00:00Z', time_range_end: '2026-10-15T22:00:00Z', include_event_details: true }, { events: [EVENTS.lunch] }],
  },
  'freebusy-en': {
    freebusy_query: [{ time_range_start: '2026-10-13T12:00:00Z', time_range_end: '2026-10-13T15:00:00Z' }, { events: [EVENTS.designReview] }],
    calendar_query: [{ time_range_start: '2026-10-13T12:00:00Z', time_range_end: '2026-10-13T15:00:00Z' }, { events: [EVENTS.designReview] }],
  },
  'update-etag-en': {
    calendar_query: [{ time_range_start: '2026-10-20T22:00:00Z', time_range_end: '2026-10-21T22:00:00Z' }, { events: [EVENTS.dentist] }],
    calendar_multi_get: [{ calendar_url: `${CAL}/personal/`, event_urls: [EVENTS.dentist.url] }, { events: [EVENTS.dentist] }],
    update_event: [{ event_url: EVENTS.dentist.url, event_etag: '"etag-dentist-7"', start_date: '2026-10-21T10:00:00', end_date: '2026-10-21T10:45:00' }, { events: [EVENTS.dentist] }],
  },
  'update-recurring-tz-en': {
    calendar_query: [{ summary_filter: 'standup' }, { events: [EVENTS.standup] }],
    update_event: [{ event_url: EVENTS.standup.url, event_etag: '"etag-standup-3"', start_date: '2026-01-05T10:00:00', end_date: '2026-01-05T10:15:00' }, { events: [EVENTS.standup] }],
  },
  'delete-recurring-en': {
    calendar_query: [{ summary_filter: 'standup' }, { events: [EVENTS.standup] }],
  },
  'conflict-en': {
    calendar_multi_get: [{ calendar_url: `${CAL}/work/`, event_urls: [EVENTS.budgetV2.url] }, { events: [EVENTS.budgetV2] }],
    update_event: [{ event_url: EVENTS.budgetV1.url, event_etag: '"etag-budget-1"', fields: { SUMMARY: 'Budget review Q4' } },
      { events: [EVENTS.budgetV1], writes: () => written(412, null, EVENTS.budgetV1.url, 'Precondition Failed') }],
  },
};
for (const [name, mocks] of Object.entries(cases)) {
  for (const [tool, [args, scenario]] of Object.entries(mocks)) {
    writeMock(caseMocks(name), tool, await run(tool, args, scenario));
  }
}

// conflict-en: the event changes between the first read and every later one.
const [first] = await run('calendar_query', { summary_filter: 'Budget review' }, { events: [EVENTS.budgetV1] });
const [later] = await run('calendar_query', { summary_filter: 'Budget review' }, { events: [EVENTS.budgetV2] });
writeMock(caseMocks('conflict-en'), 'calendar_query', [
  'You are the calendar_query tool of a CalDAV server. Answer with exactly one of the two texts below, verbatim, nothing else.\n\n' +
  'If this is the FIRST call you answer in this run, return TEXT A. For every later call, return TEXT B.\n\n' +
  `TEXT A:\n${first}\n\nTEXT B:\n${later}`, false], { type: 'agent' });

// auth-error-de: every call fails at login.
const login = await captureLoginFailure('todo_query', { summary_filter: 'x' });
for (const tool of ['todo_query', 'list_todos', 'list_calendars', 'calendar_query']) {
  writeMock(caseMocks('auth-error-de'), tool, [login[0], true]);
}

console.log('mocks written to', evalsDir);
