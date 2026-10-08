import ICAL from 'ical.js';
import { resolveZone, expandOccurrences, createRecurrenceBudget } from 'tsdav-utils';

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
 *   nameTime: (time: ICAL.Time) => {text: string, wholeDay: boolean},
 *   instantOfWall: (wall: string) => number|null,
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
    // `exact`: the text is the value in the series' own form, so it names
    // what the value names; otherwise it is shown as written and names nothing
    if (kind === 'date') return { text: dateText(time), wholeDay: form !== 'date', exact: true };
    if (form === 'date') return { text: dateText(time), wholeDay: false, exact: false };
    // already in the series' own form: as written
    if (kind === form && (kind !== 'zone' || ownTzid === tzid)) {
      return { text: kind === 'utc' ? `${wallText(time)}Z` : wallText(time), wholeDay: false, exact: true };
    }
    try {
      const instant = instantOf(time, ownTzid);
      if (instant && form === 'utc') return { text: instant, wholeDay: false, exact: true };
      if (instant && form === 'zone' && zone(tzid)) {
        return { text: zone(tzid).toWallTime(instant), wholeDay: false, exact: true };
      }
    } catch {
      // a value the zone rules cannot place: shown as written, below
    }
    // names no instant here (a floating value next to a zoned DTSTART, a
    // value with Z in a floating series), or the series' zone is unknown
    return { text: kind === 'utc' ? `${wallText(time)}Z` : wallText(time), wholeDay: false, exact: false };
  };

  /**
   * The name of an occurrence as ical.js' expansion yields it. Its zone is
   * read from the value itself — an RDATE stored in UTC next to a Berlin
   * series comes out in UTC — and converted by instant, never relabelled.
   */
  const nameTime = (time) => {
    if (time.isDate || time.zone === ICAL.Timezone.utcTimezone || time.timezone === 'Z') return name(time, null);
    const own = time.zone?.tzid && time.zone.tzid !== 'floating' ? time.zone.tzid : time.timezone;
    return name(time, own && own !== 'floating' ? own : null);
  };

  /** the instant a wall-clock time without a zone names in this series, ms; null if none */
  const instantOfWall = (wall) => {
    if (form !== 'zone' || !zone(tzid)) return null;
    try {
      return zone(tzid).toInstant(wall).getTime();
    } catch {
      return null;
    }
  };

  const describe = {
    date: 'the date',
    utc: 'UTC, with Z',
    zone: `wall-clock time in ${tzid}`,
    floating: 'local time, without a zone',
  }[form];

  return { form, tzid, describe, name, nameTime, instantOfWall, master };
}

/**
 * What a series excludes and overrides, each named by its original start.
 *
 * Only an exclusion that names an occurrence is listed as cancelled — one
 * restore_occurrences can bring back (see occurrenceValues). A stored
 * EXDATE that names none (a floating value next to a zoned DTSTART, a time
 * the rule never yields) excludes nothing; it is listed apart as `inert`,
 * so the listing never calls an occurrence cancelled that takes place.
 *
 * @param {ICAL.Component} master
 * @param {ICAL.Component[]} overrides - its RECURRENCE-ID siblings (readSeries)
 * @param {'vevent'|'vtodo'} [type] - the component type; without it no
 *   exclusion is checked, and all are listed as cancelled
 * @returns {{
 *   naming: ReturnType<typeof seriesNaming>,
 *   exclusions: Array<{text: string, wholeDay: boolean}>,
 *   inert: Array<{text: string, wholeDay: boolean}>,
 *   overrides: Array<{text: string, component: ICAL.Component}>,
 * } | null} null for something that does not recur or has no DTSTART
 */
