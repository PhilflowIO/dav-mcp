import { isDAVAuthenticationError, isDAVResponseError } from 'tsdav';
import { parseICal } from '../../ical-parse.js';
import { serverTimeRange } from '../../occurrences.js';
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
 * RDATE or RECURRENCE-ID — are fetched as well, without a time range, and
 * the occurrence engine decides what touches the range, as it already does
 * for everything the server returns. This is done for every server, not for
 * detected ones: a server does not say which library evaluates its
 * time-range filter, the same library sits under several products
 * (Nextcloud, Baïkal, ...), and a fix upstream reaches each of them at its
 * own pace.
 *
 * A property filter without a time range is evaluated by every SabreDAV
 * backend on the stored text, so it is not subject to the errors above. A
 * server that refuses it (any DAV error other than a refused login) gets the
 * calendar's events asked for without a filter instead: slower, still
 * complete.
 *
 * Cost per calendar: three etag-only REPORTs, and a multiget of the
 * recurring objects the range answer did not hold (up to one per REPORT;
 * each object is fetched once). Measured against SabreDAV 4.7.1 with a
 * three-year calendar of 1 625 objects, 124 of them recurring, for a
 * one-week query: 2 requests, 94 KB and 90 ms before; 7 requests, 236 KB
 * and 475 ms now. The whole calendar without a filter is 1.7 MB.
 */

// tsdav's default urlFilter keeps only hrefs naming an .ics resource
const ICS = '.ics';

/** The properties that make a VEVENT part of a recurring object */
const RECURRENCE_PROPERTIES = ['RRULE', 'RDATE', 'RECURRENCE-ID'];

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

/**
 * An object only the recurring query found is listed on our reading alone;
 * one we cannot read we cannot place, so the server's verdict stands: it
 * left the object out of the range.
 */
function readable(object) {
  if (typeof object.data !== 'string' || !object.data.trim()) return false;
  try {
    parseICal(object.data);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {Object} client - the CalDAV client (tsdav DAVClient)
 * @param {Object} calendar - a calendar from fetchCalendars
 * @param {{start: string, end: string}|undefined} timeRange - the range asked
 *   for, ISO 8601; without one the whole calendar is fetched
 * @returns {Promise<Array<{url: string, etag?: string, data?: string}>>}
 */
export async function fetchRangeCandidates(client, calendar, timeRange) {
  if (!timeRange) return client.fetchCalendarObjects({ calendar });
  // wider than asked: the server reads floating times its own way
  const inRange = await client.fetchCalendarObjects({ calendar, timeRange: serverTimeRange(timeRange) });

  const seen = new Set(inRange.map((object) => keyOf(object.url)));
  const missed = [];
  const fetchUnseen = async (filters) => {
    const found = await client.fetchCalendarObjects({
      calendar,
      filters,
      urlFilter: (url) => Boolean(url?.includes(ICS)) && !seen.has(keyOf(url)),
    });
    for (const object of found) {
      const key = keyOf(object.url);
      if (seen.has(key)) continue;
      seen.add(key);
      if (readable(object)) missed.push(object);
    }
  };

  try {
    for (const property of RECURRENCE_PROPERTIES) await fetchUnseen(eventsWith(property));
  } catch (error) {
    if (!isDAVResponseError(error) || isDAVAuthenticationError(error)) throw error;
    logger.warn({ calendar: calendar.url, error: error.message },
      'Recurring events could not be listed by property; fetching all events of the calendar');
    await fetchUnseen(eventsWith(null));
  }
  return [...inRange, ...missed];
}
