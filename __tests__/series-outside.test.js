import { describe, test, expect } from '@jest/globals';
import ICAL from 'ical.js';

// seriesOutside decides, without expanding, that no occurrence of a series
// touches a range; range-candidates.js drops the recurring objects it rules
// out before they reach the calendar library (#170). Dropping one that does
// touch the range would lose a meeting without a note, so every verdict
// "outside" is checked here against the expansion itself, over random rules.
const { readSeries } = await import('../src/ical-components.js');
const { relateSeries, seriesOutside, seriesOccurrences } = await import('../src/occurrences.js');
const { createRecurrenceBudget } = await import('tsdav-utils');

/** mulberry32: the same rules on every run */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms, date) => {
  const d = new Date(ms);
  const day = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
  return date ? day : `${day}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}00`;
};

function randomSeries(rnd) {
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const some = (count, make) => [...new Set(Array.from({ length: count }, make))];
  const freq = pick(['YEARLY', 'YEARLY', 'MONTHLY', 'MONTHLY', 'WEEKLY', 'DAILY']);
  const kind = pick(['date', 'utc', 'floating']);
  const start = Date.UTC(2015, 0, 1) + Math.floor(rnd() * 12 * 365) * 864e5 + (kind === 'date' ? 0 : Math.floor(rnd() * 24) * 3600e3);
  const parts = [`FREQ=${freq}`];
  if (rnd() < 0.3) parts.push(`INTERVAL=${1 + Math.floor(rnd() * 3)}`);
  const byMonth = rnd() < 0.4;
  if (byMonth) parts.push(`BYMONTH=${some(1 + Math.floor(rnd() * 3), () => 1 + Math.floor(rnd() * 12)).join(',')}`);
  if (freq !== 'WEEKLY' && rnd() < 0.4) {
    parts.push(`BYMONTHDAY=${some(1 + Math.floor(rnd() * 2), () => (rnd() < 0.8 ? 1 : -1) * (1 + Math.floor(rnd() * 31))).join(',')}`);
  }
  if (rnd() < 0.4) {
    const monthly = freq === 'MONTHLY' || (freq === 'YEARLY' && byMonth);
    const ordinal = () => {
      if (!(freq === 'MONTHLY' || freq === 'YEARLY') || rnd() < 0.4) return '';
      const n = 1 + Math.floor(rnd() * (monthly ? 5 : 53));
      return String(rnd() < 0.7 ? n : -n);
    };
    parts.push(`BYDAY=${some(1 + Math.floor(rnd() * 2), () => ordinal() + pick(WEEKDAYS)).join(',')}`);
    if (rnd() < 0.15) parts.push(`BYSETPOS=${pick([1, 2, -1])}`);
  }
  if (rnd() < 0.15) parts.push(`BYHOUR=${some(1 + Math.floor(rnd() * 2), () => Math.floor(rnd() * 24)).join(',')}`);
  if (rnd() < 0.2) parts.push(`COUNT=${2 + Math.floor(rnd() * 40)}`);
  else if (rnd() < 0.2) parts.push(`UNTIL=${stamp(start + Math.floor(rnd() * 12 * 365) * 864e5, kind === 'date')}${kind === 'utc' ? 'Z' : ''}`);

  const zone = kind === 'utc' ? 'Z' : '';
  const dtstart = kind === 'date' ? `DTSTART;VALUE=DATE:${stamp(start, true)}` : `DTSTART:${stamp(start)}${zone}`;
  const lines = [dtstart, `DURATION:${kind === 'date' ? `P${1 + Math.floor(rnd() * 3)}D` : pick(['PT0S', 'PT1H', 'PT5H'])}`, `RRULE:${parts.join(';')}`];
  if (rnd() < 0.1) {
    const extra = start + Math.floor(rnd() * 12 * 365) * 864e5;
    lines.push(kind === 'date' ? `RDATE;VALUE=DATE:${stamp(extra, true)}` : `RDATE:${stamp(extra)}${zone}`);
  }
  const data = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//EN', 'BEGIN:VEVENT', 'UID:x', 'DTSTAMP:20260101T000000Z',
    ...lines, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
  const rangeStart = Date.UTC(2025, 0, 1) + Math.floor(rnd() * 3 * 365 * 24) * 3600e3;
  const range = { start: rangeStart, end: rangeStart + (1 + Math.floor(rnd() * 20 * 24)) * 3600e3 };
  return { data, range };
}

describe('seriesOutside never rules out a series with an occurrence in the range', () => {
  test('random MONTHLY, YEARLY, WEEKLY and DAILY rules against their expansion', () => {
    const rnd = random(170);
    let outside = 0;
    let checked = 0;
    for (let i = 0; i < 3000; i++) {
      const { data, range } = randomSeries(rnd);
      let series;
      try {
        const { master, overrides } = readSeries(new ICAL.Component(ICAL.parse(data)), 'vevent');
        series = relateSeries(master, overrides);
      } catch {
        continue;
      }
      if (!seriesOutside(series, range)) continue;
      outside += 1;
      const result = seriesOccurrences(series, range, { budget: createRecurrenceBudget(5e6) });
      // an occurrence found where none was proven possible is the failure;
      // an expansion that stopped early proves nothing either way
      expect({ data, range, found: result.occurrences.map((o) => o.startDate.toString()) })
        .toEqual({ data, range, found: [] });
      if (!result.truncated) checked += 1;
    }
    // the verdicts were not vacuous: many series were ruled out, and nearly
    // all of those were checked by a complete expansion
    expect(outside).toBeGreaterThan(1000);
    expect(checked).toBeGreaterThan(outside * 0.9);
  }, 300000);
});
