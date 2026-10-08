import ICAL from 'ical.js';
import { resolveZone } from 'tsdav-utils';

/**
 * How dav-mcp names an occurrence of a recurring event or todo: by its
 * ORIGINAL start (the RECURRENCE-ID it has or would have), written the way the
 * series writes DTSTART — the wall-clock time in DTSTART's zone, UTC with Z,
 * a floating time, or a date for an all-day series.
 *
 * That is the form tsdav-utils' cancelOccurrences/restoreOccurrences take as
 * ids (Occurrence.recurrenceId.value), so a model can pass a name from a
 * listing back verbatim. The listing shows the same names for the
 * exclusions (EXDATE) and for the overridden occurrences, whatever zone each
 * of those is stored in: an EXDATE stored in UTC next to a Europe/Berlin
 * series is shown on the Berlin wall clock, so the model never has to
 * convert.
 *
 * A value that names no instant in this series (a floating EXDATE next to a
 * zoned DTSTART, a zone without known rules) cannot be converted and is shown
 * as written — tsdav-utils treats it as naming no occurrence either.
 */

const pad = (n, width = 2) => String(n).padStart(width, '0');
const dateText = (t) => `${pad(t.year, 4)}-${pad(t.month)}-${pad(t.day)}`;
const wallText = (t) => `${dateText(t)}T${pad(t.hour)}:${pad(t.minute)}:${pad(t.second)}`;

/** 'date' | 'utc' | 'zone' | 'floating' for a value with the given TZID */
function kindOf(time, tzid) {
  if (time.isDate) return 'date';
  if (tzid) return 'zone';
  return time.zone === ICAL.Timezone.utcTimezone || time.timezone === 'Z' ? 'utc' : 'floating';
}

/**
 * The naming of one series.
 *
 * @param {ICAL.Component} master - the series master (readSeries)
 * @returns {{
 *   form: 'date'|'utc'|'zone'|'floating',
 *   tzid: string|null,
 *   describe: string,
 *   name: (time: ICAL.Time, tzid?: string|null) => {text: string, wholeDay: boolean},
 *   master: ICAL.Component,
 * } | null} null for a component without DTSTART
 */
export function seriesNaming(master) {
  const dtstart = master.getFirstProperty('dtstart');
  const start = dtstart?.getFirstValue();
  if (!start) return null;
  const tzid = dtstart.getParameter('tzid') ?? null;
  const form = kindOf(start, tzid);

  // one root for every zone lookup: the VTIMEZONEs travel with the VCALENDAR
  let root = master;
  while (root.parent) root = root.parent;
  const zones = new Map();
  const zone = (id) => {
    if (!zones.has(id)) {
      let converter = null;
      try {
        converter = resolveZone(id, root);
      } catch {
        converter = null;
      }
      zones.set(id, converter);
    }
    return zones.get(id);
  };

  /** the instant a stored value names, as an ISO string with Z, or null */
  const instantOf = (time, ownTzid) => {
    const kind = kindOf(time, ownTzid);
    if (kind === 'utc') return `${wallText(time)}Z`;
    if (kind !== 'zone') return null;
    const converter = zone(ownTzid);
    return converter ? converter.toInstant(wallText(time)).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;
  };

  const name = (time, ownTzid = null) => {
    const kind = kindOf(time, ownTzid);
    if (kind === 'date') return { text: dateText(time), wholeDay: form !== 'date' };
    if (form === 'date') return { text: dateText(time), wholeDay: false };
    // already in the series' own form: as written
    if (kind === form && (kind !== 'zone' || ownTzid === tzid)) {
      return { text: kind === 'utc' ? `${wallText(time)}Z` : wallText(time), wholeDay: false };
    }
    try {
      const instant = instantOf(time, ownTzid);
      if (instant && form === 'utc') return { text: instant, wholeDay: false };
      if (instant && form === 'zone' && zone(tzid)) return { text: zone(tzid).toWallTime(instant), wholeDay: false };
    } catch {
      // a value the zone rules cannot place: shown as written, below
    }
    // names no instant here, or the series' zone is unknown: as written
    return { text: kind === 'utc' ? `${wallText(time)}Z` : wallText(time), wholeDay: false };
  };

  const describe = {
    date: 'the date',
    utc: 'UTC, with Z',
    zone: `wall-clock time in ${tzid}`,
    floating: 'local time, without a zone',
  }[form];

  return { form, tzid, describe, name, master };
}