export function seriesNames(master, overrides = [], type = null) {
  if (!isRecurring(master)) return null;
  const naming = seriesNaming(master);
  if (!naming) return null;

  const seen = new Set();
  const all = [];
  for (const property of master.getAllProperties('exdate')) {
    const tzid = property.getParameter('tzid') ?? null;
    for (const value of property.getValues()) {
      if (!(value instanceof ICAL.Time)) continue;
      const named = naming.name(value, tzid);
      // the same text from a value that names the occurrence and from one
      // that names nothing (a floating twin next to a zoned DTSTART) are two
      const key = `${named.exact}:${named.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(named);
    }
  }
  all.sort((a, b) => a.text.localeCompare(b.text));

  const live = type ? occurrenceValues(master, all, type) : null;
  const exclusions = [];
  const inert = [];
  for (const named of all) {
    if (!live) exclusions.push(named);
    else if (!named.exact) inert.push(named);
    else if (named.wholeDay) ([...live].some((value) => value.startsWith(named.text)) ? exclusions : inert).push(named);
    else (live.has(named.text) || live.has(instantKey(named.text, naming)) ? exclusions : inert).push(named);
  }
  // a name that is cancelled is not also listed as cancelling nothing
  const cancelled = new Set(exclusions.map(({ text }) => text));
  inert.splice(0, inert.length, ...inert.filter(({ text }) => !cancelled.has(text)));

  const changed = overrides
    .map((component) => {
      const property = component.getFirstProperty('recurrence-id');
      const value = property?.getFirstValue();
      if (!(value instanceof ICAL.Time)) return null;
      return { text: naming.name(value, property.getParameter('tzid') ?? null).text, component };
    })
    .filter(Boolean)
    .sort((a, b) => a.text.localeCompare(b.text));

  return { naming, exclusions, inert, overrides: changed };
}

/** the instant key a name in a zoned or UTC series has in occurrenceValues' set */
function instantKey(text, naming) {
  const at = text.endsWith('Z') ? Date.parse(text) : naming.instantOfWall(text);
  return Number.isFinite(at) ? `@${at}` : null;
}

/** does the component recur (RRULE or RDATE)? */
export const isRecurring = (component) => component.hasProperty('rrule') || component.hasProperty('rdate');

function rootOf(component) {
  let root = component;
  while (root.parent) root = root.parent;
  return root;
}

/**
 * The original starts of the series' occurrences around its exclusions, in
 * the series' form, counting the excluded ones: one expansion, by tsdav-utils,
 * of the series with its EXDATEs taken out. An exclusion names an occurrence
 * when its name is one of these (a whole-day one, when one of them falls on
 * its day) — the library's rule: matched by instant, by date in an all-day
 * series, by wall clock in a floating one.
 *
 * @returns {Set<string>|null} null when the expansion could not be completed
 *   (then the exclusions are listed unchecked)
 */
function occurrenceValues(master, exclusions, type) {
  if (!exclusions.length) return new Set();
  const days = exclusions.map(({ text }) => Date.parse(`${text.slice(0, 10)}T00:00:00Z`)).filter(Number.isFinite);
  if (!days.length) return null;
  const at = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  try {
    const root = new ICAL.Component(rootOf(master).toJSON());
    for (const component of root.getAllSubcomponents(type)) {
      if (!component.hasProperty('recurrence-id')) component.removeAllProperties('exdate');
    }
    const { occurrences, complete } = expandOccurrences(root.toString(), {
      budget: createRecurrenceBudget(), type, limit: 5000,
      from: at(Math.min(...days) - 2 * 86400000), until: at(Math.max(...days) + 3 * 86400000),
    });
    // by name and by instant: an exclusion written as the wall clock past a
    // DST gap (03:15 for a skipped 02:15) names that occurrence by instant
    return complete
      ? new Set(occurrences.flatMap((o) => [o.recurrenceId.value, o.recurrenceId.instant && `@${Date.parse(o.recurrenceId.instant)}`]).filter(Boolean))
      : null;
  } catch {
    return null;
  }
}

/**
 * The dates a series lists — exclusions, extra dates, overridden
 * occurrences — each by name in the series' own form, for comparing a series
 * before and after a write: a value restated in another zone or on another
 * line is the same name, a value that moved is another one.
 *
 * @param {ICAL.Component} master
 * @param {ICAL.Component[]} overrides
 * @returns {{exdates: string[], rdates: string[], overrides: string[]}|null}
 */
export function listedDates(master, overrides = []) {
  const naming = seriesNaming(master);
  if (!naming) return null;
  const names = (property) => {
    const tzid = property.getParameter('tzid') ?? null;
    return property.getValues()
      .map((value) => (value instanceof ICAL.Time ? value : value?.start))
      .filter((value) => value instanceof ICAL.Time)
      .map((value) => labelled(naming.name(value, tzid)));
  };
  const unique = (list) => [...new Set(list)];
  return {
    exdates: unique(master.getAllProperties('exdate').flatMap(names)),
    rdates: unique(master.getAllProperties('rdate').flatMap(names)),
    overrides: unique(overrides.map((o) => o.getFirstProperty('recurrence-id')).filter(Boolean).flatMap(names)),
  };
}

/** the exclusions of a calendar object's series, by name; empty if none */
function exclusionTexts(data, type) {
  try {
    const calendar = new ICAL.Component(ICAL.parse(data));
    const all = calendar.getAllSubcomponents(type);
    const master = all.find((c) => !c.hasProperty('recurrence-id'));
    if (!master) return { exclusions: [], overrides: [] };
    const names = seriesNames(master, all.filter((c) => c !== master && c.hasProperty('recurrence-id')), type);
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
  // a write that changed no occurrence (a stored value restated, say) is
  // still a write, and is not reported as none
  const summary = parts.length ? parts.join('; ')
    : before === after ? 'no change: already as asked' : 'the exclusions were rewritten; no occurrence changed';
  return { summary, ...change };
}
