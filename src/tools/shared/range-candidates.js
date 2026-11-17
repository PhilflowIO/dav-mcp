import ICAL from 'ical.js';
import { isDAVAuthenticationError, isDAVResponseError } from 'tsdav';
import { parseICal, unreadableReason } from '../../ical-parse.js';
import { serverTimeRange, relateSeries, seriesOutside } from '../../occurrences.js';
import { readSeries } from '../../ical-components.js';
import { setFloatingZone } from '../../calendar-zone.js';
import { shareTimezones } from './ical-dates.js';
import { logger } from '../../logger.js';

/**
 * The events of one calendar a range query has to look at (calendar_query,
 * list_events, freebusy_query).
 *
 * A time-range REPORT leaves the expansion of a recurring object to the
 * server (RFC 4791 9.9), and servers get it wrong without saying so: the
 * object is simply not in the answer. SabreDAV as Baïkal 0.12.1 ships it
 * (sabre/dav 4.7.1, sabre/vobject 4.6.1) drops, for every window that does
 * not hold the instance it looked at:
 *
 *  - a series with RRULE and RDATE: vobject's EventIterator walks the RDATEs
 *    instead of the rule, so only DTSTART and the extra dates are found
 *    (sabre-io/vobject#347, #700);
 *  - a series with RDATE and no RRULE: the PDO backend stores the end of the
 *    first instance as the object's last occurrence and pre-filters on it;
 *  - an object whose override is stored before the master: the backend
 *    stores the override's span as the object's (sabre-io/dav#1512).
 *
 * So the range answer is trusted for what it returns, not for the recurring
 * objects it leaves out: those — every object with a VEVENT carrying RRULE,
 * RDATE or RECURRENCE-ID — are listed as well, by property filters without a
 * time range, and the occurrence engine decides what touches the range, as
 * it already does for everything the server returns. This is done for every
 * server, not for detected ones: a server does not say which library
 * evaluates its time-range filter, the same library sits under several
 * products (Nextcloud, Baïkal, ...), and a fix upstream reaches each of them
 * at its own pace.
 *
 * The extra objects must not cost what the server's answer needs: the ones
 * whose bounds rule the range out (seriesOutside) are dropped here, before
 * any expansion, and the rest expand from a pool of their own
 * (rangeBudgetPool, isRangeExtra). Nor may they fail the call: if listing or
 * fetching them fails, the calendar's answer stands with a note that a
 * recurring event the server left out may be missing; an extra object that
 * cannot be read is reported, not listed. A server that refuses property
 * filters is asked for all its events instead: slower, still complete.
 *
 * Cost per calendar: the range query and three etag-only REPORTs sent at
 * once, then one multiget of the recurring objects the range answer did not
 * hold — three round-trips. Measured
 * against SabreDAV 4.7.1: see the pull request that added this (#170).
 * Caching them per login is #171.
 */

// tsdav's default urlFilter keeps only hrefs naming an .ics resource
const ICS = '.ics';

/** The properties that make a VEVENT part of a recurring object */
const RECURRENCE_PROPERTIES = ['RRULE', 'RDATE', 'RECURRENCE-ID'];

/** The objects fetched on top of the server's range answer */
const extras = new WeakSet();

/**
 * Was this object fetched only because the server's range answer may have
 * left it out (not returned by the range query itself)?
 *
 * @param {Object} object
 * @returns {boolean}
 */
export function isRangeExtra(object) {
  return Boolean(object && typeof object === 'object' && extras.has(object));
}

/**
 * An extra recurring object  whose expansion stopped before an
 * occurrence in the range was found: the server did not return it and we
 * could not tell, so it is reported rather than listed at its series start.
 */
export const UNCHECKABLE = 'too many occurrences to check against the range in this call';
export function uncheckable(shown) {
  return !shown || (shown.expansionTruncated && !shown.occurrence);
}

/** calendar-query filter: VEVENTs, with `property` defined if given */
function eventsWith(property) {
  return [{
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': {
        _attributes: { name: 'VEVENT' },
        ...(property ? { 'prop-filter': { _attributes: { name: property } } } : {}),
      },
    },
  }];
}