/**
 * What a series excludes and overrides, each named by its original start.
 *
 * @param {ICAL.Component} master
 * @param {ICAL.Component[]} overrides - its RECURRENCE-ID siblings (readSeries)
 * @returns {{
 *   naming: ReturnType<typeof seriesNaming>,
 *   exclusions: Array<{text: string, wholeDay: boolean}>,
 *   overrides: Array<{text: string, component: ICAL.Component}>,
 * } | null} null for something that does not recur or has no DTSTART
 */
export function seriesNames(master, overrides = []) {
  if (!master.hasProperty('rrule') && !master.hasProperty('rdate')) return null;
  const naming = seriesNaming(master);
  if (!naming) return null;

  const seen = new Set();
  const exclusions = [];
  for (const property of master.getAllProperties('exdate')) {
    const tzid = property.getParameter('tzid') ?? null;
    for (const value of property.getValues()) {
      if (!(value instanceof ICAL.Time)) continue;
      const named = naming.name(value, tzid);
      if (seen.has(named.text)) continue;
      seen.add(named.text);
      exclusions.push(named);
    }
  }
  exclusions.sort((a, b) => a.text.localeCompare(b.text));

  const changed = overrides
    .map((component) => {
      const property = component.getFirstProperty('recurrence-id');
      const value = property?.getFirstValue();
      if (!(value instanceof ICAL.Time)) return null;
      return { text: naming.name(value, property.getParameter('tzid') ?? null).text, component };
    })
    .filter(Boolean)
    .sort((a, b) => a.text.localeCompare(b.text));

  return { naming, exclusions, overrides: changed };
}

/** the exclusions of a calendar object's series, by name; empty if none */
function exclusionTexts(data, type) {
  try {
    const calendar = new ICAL.Component(ICAL.parse(data));
    const all = calendar.getAllSubcomponents(type);
    const master = all.find((c) => !c.hasProperty('recurrence-id'));
    if (!master) return { exclusions: [], overrides: [] };
    const names = seriesNames(master, all.filter((c) => c !== master && c.hasProperty('recurrence-id')));
    return {
      exclusions: (names?.exclusions ?? []).map(labelled),
      overrides: (names?.overrides ?? []).map((o) => o.text),
    };
  } catch {
    return { exclusions: [], overrides: [] };
  }
}

/** a name as listed: a date excluding a whole day of a timed series says so */
export const labelled = ({ text, wholeDay }) => (wholeDay ? `${text} (whole day)` : text);

/**
 * What cancelling and restoring did to a series, for the reply: the
 * exclusions added and removed and the overrides that went, each by name.
 *
 * Compared by name in the series' own form, not by the stored text: an
 * exclusion restated in another zone or on another line is the same
 * exclusion, and one added on a new line is new.
 *
 * @param {string} before - the object as fetched
 * @param {string} after - the object after the edit
 * @param {'vevent'|'vtodo'} type
 */
export function describeOccurrenceEdit(before, after, type) {
  const old = exclusionTexts(before, type);
  const now = exclusionTexts(after, type);
  const minus = (a, b) => a.filter((x) => !b.includes(x));
  const change = {
    exclusions_added: minus(now.exclusions, old.exclusions),
    exclusions_removed: minus(old.exclusions, now.exclusions),
    overrides_removed: minus(old.overrides, now.overrides),
  };
  const parts = [];
  if (change.exclusions_added.length) parts.push(`cancelled ${change.exclusions_added.join(', ')}`);
  if (change.exclusions_removed.length) parts.push(`restored ${change.exclusions_removed.join(', ')}`);
  if (change.overrides_removed.length) {
    parts.push(`removed the changed version of ${change.overrides_removed.join(', ')}`);
  }
  return { summary: parts.length ? parts.join('; ') : 'no change: already as asked', ...change };
}
