// Differential check of the occurrence engine (src/occurrences.js) against a
// plain expansion from DTSTART, for random series with random overrides —
// moved into, out of and within the range, cancelled, transparent, retitled,
// RANGE=THISANDFUTURE, orphaned, EXDATEd, RECURRENCE-ID in another frame —
// and random ranges. The fast side goes through the callers themselves
// (free/busy, shownEvent, seriesOccurrences); the reference expands each case
// once and filters with the same predicates (touchesRange, blocksTime), so a
// caller drifting from them shows up here. Some series are too dense to
// expand within the iteration cap: there the fast side must say `truncated`
// and may only miss occurrences, never invent one.
//
// Run in a child process whose timezone the parent sets via TZ: a floating
// time becomes an instant only on the host clock. Prints one JSON line:
// { cases, compared, deviations, truncated, examples }.
//
// argv[2]: number of series (default 400), argv[3]: seed (default 98)
import ICAL from 'ical.js';
import { readSeries, shownEvent, blocksTime } from '../../src/ical-components.js';
import { relateSeries, seriesOccurrences, spanOf, touchesRange } from '../../src/occurrences.js';
import { shareTimezones } from '../../src/tools/shared/ical-dates.js';
import { expandOccurrences, createRecurrenceBudget, resolvePropertyZone } from 'tsdav-utils';
import { busyOccurrencesOf } from '../../src/tools/shared/freebusy.js';

console.error = () => {}; // the cap message
const CASES = Number(process.argv[2] ?? 400);
let seed = Number(process.argv[3] ?? 98) >>> 0;