function keyOf(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

/** The .ics hrefs a calendar-query answered with, as absolute URLs */
async function listHrefs(client, calendar, filters) {
  const responses = await client.calendarQuery({
    url: calendar.url,
    props: { 'd:getetag': {} },
    filters,
    depth: '1',
  });
  const base = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
  return responses
    .map((response) => response.href)
    .filter((href) => typeof href === 'string' && href.includes(ICS))
    .map((href) => keyOf(new URL(href, base).href));
}

/**
 * Did the server refuse the query itself (a 4xx other than a refused login,
 * or 501 Not Implemented) — as a server does that cannot evaluate a property
 * filter? A network failure, a timeout or a server fault is no refusal.
 */
function refusedFilter(error) {
  if (!isDAVResponseError(error) || isDAVAuthenticationError(error)) return false;
  const status = Number(error.status);
  return (status >= 400 && status < 500 && status !== 403) || status === 501;
}

/**
 * The recurring objects' hrefs, by property filters at once. Only a server
 * that refuses the filter is asked for all its events instead; any other
 * failure is thrown, and the calendar is reported as not checked.
 */
async function recurringHrefs(client, calendar) {
  try {
    const lists = await Promise.all(RECURRENCE_PROPERTIES.map((property) =>
      listHrefs(client, calendar, eventsWith(property))));
    return lists.flat();
  } catch (error) {
    if (!refusedFilter(error)) throw error;
    logger.warn({ calendar: calendar.url, error: error?.message },
      'The server refused property filters; listing all events of the calendar');
    return listHrefs(client, calendar, eventsWith(null));
  }
}

/** An extra object's verdict: 'outside', 'check', or the reason it cannot be read */
function judge(object, timeRange, zone) {
  let root;
  try {
    if (typeof object.data !== 'string' || !object.data.trim()) return { unreadable: 'it is empty, not iCalendar' };
    const jcal = parseICal(object.data);
    root = setFloatingZone(shareTimezones(new ICAL.Component(Array.isArray(jcal[0]) ? jcal[0] : jcal)), zone);
  } catch (error) {
    return { unreadable: unreadableReason(error, 'iCalendar') };
  }
  const series = readSeries(root, 'vevent');
  if (!series || series.detached.length > 0) return { check: true };
  const range = { start: new Date(timeRange.start).getTime(), end: new Date(timeRange.end).getTime() };
  try {
    return seriesOutside(relateSeries(series.master, series.overrides), range) ? { outside: true } : { check: true };
  } catch {
    return { check: true };
  }
}

/**
 * @param {Object} client - the CalDAV client (tsdav DAVClient)
 * @param {Object} calendar - a calendar from fetchCalendars
 * @param {{start: string, end: string}|undefined} timeRange - the range asked
 *   for, ISO 8601; without one the whole calendar is fetched
 * @param {Object|null} [zone] - the calendar's zone for floating times
 *   (src/calendar-zone.js)
 * @returns {Promise<{objects: Object[], unchecked: Array<{object: {url: string}, reason: string}>}>}
 *   objects: the range answer, then the extra objects that may touch the
 *   range (isRangeExtra); unchecked: extra objects that cannot be read, or
 *   the calendar itself when its recurring events could not be fetched
 */
export async function fetchRangeCandidates(client, calendar, timeRange, zone = null) {
  if (!timeRange) return { objects: await client.fetchCalendarObjects({ calendar }), unchecked: [] };
  // the range answer (wider than asked: the server reads floating times its
  // own way) and the recurring listing go out at once; a failed listing
  // must not fail the range answer, so it settles into a value
  const [inRange, listed] = await Promise.all([
    client.fetchCalendarObjects({ calendar, timeRange: serverTimeRange(timeRange) }),
    recurringHrefs(client, calendar).then((hrefs) => ({ hrefs }), (error) => ({ error })),
  ]);

  const seen = new Set(inRange.map((object) => keyOf(object.url)));
  let found;
  try {
    if (listed.error) throw listed.error;
    const missing = [...new Set(listed.hrefs)].filter((url) => !seen.has(url));
    found = missing.length ? await client.fetchCalendarObjects({ calendar, objectUrls: missing }) : [];
  } catch (error) {
    logger.warn({ calendar: calendar.url, error: error?.message }, 'Recurring events of the calendar could not be fetched');
    return {
      objects: inRange,
      unchecked: [{
        object: { url: calendar.url },
        reason: `its recurring events could not be fetched (${error?.message ?? error}); a series the server left out of the range may be missing`,
      }],
    };
  }

  const objects = [...inRange];
  const unchecked = [];
  for (const object of found) {
    if (seen.has(keyOf(object.url))) continue;
    seen.add(keyOf(object.url));
    const verdict = judge(object, timeRange, zone);
    if (verdict.unreadable) unchecked.push({ object, reason: verdict.unreadable });
    else if (verdict.check) {
      extras.add(object);
      objects.push(object);
    }
  }
  return { objects, unchecked };
}
