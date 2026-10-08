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
import { shareTimezones, toInstant } from '../../src/tools/shared/ical-dates.js';
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
  const kind = random() < 1 / 32 ? 'dense' : pick(['day', 'day', 'sub']);
  const zone = pick(['utc', 'ny', 'floating']);
  const allDay = kind === 'day' && chance(0.15);
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
    if (freq !== 'MONTHLY' && !allDay && chance(0.15)) parts.push(`BYHOUR=${int(0, 11)},${int(12, 23)}`);
    const end = random();
    if (end < 0.2) parts.push(`COUNT=${int(5, 400)}`);
    else if (end < 0.4) parts.push(`UNTIL=${allDay ? stamp(start + int(30, 900) * DAY, 'date') : stamp(start + int(30, 900) * DAY, 'utc')}`);
  } else if (kind === 'sub') {
    // hourly or every few minutes, starting weeks before the range
    start = Date.UTC(2026, 0, 1) / 1000 + int(0, 300) * DAY + int(0, 95) * 900;
    duration = pick([300, 900, 3600, 5 * 3600]);
    const hourly = chance(0.6);
    parts.push(hourly ? 'FREQ=HOURLY' : 'FREQ=MINUTELY');
    parts.push(`INTERVAL=${hourly ? int(1, 7) : pick([15, 20, 45, 90])}`);
    if (chance(0.4)) parts.push(`BYDAY=${['MO', 'WE', 'FR', 'SA'].filter(() => chance(0.5)).join(',') || 'TU'}`);
    if (hourly && chance(0.2)) parts.push(`BYMINUTE=0,${pick([15, 30, 45])}`);
    if (chance(0.2)) parts.push(`COUNT=${int(50, 3000)}`);
  } else {
    // too dense for the cap: COUNT with BYDAY cannot be shifted (see shiftPlan)
    start = Date.UTC(2026, 0, 1) / 1000 + int(0, 300) * DAY;
    duration = 600;
    parts.push('FREQ=MINUTELY', 'BYDAY=MO,TU,WE,TH,FR', 'COUNT=60000');
  }
  return { kind, zone, allDay, start, duration, rrule: parts.join(';') };
}

