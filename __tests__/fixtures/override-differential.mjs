// Differential check of seriesOccurrences (src/ical-components.js) against a
// plain expansion from DTSTART, for random series with random overrides —
// moved into, out of and within the range, cancelled, transparent, retitled,
// RANGE=THISANDFUTURE, orphaned, EXDATEd — and random ranges. Run in a child
// process whose timezone the parent sets via TZ: a floating time becomes an
// instant only on the host clock. Prints one JSON line:
// { cases, compared, deviations, truncated, examples }.
//
// argv[2]: number of series (default 400), argv[3]: seed (default 98)
import ICAL from 'ical.js';
import { readSeries, seriesOccurrences } from '../../src/ical-components.js';
import { shareTimezones, toInstant } from '../../src/tools/shared/ical-dates.js';
import { blocksTime } from '../../src/tools/shared/freebusy.js';

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

const pad = (n, w = 2) => String(n).padStart(w, '0');
// a unix time written in the series' form: wall clock digits for a zoned or
// floating series (the digits are what matters for the rule), a date if all-day
function stamp(unix, form) {
  const d = new Date(unix * 1000);
  const date = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  if (form === 'date') return date;
  const time = `${date}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
  return form === 'utc' ? `${time}Z` : time;
}
function prop(name, unix, zone, allDay, params = '') {
  if (allDay) return `${name};VALUE=DATE${params}:${stamp(unix, 'date')}`;
  if (zone === 'utc') return `${name}${params}:${stamp(unix, 'utc')}`;
  if (zone === 'ny') return `${name};TZID=America/New_York${params}:${stamp(unix, 'local')}`;
  return `${name}${params}:${stamp(unix, 'local')}`;
}
// an ICAL.Time back to the "wall clock as UTC" unix the generator works in
// wall clock digits (as the generator's unix) read in an ICAL zone
const instantIn = (zone, unix) => {
  const d = new Date(unix * 1000);
  return ICAL.Time.fromData({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
    hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: 0 }, zone).toUnixTime();
};
const wall = (time) => Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second) / 1000;

function series() {
  const zone = pick(['utc', 'ny', 'floating']);
  const allDay = chance(0.15);
  const start = Date.UTC(2023, 0, 1) / 1000 + int(0, 1100) * DAY + (allDay ? 0 : int(0, 47) * 1800);
  const duration = allDay ? int(1, 3) * DAY : pick([900, 3600, 3 * 3600, 26 * 3600, 3 * DAY]);

  const parts = [];
  const freq = pick(['DAILY', 'DAILY', 'WEEKLY', 'WEEKLY', 'MONTHLY']);
  parts.push(`FREQ=${freq}`);
  if (freq !== 'MONTHLY' && chance(0.5)) parts.push(`INTERVAL=${int(2, 3)}`);
  if (freq === 'WEEKLY' && chance(0.6)) {
    const days = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].filter(() => chance(0.4));
    if (days.length) parts.push(`BYDAY=${days.join(',')}`);
  }
  if (freq === 'DAILY' && chance(0.15)) parts.push(`BYMONTH=${int(1, 12)},${int(1, 12)}`);
  const end = random();
  if (end < 0.2) parts.push(`COUNT=${int(5, 400)}`);
  else if (end < 0.4) parts.push(`UNTIL=${allDay ? stamp(start + int(30, 900) * DAY, 'date') : stamp(start + int(30, 900) * DAY, 'utc')}`);

  return { zone, allDay, start, duration, rrule: parts.join(';') };
}

function masterLines(s, extra = []) {
  return [
    'BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Series',
    prop('DTSTART', s.start, s.zone, s.allDay),
    s.allDay ? `DURATION:P${s.duration / DAY}D` : `DURATION:PT${s.duration}S`,
    `RRULE:${s.rrule}`,
    ...(chance(0.15) ? ['TRANSP:TRANSPARENT'] : []),
    ...extra,
    'END:VEVENT',
  ];
}

function document(vevents, zone) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//test//EN',
    ...(zone === 'ny' ? [NEW_YORK] : []), ...vevents.flat(), 'END:VCALENDAR'].join('\r\n');
}

function eventOf(text) {
  const root = shareTimezones(new ICAL.Component(ICAL.parse(text)));
  const { master, overrides } = readSeries(root, 'vevent');
  const event = new ICAL.Event(master);
  for (const override of overrides) event.relateException(override);
  return event;
}

// the reference: every recurrence id from DTSTART on, up to `horizon`
function naive(event, horizon, accept, first) {
  const expansion = new ICAL.RecurExpansion({ component: event.component, dtstart: event.startDate });
  const out = [];
  for (let step = 0; step < 500000; step++) {
    const next = expansion.next();
    if (!next || next.toUnixTime() > horizon) break;
    const occurrence = event.getOccurrenceDetails(next);
    if (accept(occurrence)) out.push(occurrence);
  }
  out.sort((a, b) => a.startDate.toUnixTime() - b.startDate.toUnixTime()
    || a.recurrenceId.toUnixTime() - b.recurrenceId.toUnixTime());
  return first ? out.slice(0, 1) : out;
}

const describe = (list) => list.map((o) =>
  `${o.recurrenceId}|${o.startDate}|${o.endDate}|${o.item.summary}`);

let compared = 0;
let deviations = 0;
let truncated = 0;
const examples = [];

for (let n = 0; n < CASES; n++) {
  const s = series();
  // the instances of the bare series, to pick override and EXDATE targets
  const bare = eventOf(document([masterLines(s)], s.zone));
  const ids = [];
  const walk = new ICAL.RecurExpansion({ component: bare.component, dtstart: bare.startDate });
  for (let step = 0; step < 3000; step++) {
    const next = walk.next();
    if (!next) break;
    ids.push(wall(next));
  }

  const rangeStart = s.start + int(-30, 1200) * DAY + int(0, 47) * 1800;
  const rangeEnd = rangeStart + pick([3600, 4 * 3600, DAY, 3 * DAY, 10 * DAY, 20 * DAY]);
  const near = ids.filter((id) => Math.abs(id - rangeStart) < 90 * DAY);
  const target = () => (near.length && chance(0.7) ? pick(near) : pick(ids));

  const overrides = [];
  const used = new Set();
  const count = ids.length ? int(0, 6) : 0;
  for (let k = 0; k < count; k++) {
    let id = target();
    if (used.has(id)) continue;
    used.add(id);
    const kind = pick(['into', 'into', 'out', 'within', 'cancelled', 'transparent', 'retitled', 'future', 'orphan']);
    let begin = id;
    let length = s.duration;
    const lines = [];
    if (kind === 'into') {
      begin = rangeStart + int(-2, Math.max(0, Math.floor((rangeEnd - rangeStart) / 1800))) * 1800;
      length = s.allDay ? DAY : pick([900, 3600, 2 * DAY]);
    } else if (kind === 'out') {
      begin = id + pick([-1, 1]) * int(5, 120) * DAY;
    } else if (kind === 'within') {
      begin = id + int(-6, 6) * 1800;
    } else if (kind === 'cancelled') {
      lines.push('STATUS:CANCELLED');
    } else if (kind === 'transparent') {
      lines.push('TRANSP:TRANSPARENT');
    } else if (kind === 'future') {
      begin = id + pick([-1, 1]) * int(1, 30) * DAY + (s.allDay ? 0 : int(-4, 4) * 1800);
    } else if (kind === 'orphan') {
      if (s.allDay) continue;
      id += 7 * 60; // no instance of the rule: every one is on a half hour
    }
    if (s.allDay) begin -= begin % DAY;
    if (chance(0.2)) lines.push('TRANSP:OPAQUE');
    if (chance(0.1)) lines.push('STATUS:CANCELLED');
    // a zoned series' override may name its RECURRENCE-ID in UTC
    const idZone = s.zone === 'ny' && chance(0.3) ? 'ny-as-utc' : s.zone;
    const range = kind === 'future' ? ';RANGE=THISANDFUTURE' : '';
    const idLine = idZone === 'ny-as-utc'
      ? `RECURRENCE-ID${range}:${stamp(instantIn(bare.startDate.zone, id), 'utc')}`
      : prop('RECURRENCE-ID', id, s.zone, s.allDay, range);
    overrides.push([
      'BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', `SUMMARY:Override ${kind}`,
      idLine,
      prop('DTSTART', begin, s.zone, s.allDay),
      s.allDay ? `DURATION:P${Math.max(1, length / DAY)}D` : `DURATION:PT${length}S`,
      ...lines,
      'END:VEVENT',
    ]);
  }

  const exdates = [];
  if (ids.length && chance(0.4)) {
    const victims = [chance(0.5) && used.size ? pick([...used]) : target()];
    for (const id of victims) exdates.push(prop('EXDATE', id, s.zone, s.allDay));
  }

  const masterFirst = chance(0.7);
  const vevents = masterFirst ? [masterLines(s, exdates), ...overrides] : [...overrides, masterLines(s, exdates)];
  let event;
  try {
    event = eventOf(document(vevents, s.zone));
  } catch (error) {
    examples.push({ n, error: String(error) });
    deviations++;
    continue;
  }

  const range = { start: rangeStart, end: rangeEnd };
  // the generator's times are wall clock; the range is an instant
  const window = { start: range.start, end: range.end };
  const rs = ICAL.Time.fromJSDate(new Date(range.start * 1000), true);
  const re = ICAL.Time.fromJSDate(new Date(range.end * 1000), true);
  const lastOverride = Math.max(0, ...Object.values(event.exceptions).map((e) => e.recurrenceId.toUnixTime()));
  const horizon = Math.max(range.end + 200 * DAY, lastOverride + 2 * DAY);

  const accepts = {
    // free/busy (src/tools/shared/freebusy.js)
    busy: [(o) => blocksTime(o.item.component)
      && toInstant(o.startDate) < range.end * 1000 && toInstant(o.endDate) > range.start * 1000, false],
    // everything touching the range, whatever its status
    touching: [(o) => toInstant(o.startDate) < range.end * 1000 && toInstant(o.endDate) > range.start * 1000, false],
    // shownEvent: the first occurrence starting in the range ...
    shown: [(o) => o.startDate.compare(rs) >= 0 && o.startDate.compare(re) <= 0, true],
    // ... that a search accepts
    search: [(o) => o.startDate.compare(rs) >= 0 && o.startDate.compare(re) <= 0
      && /Override (into|future|retitled)/.test(o.item.summary), true],
  };

  for (const [name, [accept, first]] of Object.entries(accepts)) {
    compared++;
    const fast = seriesOccurrences(event, window, accept, { first });
    if (fast.truncated) truncated++;
    const expected = describe(naive(event, horizon, accept, first));
    const actual = describe(fast.occurrences);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      deviations++;
      if (examples.length < 3) {
        examples.push({ n, name, rrule: s.rrule, zone: s.zone, allDay: s.allDay, range, expected, actual,
          ics: document(vevents, s.zone) });
      }
    }
  }
}

console.log(JSON.stringify({ cases: CASES, compared, deviations, truncated, examples }));