// mulberry32: a small deterministic PRNG, so a deviation can be replayed
function random() {
  seed = (seed + 0x6D2B79F5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
const pick = (list) => list[int(0, list.length - 1)];
const chance = (p) => random() < p;

const DAY = 86400;
const NEW_YORK = [
  'BEGIN:VTIMEZONE', 'TZID:America/New_York',
  'BEGIN:DAYLIGHT', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'DTSTART:19700308T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
  'BEGIN:STANDARD', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'DTSTART:19701101T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD',
  'END:VTIMEZONE',
].join('\r\n');

const NY = new ICAL.Timezone(new ICAL.Component(ICAL.parse(
  `BEGIN:VCALENDAR\r\n${NEW_YORK}\r\nEND:VCALENDAR`)).getFirstSubcomponent('vtimezone'));

const pad = (n) => String(n).padStart(2, '0');
// the generator works in "wall clock as UTC" seconds; written in the series'
// form: digits for a zoned or floating series, a date if all-day
function stamp(wall, form) {
  const d = new Date(wall * 1000);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  if (form === 'date') return date;
  const time = `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  return form === 'utc' ? `${time}Z` : time;
}
function prop(name, wall, zone, allDay, params = '') {
  if (allDay) return `${name};VALUE=DATE${params}:${stamp(wall, 'date')}`;
  if (zone === 'utc') return `${name}${params}:${stamp(wall, 'utc')}`;
  if (zone === 'ny') return `${name};TZID=America/New_York${params}:${stamp(wall, 'local')}`;
  return `${name}${params}:${stamp(wall, 'local')}`;
}
const wallOf = (time) => Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) / 1000;

function series() {
  const kind = random() < 1 / 32 ? 'dense' : pick(['day', 'day', 'sub', 'cal']);
  const zone = pick(['utc', 'ny', 'floating']);
  const allDay = (kind === 'day' || kind === 'cal') && chance(kind === 'cal' ? 0.3 : 0.15);
  const parts = [];
  let start;
  let duration;
  if (kind === 'day') {
    start = Date.UTC(2023, 0, 1) / 1000 + int(0, 1100) * DAY + (allDay ? 0 : int(0, 47) * 1800);
    duration = allDay ? int(1, 3) * DAY : pick([900, 3600, 3 * 3600, 26 * 3600, 3 * DAY]);
    const freq = pick(['DAILY', 'DAILY', 'WEEKLY', 'WEEKLY', 'MONTHLY']);
    parts.push(`FREQ=${freq}`);
    if (freq !== 'MONTHLY' && chance(0.5)) parts.push(`INTERVAL=${int(2, 3)}`);
    if (freq === 'WEEKLY' && chance(0.6)) {
      const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].filter(() => chance(0.4));
      if (days.length) parts.push(`BYDAY=${days.join(',')}`);
    }
    if (freq === 'DAILY' && chance(0.15)) parts.push(`BYMONTH=${int(1, 12)},${int(1, 12)}`);
    // ical.js yields a BY list in the order given: sometimes not ascending
    if (freq !== 'MONTHLY' && !allDay && chance(0.15)) parts.push(chance(0.5) ? `BYHOUR=${int(0, 11)},${int(12, 23)}` : `BYHOUR=${int(12, 23)},${int(0, 11)}`);
    const end = random();
    if (end < 0.2) parts.push(`COUNT=${int(5, 400)}`);
    // RFC 5545: a floating series' UNTIL is floating too; now and then not,
    // which the library refuses to read
    else if (end < 0.4) parts.push(`UNTIL=${stamp(start + int(30, 900) * DAY, allDay ? 'date' : zone === 'floating' && chance(0.8) ? 'local' : 'utc')}`);
  } else if (kind === 'cal') {
    // MONTHLY and YEARLY from years back: ordinals, negative month days,
    // BYSETPOS, BYMONTH, BYWEEKNO
    start = Date.UTC(1995 + int(0, 20), int(0, 11), int(1, 31)) / 1000 + (allDay ? 0 : int(0, 47) * 1800);
    duration = allDay ? DAY : pick([900, 3600, 3 * 3600, 26 * 3600]);
    const yearly = chance(0.4);
    parts.push(yearly ? 'FREQ=YEARLY' : 'FREQ=MONTHLY');
    if (chance(0.4)) parts.push(`INTERVAL=${int(2, 3)}`);
    const wd = () => pick(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
    const variant = pick(['plain', 'plain', 'ordinal', 'monthday', 'setpos', 'bymonth', 'sparse', 'sparse', ...(yearly ? ['weekno'] : [])]);
    // periods that can be empty: the 31st, 29 February, a fifth weekday,
    // day 366, week 53, BYSETPOS past the set; and DTSTART on the 29th-31st
    if (variant === 'sparse') {
      if (chance(0.3)) start = Date.UTC(1995 + int(0, 20), pick([0, 1, 2, 4, 6, 7, 9, 11]), int(29, 31)) / 1000 + (allDay ? 0 : int(0, 47) * 1800);
      parts.push(yearly
        ? pick(['BYMONTH=2;BYMONTHDAY=29', 'BYMONTH=2;BYMONTHDAY=-29', 'BYYEARDAY=366', 'BYYEARDAY=-366', `BYWEEKNO=53;BYDAY=${wd()}`, 'BYMONTH=4,6;BYMONTHDAY=31', '', ''])
        : pick(['BYMONTHDAY=29', 'BYMONTHDAY=31', 'BYMONTHDAY=-31', 'BYMONTHDAY=31,-31', 'BYMONTHDAY=30,31', `BYDAY=5${wd()}`, `BYDAY=-5${wd()}`,
          'BYDAY=MO;BYSETPOS=5', 'BYDAY=MO,TU,WE,TH,FR;BYSETPOS=23', '']));
      if (parts[parts.length - 1] === '') parts.pop();
    }
    if (variant === 'ordinal') parts.push(`BYDAY=${pick(['1', '2', '3', '-1', '-2'])}${wd()}`, ...(yearly ? [`BYMONTH=${int(1, 12)}`] : []));
    if (variant === 'monthday') parts.push(`BYMONTHDAY=${pick(['-1', '-2', '1', '15', '31', '30,-1'])}`, ...(yearly ? [`BYMONTH=${int(1, 12)}`] : []));
    if (variant === 'setpos') parts.push('BYDAY=MO,TU,WE,TH,FR', `BYSETPOS=${pick(['1', '-1', '2', '1,-1'])}`, ...(yearly ? [`BYMONTH=${int(1, 12)}`] : []));
    if (variant === 'bymonth') parts.push(`BYMONTH=${int(1, 12)},${int(1, 12)}`);
    if (!allDay && chance(0.15)) parts.push(`BYHOUR=${int(12, 23)},${int(0, 11)}`);
    if (variant === 'weekno') parts.push(`BYWEEKNO=${int(1, 52)}`, ...(chance(0.5) ? [`BYDAY=${wd()}`] : []));
    const end = random();
    if (end < 0.15) parts.push(`COUNT=${int(5, 400)}`);
    else if (end < 0.3) parts.push(`UNTIL=${stamp(start + int(300, 12000) * DAY, allDay ? 'date' : zone === 'floating' ? 'local' : 'utc')}`);
  } else if (kind === 'sub') {
    // hourly or every few minutes, starting weeks before the range
    start = Date.UTC(2026, 0, 1) / 1000 + int(0, 300) * DAY + int(0, 95) * 900;
    duration = pick([300, 900, 3600, 5 * 3600]);
    const hourly = chance(0.6);
    parts.push(hourly ? 'FREQ=HOURLY' : 'FREQ=MINUTELY');
    parts.push(`INTERVAL=${hourly ? int(1, 7) : pick([15, 20, 45, 90])}`);
    if (chance(0.4)) parts.push(`BYDAY=${['MO', 'WE', 'FR', 'SA'].filter(() => chance(0.5)).join(',') || 'TU'}`);
    if (hourly && chance(0.2)) parts.push(`BYMINUTE=0,${pick([15, 30, 45])}`);
    // limiting, not expanding: ical.js does not step it on a fixed grid
    if (hourly && chance(0.15)) parts.push(`BYHOUR=${int(0, 7)},${int(8, 15)},${int(16, 23)}`);
    if (chance(0.2)) parts.push(`COUNT=${int(50, 3000)}`);
  } else {
    // too dense for the cap: COUNT with BYDAY cannot be shifted (see shiftPlan)
    start = Date.UTC(2026, 0, 1) / 1000 + int(0, 300) * DAY;
    duration = 600;
    parts.push('FREQ=MINUTELY', 'BYDAY=MO,TU,WE,TH,FR', 'COUNT=60000');
  }
  // RFC 5545 3.6.1: an all-day event without DTEND or DURATION lasts its day
  return { kind, zone, allDay, start, duration, rrule: parts.join(';'), noEnd: allDay && chance(0.3) };
}

function masterLines(s, extra = []) {
  return [
    'BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Series',
    prop('DTSTART', s.start, s.zone, s.allDay),
    ...(s.noEnd ? [] : [s.allDay ? `DURATION:P${s.duration / DAY}D` : `DURATION:PT${s.duration}S`]),
    `RRULE:${s.rrule}`,
    ...(s.transparent ? ['TRANSP:TRANSPARENT'] : []),
    ...extra,
    'END:VEVENT',
  ];
}

function document(vevents, zone) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    NEW_YORK, ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');
}

const parse = (text) => shareTimezones(new ICAL.Component(ICAL.parse(text)));
function seriesOf(text) {
  const root = parse(text);
  const { master, overrides } = readSeries(root, 'vevent');
  return relateSeries(master, overrides);
}

// the UTC instant (seconds) of wall-clock seconds in an ICAL zone
const instantIn = (zone, wall) => {
  const d = new Date(wall * 1000);
  return ICAL.Time.fromData({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() }, zone).toUnixTime();
};

const SEARCH = /Override (into|future|retitled)/;
const matches = (vevent) => SEARCH.test(String(vevent.getFirstPropertyValue('summary')));

// Wall clocks as ms of their digits read as UTC
const wallOfText = (text) => {
  const [y, mo, d, h = 0, mi = 0, sec = 0] = text.match(/\d+/g).map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, sec);
};
const wallText = (wall) => new Date(wall).toISOString().slice(0, 19);
const fieldsWall = (t) => Date.UTC(t.year, t.month - 1, t.day, t.isDate ? 0 : t.hour, t.isDate ? 0 : t.minute, t.isDate ? 0 : t.second);
const ridKey = (o) => wallText(fieldsWall(o.recurrenceId));
const describe = (list) => list.map((o) => `${ridKey(o)}|${spanOf(o).start}|${spanOf(o).end}|${o.item.summary}`);
const byStart = (a, b) => spanOf(a).start - spanOf(b).start || fieldsWall(a.recurrenceId) - fieldsWall(b.recurrenceId);

/**
 * The frame of a DTSTART property, written apart from src/occurrences.js:
 * wall clock <-> instant. A TZID by tsdav-utils (the library's zone reading
 * is its own tests' business), floating times and dates on the host clock:
 * the objects here come from no calendar, so dav-mcp reads them in the zone
 * it runs in (src/calendar-zone.js).
 */
const hostWall = (ms) => { const d = new Date(ms); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()); };
const hostInstant = (w) => { const d = new Date(w); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()).getTime(); };
function frameOf(property) {
  const value = property.getFirstValue();
  if (value.isDate) return { toWall: (ms) => Math.floor(hostWall(ms) / 864e5) * 864e5, toInstant: hostInstant };
  if (property.getParameter('tzid')) {
    const zone = resolvePropertyZone(property);
    return {
      toWall: (ms) => wallOfText(zone.toWallTime(new Date(ms))),
      toInstant: (w) => zone.toInstant(wallText(w)).getTime(),
    };
  }
  if (/Z$/.test(String(property.toJSON()[3]))) return { toWall: (ms) => ms, toInstant: (w) => w };
  return { toWall: hostWall, toInstant: hostInstant };
}

/** A library OccurrenceTime as an instant: its own, else (a date, a floating time) on the host clock */
const instantOfTime = (t, floating) => (t.instant ? Date.parse(t.instant) : floating.toInstant(wallOfText(t.value)));

/** The object with the master and the given overrides only */
function objectWith(root, master, overrides) {
  const copy = new ICAL.Component(['vcalendar', [], []]);
  for (const c of [...root.getAllSubcomponents('vtimezone'), master, ...overrides]) {
    copy.addSubcomponent(new ICAL.Component(structuredClone(c.toJSON())));
  }
  return copy;
}

/**
 * The reference: tsdav-utils' expansion from DTSTART with no budget to
 * speak of (no near-range start, no window), and on top of it, written apart
 * from src/occurrences.js, what dav-mcp adds: THISANDFUTURE overrides move
 * the later occurrences, and each occurrence is judged where it now is.
 */
export function reference(text, horizon) {
  const root = parse(text);
  const { master, overrides } = readSeries(root, 'vevent');
  const big = () => createRecurrenceBudget(5e8);
  // past every override's RECURRENCE-ID, wherever it was moved to
  const latest = Math.max(0, ...overrides.map((c) => {
    try { return fieldsWall(c.getFirstPropertyValue('recurrence-id')); } catch { return 0; }
  }));
  const until = wallText(Math.max(horizon, latest + 3 * 864e5));
  const floating = { toInstant: hostInstant };

  // where the library places each override, asked of it alone
  const usable = [];
  const placed = new Map();
  for (const c of overrides) {
    let result;
    try {
      result = expandOccurrences(objectWith(root, master, [c]), { budget: big(), until, limit: Number.MAX_SAFE_INTEGER });
    } catch {
      continue; // the library cannot place it: it names nothing
    }
    usable.push(c);
    const hit = result.occurrences.find((o) => o.overridden);
    if (hit) placed.set(wallOfText(hit.recurrenceId.value), c); // a later one replaces it
  }
  let full;
  try {
    full = expandOccurrences(objectWith(root, master, usable), { budget: big(), until, limit: Number.MAX_SAFE_INTEGER });
  } catch {
    return null; // a series the library cannot read: nothing, reported incomplete
  }
  const seriesFrame = frameOf(master.getFirstProperty('dtstart'));
  const events = new Map(usable.map((c) => [c, new ICAL.Event(c)]));
  const masterEvent = new ICAL.Event(master, { exceptions: [] });

  const futures = [...placed]
    .filter(([, c]) => String(c.getFirstProperty('recurrence-id').getParameter('range') ?? '').toUpperCase() === 'THISANDFUTURE')
    .sort((x, y) => x[0] - y[0]);

  const occurrences = full.occurrences.map((o) => {
    const wall = wallOfText(o.recurrenceId.value);
    const recurrenceId = ICAL.Time.fromDateTimeString(wallText(wall));
    if (o.recurrenceId.value.length === 10) recurrenceId.isDate = true;
    const startAt = instantOfTime(o.start, floating);
    // no end given: a date lasts its day, a date-time no time (RFC 5545 3.6.1)
    const endAt = o.end ? instantOfTime(o.end, floating) : o.start.value.length === 10 ? startAt + 864e5 : startAt;
    if (o.overridden) return { recurrenceId, startAt, endAt, item: events.get(placed.get(wall)) };
    const future = futures.filter(([w]) => w <= wall).pop();
    if (!future) return { recurrenceId, startAt, endAt, item: masterEvent };
    // its own move, on its own wall clock, and its own length
    const [fWall, c] = future;
    const event = events.get(c);
    const own = frameOf(c.getFirstProperty('dtstart'));
    const ownStart = fieldsWall(event.startDate);
    const move = ownStart - own.toWall(seriesFrame.toInstant(fWall));
    const length = fieldsWall(event.endDate ?? event.startDate) - ownStart;
    const startWall = own.toWall(seriesFrame.toInstant(wall)) + move;
    return { recurrenceId, startAt: own.toInstant(startWall), endAt: own.toInstant(startWall + length), item: event };
  });
  return { occurrences: occurrences.sort(byStart) };
}

// imported for its reference (diagnostics): no run
const main = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

let compared = 0;
let deviations = 0;
let truncated = 0;
const examples = [];

for (let n = 0; main && n < CASES; n++) {
  const s = series();
  s.transparent = chance(0.15);
  const sub = s.kind === 'sub' || s.kind === 'dense';
  const cal = s.kind === 'cal';
  const reach = sub ? 3 * DAY : cal ? 400 * DAY : 120 * DAY;

  // the instances of the bare series near where the range will be, to pick
  // override and EXDATE targets from
  const rangeStart = sub
    ? s.start + (s.kind === 'dense' ? int(27, 31) : int(0, 60)) * DAY + int(0, 95) * 900
    : cal ? Date.UTC(2024, 0, 1) / 1000 + int(0, 1000) * DAY + int(0, 47) * 1800
      : s.start + int(-30, 1200) * DAY + int(0, 47) * 1800;
  const rangeEnd = rangeStart + pick(sub ? [900, 3600, 6 * 3600, DAY]
    : cal ? [DAY, 7 * DAY, 31 * DAY, 92 * DAY] : [3600, 4 * 3600, DAY, 3 * DAY, 10 * DAY, 20 * DAY]);
  const bare = seriesOf(document([masterLines(s)], s.zone)).event;
  const ids = [];
  const walk = new ICAL.RecurExpansion({ component: bare.component, dtstart: bare.startDate });
  for (let step = 0; step < 120000; step++) {
    const next = walk.next();
    if (!next) break;
    const wall = wallOf(next);
    if (wall > rangeEnd + 2 * reach) break;
    if (wall > rangeStart - 2 * reach || ids.length < 50) ids.push(wall);
  }
  const near = ids.filter((id) => Math.abs(id - rangeStart) < reach);
  const target = () => (near.length && chance(0.7) ? pick(near) : pick(ids));

  const overrides = [];
  const used = new Set();
  const count = ids.length ? int(0, 6) : 0;
  for (let k = 0; k < count; k++) {
    let id = target();
    if (used.has(id)) continue;
    used.add(id);
    const kind = pick(['into', 'into', 'out', 'within', 'cancelled', 'transparent', 'retitled', 'future', 'orphan', 'past-end']);
    let begin = id;
    let length = s.duration;
    const lines = [];
    if (kind === 'into') {
      begin = rangeStart + int(-2, Math.max(0, Math.floor((rangeEnd - rangeStart) / 900))) * 900;
      length = s.allDay ? DAY : pick([0, 900, 3600, 2 * DAY]);
    } else if (kind === 'out') {
      begin = id + pick([-1, 1]) * int(sub ? 1 : 5, sub ? 3 : 120) * (sub ? 3600 : DAY);
    } else if (kind === 'within') {
      begin = id + int(-6, 6) * (sub ? 300 : 1800);
    } else if (kind === 'cancelled') {
      lines.push(pick(['STATUS:CANCELLED', 'STATUS:cancelled']));
    } else if (kind === 'transparent') {
      lines.push(pick(['TRANSP:TRANSPARENT', 'TRANSP:transparent']));
    } else if (kind === 'future') {
      begin = id + pick([-1, 1]) * (sub ? int(1, 20) * 600 : int(1, 30) * DAY) + (s.allDay || sub ? 0 : int(-4, 4) * 1800);
    } else if (kind === 'past-end') {
      // on the rule's grid, but after its UNTIL or COUNT: no occurrence
      if (!/UNTIL|COUNT/.test(s.rrule) || ids.length < 2) continue;
      id = ids[ids.length - 1] + (ids[ids.length - 1] - ids[ids.length - 2]) * int(1, 3);
      begin = rangeStart + int(0, 3) * 900;
    } else if (kind === 'orphan') {
      if (s.allDay) continue;
      id += 7; // seconds: no rule here yields those
    }
    if (s.allDay) begin -= begin % DAY;
    if (chance(0.2)) lines.push('TRANSP:OPAQUE');
    if (chance(0.1)) lines.push('STATUS:CANCELLED');
    const range = kind === 'future' || (kind === 'orphan' && chance(0.5)) ? ';RANGE=THISANDFUTURE' : '';
    // an override may name its RECURRENCE-ID in another frame than DTSTART:
    // UTC for a zoned series, or a zoned or floating one in UTC
    let idLine = prop('RECURRENCE-ID', id, s.zone, s.allDay, range);
    if (!s.allDay && chance(0.1)) {
      // a date naming a timed occurrence: the series' time of day on it
      idLine = `RECURRENCE-ID;VALUE=DATE${range}:${stamp(id, 'date')}`;
    } else if (!s.allDay && s.zone === 'ny' && chance(0.3)) {
      idLine = `RECURRENCE-ID${range}:${stamp(instantIn(NY, id), 'utc')}`;
    } else if (!s.allDay && s.zone === 'floating' && chance(0.3)) {
      // the floating wall clock read on this host, written in UTC
      const d = new Date(id * 1000);
      const host = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
      idLine = `RECURRENCE-ID${range}:${stamp(host.getTime() / 1000, 'utc')}`;
    } else if (!s.allDay && s.zone === 'utc' && chance(0.3)) {
      idLine = `RECURRENCE-ID;TZID=America/New_York${range}:${stamp(wallOf(ICAL.Time.fromJSDate(new Date(id * 1000), true).convertToZone(NY)), 'local')}`;
    }
    overrides.push([
      'BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', `SUMMARY:Override ${kind}`,
      idLine,
      prop('DTSTART', begin, s.zone, s.allDay),
      ...(s.allDay && chance(0.3) ? [] : [s.allDay ? `DURATION:P${Math.max(1, length / DAY)}D` : `DURATION:PT${length}S`]),
      ...lines,
      'END:VEVENT',
    ]);
  }

  const exdates = [];
  if (ids.length && chance(0.4)) {
    const victim = chance(0.5) && used.size ? pick([...used]) : target();
    if (!s.allDay && s.zone === 'floating' && chance(0.4)) {
      // the floating wall clock read on this host, written in UTC
      const d = new Date(victim * 1000);
      const host = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
      exdates.push(`EXDATE:${stamp(host.getTime() / 1000, 'utc')}`);
    } else {
      exdates.push(prop('EXDATE', victim, s.zone, s.allDay));
    }
  }

  const vevents = chance(0.7) ? [masterLines(s, exdates), ...overrides] : [...overrides, masterLines(s, exdates)];
  const text = document(vevents, s.zone);
  const range = { start: rangeStart * 1000, end: rangeEnd * 1000 };
  // the generator's times are wall clock; the range is read as an instant
  const timeRange = { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() };

  const ref = reference(text, range.end + (sub ? 3 * DAY : 400 * DAY) * 1000);
  const occurrences = ref ? ref.occurrences : [];
  const touching = occurrences.filter((o) => touchesRange(spanOf(o).start, spanOf(o).end, range));

  const expected = {
    touching,
    busy: touching.filter((o) => spanOf(o).end > spanOf(o).start && blocksTime(o.item.component)),
    shown: touching.slice(0, 1),
    search: touching.filter((o) => matches(o.item.component)).slice(0, 1),
  };
  // now and then a budget too small for the case: what comes back must
  // then be incomplete at most, never wrong
  const small = chance(0.15) ? int(5, 2000) : null;
  const budget = () => (small ? createRecurrenceBudget(small) : undefined);
  const fast = {
    touching: () => seriesOccurrences(seriesOf(text), range, { budget: budget() }),
    busy: () => busyOccurrencesOf(parse(text), range, budget()),
    shown: () => {
      const shown = shownEvent(parse(text), timeRange, null, budget());
      return { occurrences: shown.occurrence ? [shown.occurrence] : [], truncated: shown.expansionTruncated };
    },
    search: () => {
      const shown = shownEvent(parse(text), timeRange, matches, budget());
      return { occurrences: shown.occurrence ? [shown.occurrence] : [], truncated: shown.expansionTruncated };
    },
  };

  for (const name of Object.keys(expected)) {
    compared++;
    const result = fast[name]();
    const want = describe(expected[name]);
    const got = describe(result.occurrences);
    let ok;
    if (!ref) {
      ok = result.truncated && result.occurrences.length === 0;
    } else if (result.truncated) {
      // the cap was hit: it may miss occurrences, but must not invent one
      truncated++;
      const all = new Set(describe(touching));
      ok = got.every((o) => all.has(o));
    } else {
      ok = JSON.stringify(want) === JSON.stringify(got);
    }
    if (!ok) {
      deviations++;
      if (examples.length < 3) {
        examples.push({ n, name, rrule: s.rrule, zone: s.zone, allDay: s.allDay, timeRange, want, got, text });
      }
    }
  }
}

if (main) console.log(JSON.stringify({ cases: CASES, compared, deviations, truncated, examples }));
