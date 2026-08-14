import ICAL from 'ical.js';

/**
 * Rewrite DTSTART/DTEND on an existing calendar object.
 *
 * This cannot go through the flat fields -> updateFields interface the rest of
 * update_event uses. updateFields calls updatePropertyWithValue(name, value),
 * which keys on the property NAME: a key of "DTSTART;VALUE=DATE" does not
 * replace the existing DTSTART, it appends a second one. RFC 5545 3.6.1 says
 * DTSTART MUST NOT occur twice, and on re-parse the first value wins — so the
 * conversion would silently do nothing while corrupting the object.
 *
 * Removing the property and building a fresh one is what makes the two
 * directions symmetric, and it is why no stale parameter can survive:
 *
 *  - all-day -> timed keeps no VALUE=DATE, which would otherwise re-parse as a
 *    date and discard the requested time
 *  - timed with a TZID -> UTC keeps no TZID, which RFC 5545 3.2.19 forbids on
 *    a UTC value
 *
 * @param {string} iCalString - the current calendar object
 * @param {Object} dates
 * @param {string} dates.startDate - YYYY-MM-DD when allDay, else ISO 8601
 * @param {string} dates.endDate - same form as startDate; exclusive when allDay
 * @param {boolean} dates.allDay - emit DATE values rather than DATE-TIME
 * @returns {string} the rewritten calendar object
 */
export function setEventDates(iCalString, { startDate, endDate, allDay }) {
  let component;
  try {
    component = new ICAL.Component(ICAL.parse(iCalString));
  } catch (error) {
    throw new Error(`Failed to parse iCal data: ${error.message}`);
  }

  const vevent = component.name === 'vcalendar'
    ? component.getFirstSubcomponent('vevent')
    : component;

  if (!vevent || vevent.name !== 'vevent') {
    throw new Error('No VEVENT found in the calendar object');
  }

  setDateProperty(vevent, 'dtstart', toICalTime(startDate, allDay));
  setDateProperty(vevent, 'dtend', toICalTime(endDate, allDay));

  return component.toString();
}

/**
 * Replace every occurrence of a date property with exactly one fresh property,
 * carrying only the parameters the new value implies.
 */
function setDateProperty(vevent, name, time) {
  vevent.removeAllProperties(name);
  const property = new ICAL.Property(name, vevent);
  // setValue on an ICAL.Time resets the property type, which is what writes
  // (or omits) the VALUE=DATE parameter
  property.setValue(time);
  vevent.addProperty(property);
}

function toICalTime(value, allDay) {
  if (allDay) {
    // fromDateString gives isDate = true, which is the whole point: no time,
    // no zone, and no host-timezone reinterpretation of the day
    return ICAL.Time.fromDateString(value);
  }
  // true = UTC. The instant is what the caller asked for; a naive datetime is
  // read in the host timezone, matching what create_event already does.
  return ICAL.Time.fromJSDate(new Date(value), true);
}