function masterLines(s, extra = []) {
  return [
    'BEGIN:VEVENT', 'UID:s@test', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Series',
    prop('DTSTART', s.start, s.zone, s.allDay),
    s.allDay ? `DURATION:P${s.duration / DAY}D` : `DURATION:PT${s.duration}S`,
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

const byStart = (a, b) => spanOf(a).start - spanOf(b).start || toInstant(a.recurrenceId) - toInstant(b.recurrenceId);
const describe = (list) => list.map((o) => `${o.recurrenceId}|${o.startDate}|${o.endDate}|${o.item.summary}`);
const SEARCH = /Override (into|future|retitled)/;
const matches = (vevent) => SEARCH.test(String(vevent.getFirstPropertyValue('summary')));

// An instant in the frame of `like`: a date as its UTC day, UTC, its zone, or
// floating — the host clock (written apart from src/occurrences.js on purpose)
function inFrame(ms, like) {
  const d = new Date(ms);
  if (like.isDate) return new ICAL.Time({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), isDate: true });
  if (like.zone === ICAL.Timezone.utcTimezone) return ICAL.Time.fromJSDate(d, true);
  if (like.zone && like.zone !== ICAL.Timezone.localTimezone && like.zone.tzid !== 'floating') {
    return ICAL.Time.fromJSDate(d, true).convertToZone(like.zone);
  }
  return new ICAL.Time({ year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(),
    hour: d.getHours(), minute: d.getMinutes(), second: d.getSeconds() });
}

function reference(text, range, sub) {
  const root = parse(text);
  const { master, overrides } = readSeries(root, 'vevent');
  const event = new ICAL.Event(master, { exceptions: [] });
  const start = event.startDate;
  // each override by the instant its RECURRENCE-ID names; a date naming a
  // timed series: the series' time that day
  const named = new Map();
  for (const component of overrides) {
    const override = new ICAL.Event(component);
    const rid = override.recurrenceId;
    let at;
    if (rid.isDate && !start.isDate) {
      const t = start.clone();
      t.year = rid.year; t.month = rid.month; t.day = rid.day;
      at = toInstant(t);
    } else {
      const property = component.getFirstProperty('recurrence-id');
      const tzid = property.getParameter('tzid');
      at = rid.isDate ? toInstant(rid)
        : tzid ? toInstant(rid) // the document's zone resolves through shareTimezones
          : /Z$/.test(String(property.toJSON()[3])) ? rid.toUnixTime() * 1000 : toInstant(rid);
      if (start.isDate) at = Date.UTC(new Date(at).getUTCFullYear(), new Date(at).getUTCMonth(), new Date(at).getUTCDate());
    }
    named.set(at, override); // a later one with the same id replaces it
  }

  const lastOverride = Math.max(0, ...named.keys());
  const horizon = Math.max(range.end + (sub ? 2 * DAY : 200 * DAY) * 1000, lastOverride + 2 * DAY * 1000);
  const ids = [];
  const expansion = new ICAL.RecurExpansion({ component: master, dtstart: start });
  for (let step = 0; step < 300000; step++) {
    const next = expansion.next();
    if (!next || toInstant(next) > horizon) break;
    ids.push(next);
  }
  const futures = ids
    .filter((id) => named.get(toInstant(id))?.modifiesFuture())
    .map((id) => ({ at: toInstant(id), override: named.get(toInstant(id)) }));

  const occurrences = ids.map((id) => {
    const at = toInstant(id);
    const exact = named.get(at);
    if (exact) return { recurrenceId: id, startDate: exact.startDate, endDate: exact.endDate, item: exact };
    const future = futures.filter((f) => f.at <= at).pop();
    if (!future) {
      const endDate = id.clone();
      endDate.addDuration(event.duration);
      return { recurrenceId: id, startDate: id, endDate, item: event };
    }
    const { override } = future;
    // its move, as wall-clock time in its own frame, applied to this id
    const move = override.startDate.subtractDate(inFrame(future.at, override.startDate));
    const startDate = inFrame(at, override.startDate);
    startDate.addDuration(move);
    const endDate = startDate.clone();
    endDate.addDuration(override.duration);
    return { recurrenceId: id, startDate, endDate, item: override };
  });
  return { occurrences: occurrences.sort(byStart) };
}

let compared = 0;
let deviations = 0;
let truncated = 0;
const examples = [];

for (let n = 0; n < CASES; n++) {
  const s = series();
  s.transparent = chance(0.15);
  const sub = s.kind !== 'day';
  const reach = sub ? 3 * DAY : 120 * DAY;

  // the instances of the bare series near where the range will be, to pick
  // override and EXDATE targets from
  const rangeStart = sub
    ? s.start + (s.kind === 'dense' ? int(8, 11) : int(0, 60)) * DAY + int(0, 95) * 900
    : s.start + int(-30, 1200) * DAY + int(0, 47) * 1800;
  const rangeEnd = rangeStart + pick(sub ? [900, 3600, 6 * 3600, DAY] : [3600, 4 * 3600, DAY, 3 * DAY, 10 * DAY, 20 * DAY]);
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
    const kind = pick(['into', 'into', 'out', 'within', 'cancelled', 'transparent', 'retitled', 'future', 'orphan']);
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
    if (!s.allDay && s.zone === 'ny' && chance(0.3)) {
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
      s.allDay ? `DURATION:P${Math.max(1, length / DAY)}D` : `DURATION:PT${length}S`,
      ...lines,
      'END:VEVENT',
    ]);
  }

  const exdates = [];
  if (ids.length && chance(0.4)) {
    const victim = chance(0.5) && used.size ? pick([...used]) : target();
    exdates.push(prop('EXDATE', victim, s.zone, s.allDay));
  }

  const vevents = chance(0.7) ? [masterLines(s, exdates), ...overrides] : [...overrides, masterLines(s, exdates)];
  const text = document(vevents, s.zone);
  const range = { start: rangeStart * 1000, end: rangeEnd * 1000 };
  // the generator's times are wall clock; the range is read as an instant
  const timeRange = { start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() };

  // the reference: every recurrence id from DTSTART up to the horizon, once,
  // with each override matched to the occurrence whose instant its
  // RECURRENCE-ID names — independently of relateSeries' alignment
  const ref = reference(text, range, sub);
  const occurrences = ref.occurrences;
  const touching = occurrences.filter((o) => touchesRange(spanOf(o).start, spanOf(o).end, range));

  const expected = {
    touching,
    busy: touching.filter((o) => spanOf(o).end > spanOf(o).start && blocksTime(o.item.component)),
    shown: touching.slice(0, 1),
    search: touching.filter((o) => matches(o.item.component)).slice(0, 1),
  };
  const fast = {
    touching: () => seriesOccurrences(seriesOf(text), range),
    busy: () => busyOccurrencesOf(parse(text), range),
    shown: () => {
      const shown = shownEvent(parse(text), timeRange);
      return { occurrences: shown.occurrence ? [shown.occurrence] : [], truncated: shown.expansionTruncated };
    },
    search: () => {
      const shown = shownEvent(parse(text), timeRange, matches);
      return { occurrences: shown.occurrence ? [shown.occurrence] : [], truncated: shown.expansionTruncated };
    },
  };

  for (const name of Object.keys(expected)) {
    compared++;
    const result = fast[name]();
    const want = describe(expected[name]);
    const got = describe(result.occurrences);
    let ok;
    if (result.truncated) {
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

console.log(JSON.stringify({ cases: CASES, compared, deviations, truncated, examples }));
