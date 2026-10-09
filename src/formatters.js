/**
 * LLM-Friendly Output Formatters for tsdav-mcp
 *
 * This module provides formatters that convert raw CalDAV/CardDAV data
 * into human-readable Markdown format optimized for LLM consumption.
 *
 * Uses RFC-compliant parsing:
 * - ical.js for RFC 5545 (iCalendar) compliance
 * - ical.js for RFC 6350 (vCard) compliance (supports v3.0 and v4.0)
 */

import ICAL from 'ical.js';
import { parseICal, unreadableReason } from './ical-parse.js';
import { readVCard, nameComponents, organizationText } from './vcard.js';
import { readSeries, shownEvent, todoStatus } from './ical-components.js';
import { shareTimezones } from './tools/shared/ical-dates.js';
import { seriesNames, labelled } from './occurrence-names.js';
import { budgetPool, zonedInstant } from './occurrences.js';

/**
 * Parse iCal data string to extract event properties (RFC 5545 compliant)
 *
 * When a time range is given, a recurring series resolves to the occurrence
 * inside that range, including any RECURRENCE-ID override of it.
 */
function parseICalEvent(icalData, timeRange = null, matches = null, resolved = null, budget = undefined) {
  try {
    // the occurrence calendar_query's text filters read too (see shownEvent);
    // resolved there already for a listed event
    const shown = resolved ?? shownEvent(shareTimezones(new ICAL.Component(parseICal(icalData))), timeRange, matches, budget);
    if (!shown) {
      return {};
    }
    const { vevent, event, occurrence, item, outsideRange, expansionTruncated } = shown;

    return {
      summary: item.summary || '',
      description: item.description || '',
      location: item.location || '',
      status: String(item.component.getFirstPropertyValue('status') || '').toUpperCase(),
      uid: event.uid || '',
      dtstart: occurrence ? occurrence.startDate : event.startDate,
      dtend: occurrence ? occurrence.endDate : event.endDate,
      outsideRange,
      expansionTruncated,
      expansionReason: shown.expansionReason ?? null,
      // the instants the expansion computed (exact at a DST change)
      dtstartAt: occurrence?.startAt ?? null,
      dtendAt: occurrence?.endAt ?? null,
      occurrences: shown.occurrences ?? null,
      occurrenceShown: Boolean(occurrence),
      isRecurring: event.isRecurring(),
      rrule: event.isRecurring() ? vevent.getFirstPropertyValue('rrule') : null,
      series: seriesListing(vevent, 'vevent', occurrence),
      organizer: item.component.getFirstPropertyValue('organizer'),
      attendees: item.component.getAllProperties('attendee').map(att => ({
        email: att.getFirstValue(),
        role: att.getParameter('role'),
        partstat: att.getParameter('partstat'),
        cn: att.getParameter('cn'),
      })),
      alarms: item.component.getAllSubcomponents('valarm').map(valarm => ({
        action: valarm.getFirstPropertyValue('action'),
        trigger: valarm.getFirstPropertyValue('trigger'),
        description: valarm.getFirstPropertyValue('description'),
      })),
    };
  } catch (error) {
    // the parser's message quotes the offending line: personal data, so only its type
    console.error(`Skipped a event that could not be parsed (${error.name})`);
    return { unreadable: unreadableReason(error, 'iCalendar') };
  }
}

/**
 * Parse vCard data string to extract contact properties (RFC 6350 compliant)
 */
function parseVCard(vcardData) {
  try {
    const vcard = readVCard(vcardData);

    const contact = {
      fullName: vcard.getFirstPropertyValue('fn') || '',
      uid: vcard.getFirstPropertyValue('uid') || '',
    };

    // Parse structured name (N property)
    const n = vcard.getFirstProperty('n');
    if (n) {
      const name = nameComponents(n);
      contact.familyName = name.family;
      contact.givenName = name.given;
      contact.additionalNames = name.additional;
      contact.honorificPrefixes = name.prefix;
      contact.honorificSuffixes = name.suffix;
    }

    // Parse all emails
    const emails = vcard.getAllProperties('email');
    if (emails && emails.length > 0) {
      contact.emails = emails.map(e => ({
        value: e.getFirstValue(),
        type: [e.getParameter('type') ?? []].flat(),
      }));
    }

    // Parse all phone numbers
    const tels = vcard.getAllProperties('tel');
    if (tels && tels.length > 0) {
      contact.phones = tels.map(t => ({
        value: t.getFirstValue(),
        type: [t.getParameter('type') ?? []].flat(),
      }));
    }

    // Parse all addresses
    const adrs = vcard.getAllProperties('adr');
    if (adrs && adrs.length > 0) {
      contact.addresses = adrs.map(a => {
        const adrValue = a.getFirstValue();
        return {
          poBox: adrValue[0] || '',
          extendedAddress: adrValue[1] || '',
          streetAddress: adrValue[2] || '',
          locality: adrValue[3] || '',
          region: adrValue[4] || '',
          postalCode: adrValue[5] || '',
          country: adrValue[6] || '',
          type: [a.getParameter('type') ?? []].flat(),
        };
      });
    }

    // Parse organization
    const org = vcard.getFirstProperty('org');
    if (org) {
      contact.organization = organizationText(org);
    }

    // Parse note
    const note = vcard.getFirstPropertyValue('note');
    if (note) {
      contact.note = note;
    }

    return contact;
  } catch (error) {
    // the parser's message quotes the offending line: personal data, so only its type
    console.error(`Skipped a contact that could not be parsed (${error.name})`);
    return { unreadable: unreadableReason(error, 'vCard') };
  }
}

// Properties whose value may be an inline binary blob. A single embedded
// contact photo runs to ~170k characters, of which the human-readable part of
// our output uses none — it all lands in the Raw Data block and blows up the
// model's context. Small values (a URI, a short reference) are kept.
const BINARY_CAPABLE_PROPERTY = /^(PHOTO|LOGO|SOUND|ATTACH|KEY)(;|:)/i;
const MAX_INLINE_VALUE_LENGTH = 512;

/**
 * Replace inline binary property values with a short placeholder.
 *
 * Operates on raw content lines so that everything else — including the
 * original folding — survives untouched: the Raw Data block stays something a
 * caller can reason about, minus the blobs.
 */
export function stripBinaryValues(data) {
  if (typeof data !== 'string') return data;

  const separator = data.includes('\r\n') ? '\r\n' : '\n';
  const lines = data.split(/\r\n|\n|\r/);
  const output = [];
  let run = null;

  const flush = () => {
    if (!run) return;
    const value = run.lines.join('').slice(run.name.length + 1);
    if (value.length > MAX_INLINE_VALUE_LENGTH) {
      output.push(`${run.header}<stripped ${value.length} characters>`);
    } else {
      output.push(...run.lines);
    }
    run = null;
  };

  for (const line of lines) {
    if (run && /^[ \t]/.test(line)) {
      run.lines.push(line);
      continue;
    }
    flush();

    if (BINARY_CAPABLE_PROPERTY.test(line)) {
      const colon = line.indexOf(':');
      run = {
        name: line.slice(0, colon),
        header: line.slice(0, colon + 1),
        lines: [line],
      };
      continue;
    }
    output.push(line);
  }
  flush();

  return output.join(separator);
}

/**
 * The count line, plus what was left out.
 *
 * Silent truncation reads as "this is everything", which is exactly the wrong
 * thing to hand a model that is deciding whether it has enough to answer.
 * `which` names the part shown, after the order the query sorted by: events
 * and todos by date, contacts by name.
 */
function foundLine(noun, shown, total, which = `the ${shown} earliest`) {
  if (!total || total <= shown) return `Found ${noun}: **${shown}**\n\n`;
  return `Found ${noun}: **${shown}** of ${total} (showing ${which} — raise \`limit\` or narrow the query to see the rest)\n\n`;
}

/**
 * Shape a list of DAV objects for the Raw Data block
 */
function toRawData(items) {
  return items.map(item => ({
    url: item.url,
    etag: item.etag,
    data: stripBinaryValues(item.data),
  }));
}

/**
 * Resolve the display name of a collection.
 *
 * Call sites pass a name, a tsdav collection object, or an explicit null, and a
 * default parameter only fires for undefined — so normalise here instead of at
 * every call site.
 */
function collectionName(collection, fallback) {
  if (!collection) return fallback;
  if (typeof collection === 'string') return collection;
  return extractPropertyValue(collection.displayName) || collection.url || fallback;
}

/**
 * Format ICAL.Time to human-readable format with proper timezone support
 */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * Resolve the IANA zone to render an ICAL.Time in.
 *
 * Returns undefined for "render in whatever zone the host is in", which is the
 * correct answer for a floating time and the only safe answer for a TZID Intl
 * does not know (Exchange emits "W. Europe Standard Time"). Handing such a TZID
 * to toLocaleDateString throws a RangeError.
 */
function isFloating(icalTime) {
  const tzid = icalTime.zone?.tzid || icalTime.timezone;
  return !tzid || tzid === 'floating';
}

function displayTimeZone(icalTime) {
  // ical.js populates .timezone only when the TZID could NOT be resolved, so
  // .zone.tzid is the canonical accessor and .timezone the last-ditch one.
  const tzid = icalTime.zone?.tzid || icalTime.timezone;

  if (!tzid || tzid === 'floating') return undefined;
  if (tzid === 'UTC' || tzid === 'Z') return 'UTC';

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid });
    return tzid;
  } catch {
    return undefined;
  }
}

/**
 * Render a time from its own UTC offset rather than from a named zone.
 *
 * Used when the TZID is not a name Intl knows — Exchange emits things like
 * "W. Europe Standard Time" — but the object carries a VTIMEZONE that ical.js
 * did resolve. Deferring to the host zone instead would show a wall time the
 * organiser never chose, and at a large host offset it moves the date.
 */
function formatWithFixedOffset(icalTime) {
  const offsetSeconds = zonedInstant(icalTime)?.offset ?? icalTime.utcOffset();
  const sign = offsetSeconds < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(offsetSeconds) / 3600);
  const minutes = Math.floor((Math.abs(offsetSeconds) % 3600) / 60);
  const offset = offsetSeconds === 0
    ? 'UTC'
    : `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;

  const hour24 = icalTime.hour;
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  const meridiem = hour24 < 12 ? 'AM' : 'PM';
  const time = `${String(hour12).padStart(2, '0')}:${String(icalTime.minute).padStart(2, '0')} ${meridiem}`;

  return `${MONTHS[icalTime.month - 1]} ${icalTime.day}, ${icalTime.year}, ${time} ${offset}`;
}

/**
 * Format ICAL.Time to human-readable format with proper timezone support
 */
function formatDateTime(icalTime, at = null) {
  if (!icalTime) return '';

  try {
    // A date-only value has no time and no zone. Reading the fields directly
    // is the only correct route: toJSDate() would anchor it to the host's
    // offset, which shifts the date itself east of Greenwich.
    if (icalTime.isDate) {
      return `${MONTHS[icalTime.month - 1]} ${icalTime.day}, ${icalTime.year}`;
    }

    const timeZone = displayTimeZone(icalTime);

    // A zone Intl cannot name, but whose offset ical.js resolved from the
    // object's own VTIMEZONE: render the organiser's wall time, not the host's.
    if (!timeZone && !isFloating(icalTime)) {
      return formatWithFixedOffset(icalTime);
    }

    // the instant: the one the expansion computed, else the zone's own
    // conversion (tsdav-utils; ical.js' toJSDate is up to an hour off near a
    // DST change), else ical.js for UTC and floating times
    const jsDate = new Date(at ?? zonedInstant(icalTime)?.at ?? icalTime.toJSDate().getTime());

    const dateStr = jsDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      timeZone,
    });

    const timeStr = jsDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short',
      timeZone,
    });

    return `${dateStr}, ${timeStr}`;
  } catch (error) {
    console.error('Error formatting datetime:', error);
    return '';
  }
}

// Lists in a listing stay short; the rest is in the raw data
const MAX_LISTED_NAMES = 25;

const listNames = (names) => names.length > MAX_LISTED_NAMES
  ? `${names.slice(0, MAX_LISTED_NAMES).join(', ')}, and ${names.length - MAX_LISTED_NAMES} more (see the raw data)`
  : names.join(', ');

/**
 * What a model needs to cancel or restore single occurrences of a series:
 * the name of the occurrence shown (its ORIGINAL start), the exclusions
 * (EXDATE) and the changed occurrences (overrides), all named in the
 * series' own form, as cancel_occurrences/restore_occurrences take them
 * (see src/occurrence-names.js).
 *
 * @param {ICAL.Component} master - the component shown as the series
 * @param {'vevent'|'vtodo'} type
 * @param {Object|null} [occurrence] - the occurrence shown (getOccurrenceDetails), if any
 * @returns {Object|null} null for something that does not recur
 */
function seriesListing(master, type, occurrence = null) {
  try {
    const all = master.parent ? master.parent.getAllSubcomponents(type) : [];
    const uid = master.getFirstPropertyValue('uid');
    const overrides = all.filter((c) => c !== master && c.hasProperty('recurrence-id') &&
      c.getFirstPropertyValue('uid') === uid);
    const names = seriesNames(master, overrides, type);
    if (!names) return null;
    const { naming } = names;
    // by the instant the occurrence's own value names: an RDATE in UTC next
    // to a Berlin series is converted to the Berlin wall clock
    const shown = occurrence?.recurrenceId
      ? naming.nameTime(occurrence.recurrenceId).text
      : naming.name(master.getFirstPropertyValue('dtstart'), naming.tzid).text;
    return {
      naming,
      shown,
      shownIsOccurrence: Boolean(occurrence?.recurrenceId),
      shownChanged: Boolean(occurrence?.item?.component?.hasProperty('recurrence-id')),
      shownNow: occurrence?.startDate ? formatDateTime(occurrence.startDate) : '',
      exclusions: names.exclusions.map(labelled),
      inert: names.inert.map(labelled),
      overrides: names.overrides.map(({ text, component }) => {
        const start = component.getFirstPropertyValue('dtstart');
        const status = String(component.getFirstPropertyValue('status') || '').toUpperCase();
        const now = start ? `now ${formatDateTime(start)}` : 'changed';
        return `${text} (${now}${status === 'CANCELLED' ? ', status CANCELLED' : ''})`;
      }),
    };
  } catch {
    return null;
  }
}

/** the lines seriesListing's result adds to an event or todo */
function seriesLines(series) {
  if (!series) return '';
  const which = !series.shownIsOccurrence
    ? 'series start, the first occurrence'
    : series.shownChanged ? `this occurrence, changed — now at ${series.shownNow}` : 'this occurrence';
  let output = `- **Occurrence ID**: ${series.shown} (${which})\n`;
  if (series.exclusions.length) {
    output += `- **Cancelled occurrences**: ${listNames(series.exclusions)}\n`;
  }
  if (series.overrides.length) {
    output += `- **Changed occurrences** (by original start): ${listNames(series.overrides)}\n`;
  }
  // stored exclusions that name no occurrence: they cancel nothing
  if (series.inert.length) {
    output += `- **Exclusions that match no occurrence** (they cancel nothing): ${listNames(series.inert)}\n`;
  }
  return output;
}

/**
 * Format a single calendar event to Markdown
 */
function eventEntry(event, calendar = 'Unknown Calendar', timeRange = null, matches = null, shown = null, budget = undefined) {
  const calendarName = collectionName(calendar, 'Unknown Calendar');
  const parsed = parseICalEvent(event.data, timeRange, matches, shown, budget);
  if (parsed.unreadable) {
    return unreadableEntry('event', parsed.unreadable, event, ['Calendar', calendarName], 'update_event_raw', 'delete_event');
  }

  const startDate = formatDateTime(parsed.dtstart, parsed.dtstartAt);
  const endDate = formatDateTime(parsed.dtend, parsed.dtendAt);

  let output = `## ${parsed.summary || 'Untitled Event'}\n\n`;
  output += `- **When**: ${startDate}`;

  if (endDate && endDate !== startDate) {
    output += ` to ${endDate}`;
  }
  output += '\n';

  if (parsed.location) {
    output += `- **Where**: ${parsed.location}\n`;
  }

  // the status of what is shown — for a series, of the occurrence listed, so
  // a cancelled single occurrence does not pass for a meeting that happens
  if (parsed.status) {
    output += `- **Status**: ${parsed.status}\n`;
  }

  if (parsed.description) {
    output += `- **Description**: ${parsed.description}\n`;
  }

  // Show recurrence info if event is recurring
  if (parsed.isRecurring && parsed.rrule) {
    output += `- **Recurring**: ${parsed.rrule.toString()}\n`;
  }
  output += seriesLines(parsed.series);

  // several occurrences behind it (free/busy details): each one
  if (parsed.occurrences && parsed.occurrences.length > 1) {
    output += `- **Occurrences in the window**: ${parsed.occurrences.length}\n`;
    parsed.occurrences.forEach((o) => {
      output += `  - ${formatDateTime(o.startDate, o.startAt)} to ${formatDateTime(o.endDate, o.endAt)}\n`;
    });
  }

  // Never let a series start date pass for an occurrence in the queried range
  if (parsed.outsideRange) {
    output += `- **Note**: no occurrence of this series falls inside the queried range; the date above is the series start\n`;
  } else if (parsed.expansionTruncated && parsed.occurrenceShown) {
    output += `- **Note**: incomplete — this series could not be expanded fully (too many occurrences); an earlier occurrence in the queried range may exist\n`;
  } else if (parsed.expansionReason) {
    output += `- **Note**: incomplete — this series cannot be read (${parsed.expansionReason}); the date above is the series start, not an occurrence in the queried range\n`;
  } else if (parsed.expansionTruncated) {
    output += `- **Note**: incomplete — this series could not be expanded (too many occurrences); the date above is the series start, not an occurrence in the queried range\n`;
  }

  // Show organizer if present
  if (parsed.organizer) {
    const organizerEmail = parsed.organizer.replace('mailto:', '');
    output += `- **Organizer**: ${organizerEmail}\n`;
  }

  // Show attendees if present
  if (parsed.attendees && parsed.attendees.length > 0) {
    output += `- **Attendees**: ${parsed.attendees.length} person(s)\n`;
    parsed.attendees.forEach(att => {
      const email = att.email ? att.email.replace('mailto:', '') : '';
      const name = att.cn || email;
      const status = att.partstat ? ` (${att.partstat})` : '';
      output += `  - ${name}${status}\n`;
    });
  }

  // Show alarms if present
  if (parsed.alarms && parsed.alarms.length > 0) {
    output += `- **Reminders**: ${parsed.alarms.length} alarm(s)\n`;
    parsed.alarms.forEach(alarm => {
      output += `  - ${alarm.action}: ${alarm.trigger ? alarm.trigger.toString() : 'Unknown trigger'}\n`;
    });
  }

  output += `- **Calendar**: ${calendarName}\n`;
  output += `- **URL**: ${event.url}\n`;

  return { text: output, unreadable: null };
}

/** eventEntry as Markdown alone; takes the same arguments */
export function formatEvent(...args) {
  return eventEntry(...args).text;
}

/**
 * Format a list of calendar events to LLM-friendly Markdown
 *
 * `matches` is calendar_query's search: with a time range, each recurring
 * event is listed as the first occurrence in the range that the search
 * found (see shownEvent). `shown` hands over what the query already
 * resolved per event (a Map from the event object to shownEvent's result).
 */
export function formatEventList(events, calendar = 'Unknown Calendar', timeRange = null, total = null, matches = null, shown = null, budget = budgetPool(events?.length ?? 0)) {
  const calendarName = collectionName(calendar, 'Unknown Calendar');

  if (!events || events.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No events found.'
      }]
    };
  }

  let output = foundLine('events', events.length, total);
  let entries = '';
  let unreadable = 0;

  events.forEach((event, index) => {
    // one expansion budget for the whole list (one tool call), shared fairly
    const share = budget.take();
    const entry = eventEntry(event, calendarName, timeRange, matches, shown?.get(event), share);
    if (entry.unreadable) unreadable++;
    entries += `### ${index + 1}. ` + entry.text.replace(/^## /, '') + '\n';
    budget.give(share);
  });
  output += unreadableLine(unreadable, 'events') + entries;

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(toRawData(events), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format a single contact to Markdown
 */
function contactEntry(contact, addressBook = 'Unknown Address Book') {
  const addressBookName = collectionName(addressBook, 'Unknown Address Book');
  const parsed = parseVCard(contact.data);
  if (parsed.unreadable) {
    return unreadableEntry('contact', parsed.unreadable, contact, ['Address Book', addressBookName], 'update_contact_raw', 'delete_contact');
  }

  let output = `## ${parsed.fullName || 'Unnamed Contact'}\n\n`;

  // Show structured name if available
  if (parsed.givenName || parsed.familyName) {
    const nameParts = [];
    if (parsed.honorificPrefixes) nameParts.push(parsed.honorificPrefixes);
    if (parsed.givenName) nameParts.push(parsed.givenName);
    if (parsed.additionalNames) nameParts.push(parsed.additionalNames);
    if (parsed.familyName) nameParts.push(parsed.familyName);
    if (parsed.honorificSuffixes) nameParts.push(parsed.honorificSuffixes);
    if (nameParts.length > 0) {
      output += `- **Full Name**: ${nameParts.join(' ')}\n`;
    }
  }

  if (parsed.organization) {
    output += `- **Organization**: ${parsed.organization}\n`;
  }

  // Show all emails
  if (parsed.emails && parsed.emails.length > 0) {
    if (parsed.emails.length === 1) {
      const emailType = parsed.emails[0].type.length > 0 ? ` (${parsed.emails[0].type.join(', ')})` : '';
      output += `- **Email**: ${parsed.emails[0].value}${emailType}\n`;
    } else {
      output += `- **Emails**: ${parsed.emails.length} email(s)\n`;
      parsed.emails.forEach(email => {
        const emailType = email.type.length > 0 ? ` (${email.type.join(', ')})` : '';
        output += `  - ${email.value}${emailType}\n`;
      });
    }
  }

  // Show all phones
  if (parsed.phones && parsed.phones.length > 0) {
    if (parsed.phones.length === 1) {
      const phoneType = parsed.phones[0].type.length > 0 ? ` (${parsed.phones[0].type.join(', ')})` : '';
      output += `- **Phone**: ${parsed.phones[0].value}${phoneType}\n`;
    } else {
      output += `- **Phones**: ${parsed.phones.length} phone(s)\n`;
      parsed.phones.forEach(phone => {
        const phoneType = phone.type.length > 0 ? ` (${phone.type.join(', ')})` : '';
        output += `  - ${phone.value}${phoneType}\n`;
      });
    }
  }

  // Show all addresses
  if (parsed.addresses && parsed.addresses.length > 0) {
    output += `- **Addresses**: ${parsed.addresses.length} address(es)\n`;
    parsed.addresses.forEach(addr => {
      const addrParts = [];
      if (addr.streetAddress) addrParts.push(addr.streetAddress);
      if (addr.locality) addrParts.push(addr.locality);
      if (addr.region) addrParts.push(addr.region);
      if (addr.postalCode) addrParts.push(addr.postalCode);
      if (addr.country) addrParts.push(addr.country);
      const addrType = addr.type.length > 0 ? ` (${addr.type.join(', ')})` : '';
      if (addrParts.length > 0) {
        output += `  - ${addrParts.join(', ')}${addrType}\n`;
      }
    });
  }

  if (parsed.note) {
    output += `- **Note**: ${parsed.note}\n`;
  }

  output += `- **Address Book**: ${addressBookName}\n`;
  output += `- **URL**: ${contact.url}\n`;

  return { text: output, unreadable: null };
}

/** contactEntry as Markdown alone; takes the same arguments */
export function formatContact(...args) {
  return contactEntry(...args).text;
}

/**
 * Format a list of contacts to LLM-friendly Markdown
 */
export function formatContactList(contacts, addressBook = 'Unknown Address Book', total = null) {
  const addressBookName = collectionName(addressBook, 'Unknown Address Book');

  if (!contacts || contacts.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No contacts found in ${addressBookName}.

💡 **Next steps**:
- Try broader search: use addressbook_query with partial name
- List all contacts: use list_contacts to see available names  
- Create new contact: use create_contact if contact doesn't exist yet

📝 **Available address books**: Use list_addressbooks to see all address books`
      }]
    };
  }

  let output = foundLine('contacts', contacts.length, total, `the first ${contacts.length} by name`);
  let entries = '';
  let unreadable = 0;

  contacts.forEach((contact, index) => {
    const entry = contactEntry(contact, addressBookName);
    if (entry.unreadable) unreadable++;
    entries += `### ${index + 1}. ` + entry.text.replace(/^## /, '') + '\n';
  });
  output += unreadableLine(unreadable, 'contacts') + entries;

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(toRawData(contacts), null, 2);
  output += '\n```\n</details>';

  // Add next action hints
  output += `\n💡 **What you can do next**:
- Update contact: use update_contact with URL and ETAG from above
- Delete contact: use delete_contact with URL and ETAG from above
- Get full details: Contact data already complete above`;

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Helper: Extract string value from property (handles both string and object)
 * tsdav sometimes returns { _text: "value" } instead of "value"
 */
function extractPropertyValue(prop) {
  if (prop === undefined || prop === null) return '';
  if (typeof prop === 'string') return prop;
  if (typeof prop === 'object') {
    // tsdav hands over a text or CDATA node — or, for an empty element such
    // as Baikal's unset <x1:calendar-color/>, an object holding only the
    // namespace attributes. That one has no value; String() made it
    // "[object Object]".
    const text = prop._text ?? prop._cdata ?? prop.value;
    return text === undefined || text === null ? '' : String(text);
  }
  return String(prop);
}

/**
 * Format calendar list to LLM-friendly Markdown
 */
export function formatCalendarList(calendars) {
  if (!calendars || calendars.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No calendars found.'
      }]
    };
  }

  let output = `Available calendars: **${calendars.length}**\n\n`;

  calendars.forEach((cal, index) => {
    const displayName = extractPropertyValue(cal.displayName) || 'Unnamed Calendar';
    output += `### ${index + 1}. ${displayName}\n\n`;

    const description = extractPropertyValue(cal.description);
    if (description) {
      output += `- **Description**: ${description}\n`;
    }

    if (cal.components) {
      output += `- **Components**: ${cal.components.join(', ')}\n`;
    }

    const color = extractPropertyValue(cal.calendarColor);
    if (color) {
      output += `- **Color**: ${color}\n`;
    }

    output += `- **URL**: ${cal.url}\n\n`;
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(calendars.map(cal => ({
    displayName: cal.displayName,
    url: cal.url,
    components: cal.components,
    calendarColor: extractPropertyValue(cal.calendarColor) || undefined,
    description: extractPropertyValue(cal.description) || undefined,
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format address book list to LLM-friendly Markdown
 */
export function formatAddressBookList(addressBooks) {
  if (!addressBooks || addressBooks.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No address books found.'
      }]
    };
  }

  let output = `Available address books: **${addressBooks.length}**\n\n`;

  addressBooks.forEach((ab, index) => {
    output += `### ${index + 1}. ${ab.displayName || 'Unnamed Address Book'}\n\n`;

    if (ab.description) {
      output += `- **Description**: ${ab.description}\n`;
    }

    output += `- **URL**: ${ab.url}\n\n`;
  });

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(addressBooks.map(ab => ({
    displayName: ab.displayName,
    url: ab.url,
    description: ab.description,
  })), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Format success message for create/update/delete operations
 */
export function formatSuccess(operation, details = {}) {
  // Callers pass a complete phrase ("Todo created successfully"); appending a
  // second "successful" here produced "created successfully successful" in
  // every write response the model reads back.
  let output = `✅ **${operation}**\n\n`;

  if (details.url) {
    output += `- **URL**: ${details.url}\n`;
  }

  // A write the server answered without a usable ETag says so, instead of
  // leaving the line out: the caller has to refetch before the next update.
  if (details.etag) {
    output += `- **ETag**: ${details.etag}\n`;
  } else if (details.etag_note) {
    output += `- **ETag**: ${details.etag_note}\n`;
  }

  if (details.message) {
    output += `- **Message**: ${details.message}\n`;
  }

  // cancel_occurrences / restore_occurrences: what the exclusions now are,
  // by name, so the model can tell the user what was cancelled or restored
  if (details.occurrences?.summary) {
    output += `- **Occurrences**: ${details.occurrences.summary}\n`;
  }

  // A write to a recurring series can change more than was named: what else
  // moved is shown, so the model can tell the user.
  if (details.series?.summary) {
    output += `- **Series**: ${details.series.summary}\n`;
  }

  output += `\n---\n<details>\n<summary>Rohdaten (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, ...details }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

export function formatCalendarUpdateSuccess(calendar, updatedFields) {
  let output = `✅ **Calendar updated successfully**\n\n`;

  const displayName = extractPropertyValue(calendar.displayName) || 'Unnamed Calendar';
  output += `- **Calendar**: ${displayName}\n`;
  output += `- **URL**: ${calendar.url}\n`;

  if (updatedFields && Object.keys(updatedFields).length > 0) {
    output += `\n**Updated fields:**\n`;
    if (updatedFields.display_name) {
      output += `- Display name: ${updatedFields.display_name}\n`;
    }
    if (updatedFields.description) {
      output += `- Description: ${updatedFields.description}\n`;
    }
    if (updatedFields.color) {
      output += `- Color: ${updatedFields.color}\n`;
    }
    if (updatedFields.timezone) {
      output += `- Timezone: ${updatedFields.timezone}\n`;
    }
  }

  output += `\n---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, calendar, updatedFields }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

export function formatCalendarDeleteSuccess(calendarUrl) {
  let output = `✅ **Calendar deleted successfully**\n\n`;

  // Not "permanently": a server with a trash bin (Nextcloud) keeps the
  // calendar there, and we cannot tell which kind of server this is.
  output += `⚠️ **Warning**: The calendar and all its events have been deleted. ` +
    `Servers with a trash bin keep them there for a while; on other servers they are gone for good.\n\n`;
  output += `- **Deleted URL**: ${calendarUrl}\n`;

  output += `\n---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, deleted: true, url: calendarUrl }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Result for a delete_calendar whose target is already in the trash bin
 */
export function formatCalendarAlreadyDeleted(calendarUrl) {
  let output = `ℹ️ **Calendar was already deleted**\n\n`;

  output += `The calendar at this URL is in the server's trash bin. Nothing was changed.\n\n`;
  output += `- **URL**: ${calendarUrl}\n`;

  output += `\n---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify({ success: true, deleted: false, alreadyDeleted: true, url: calendarUrl }, null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * Parse VTODO (task) from iCal data
 */
function parseVTodo(icalData) {
  try {
    const jcalData = parseICal(icalData);
    const comp = new ICAL.Component(jcalData);
    // the master, the todo update_todo edits, not whichever VTODO comes first
    const vtodo = readSeries(comp, 'vtodo')?.master;

    if (!vtodo) {
      return {};
    }

    return {
      uid: vtodo.getFirstPropertyValue('uid') || '',
      summary: vtodo.getFirstPropertyValue('summary') || '',
      description: vtodo.getFirstPropertyValue('description') || '',
      status: todoStatus(vtodo),
      priority: vtodo.getFirstPropertyValue('priority') || 0,
      percentComplete: vtodo.getFirstPropertyValue('percent-complete') || 0,
      due: vtodo.getFirstPropertyValue('due'),
      completed: vtodo.getFirstPropertyValue('completed'),
      dtstart: vtodo.getFirstPropertyValue('dtstart'),
      rrule: vtodo.getFirstPropertyValue('rrule'),
      series: seriesListing(vtodo, 'vtodo'),
    };
  } catch (error) {
    // the parser's message quotes the offending line: personal data, so only its type
    console.error(`Skipped a todo that could not be parsed (${error.name})`);
    return { unreadable: unreadableReason(error, 'iCalendar') };
  }
}

/**
 * Get emoji for todo status
 */
function getStatusEmoji(status) {
  const statusMap = {
    'NEEDS-ACTION': '📋',
    'IN-PROCESS': '🔄',
    'COMPLETED': '✅',
    'CANCELLED': '❌',
  };
  return statusMap[status] || '📋';
}

/**
 * Format priority (0-9 where 0=undefined, 1=highest, 9=lowest)
 */
function formatPriority(priority) {
  if (priority === 0 || priority === undefined) return 'None';
  if (priority >= 1 && priority <= 3) return `🔴 High (${priority})`;
  if (priority >= 4 && priority <= 6) return `🟡 Medium (${priority})`;
  return `🟢 Low (${priority})`;
}

/**
 * Format a single todo to Markdown
 */
function todoEntry(todo, calendar = 'Unknown Calendar') {
  const calendarName = collectionName(calendar, 'Unknown Calendar');
  const parsed = parseVTodo(todo.data);
  if (parsed.unreadable) {
    return unreadableEntry('todo', parsed.unreadable, todo, ['Calendar', calendarName], 'update_todo_raw', 'delete_todo');
  }
  const statusEmoji = getStatusEmoji(parsed.status);

  let output = `## ${statusEmoji} ${parsed.summary || 'Untitled Task'}\n\n`;

  output += `- **Status**: ${parsed.status}\n`;

  if (parsed.due) {
    output += `- **Due**: ${formatDateTime(parsed.due)}\n`;
  }

  if (parsed.priority && parsed.priority !== 0) {
    output += `- **Priority**: ${formatPriority(parsed.priority)}\n`;
  }

  if (parsed.percentComplete > 0) {
    output += `- **Progress**: ${parsed.percentComplete}%\n`;
  }

  if (parsed.description) {
    output += `- **Description**: ${parsed.description}\n`;
  }

  if (parsed.dtstart) {
    output += `- **Start**: ${formatDateTime(parsed.dtstart)}\n`;
  }

  if (parsed.completed) {
    output += `- **Completed**: ${formatDateTime(parsed.completed)}\n`;
  }

  if (parsed.rrule) {
    output += `- **Recurring**: ${parsed.rrule.toString()}\n`;
  }
  output += seriesLines(parsed.series);

  output += `- **Calendar**: ${calendarName}\n`;
  output += `- **URL**: ${todo.url}\n`;
  output += `- **ETag**: ${todo.etag} *(required for updates)*\n`;

  return { text: output, unreadable: null };
}

/** todoEntry as Markdown alone; takes the same arguments */
export function formatTodo(...args) {
  return todoEntry(...args).text;
}

/**
 * Format a list of todos to LLM-friendly Markdown
 */
export function formatTodoList(todos, calendar = 'Unknown Calendar', total = null) {
  const calendarName = collectionName(calendar, 'Unknown Calendar');
  if (!todos || todos.length === 0) {
    return {
      content: [{
        type: 'text',
        text: 'No todos found.'
      }]
    };
  }

  let output = foundLine('todos', todos.length, total);
  let entries = '';
  let unreadable = 0;

  todos.forEach((todo, index) => {
    const entry = todoEntry(todo, calendarName);
    if (entry.unreadable) unreadable++;
    entries += `### ${index + 1}. ` + entry.text.replace(/^## /, '') + '\n';
  });
  output += unreadableLine(unreadable, 'todos') + entries;

  output += `---\n<details>\n<summary>Raw Data (JSON)</summary>\n\n\`\`\`json\n`;
  output += JSON.stringify(toRawData(todos), null, 2);
  output += '\n```\n</details>';

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

/**
 * An object that could not be parsed, in a listing: not dropped, and not
 * shown as an empty "Untitled" entry either. Its URL and etag are there to
 * replace or delete it; its stored text is in the Raw Data block.
 *
 * @param {string} noun - event, contact, todo
 * @param {string} reason - unreadableReason
 * @param {{url: string, etag?: string}} object
 * @param {[string, string]} collection - label and name
 * @param {string} replaceTool
 * @param {string} deleteTool
 * @returns {{text: string, unreadable: string}}
 */
function unreadableEntry(noun, reason, object, [label, name], replaceTool, deleteTool) {
  let text = `## Unreadable ${noun}\n\n`;
  text += `- **Note**: could not be read — ${reason}. Its details are not shown; ${replaceTool} can replace it, ${deleteTool} remove it\n`;
  text += `- **${label}**: ${name}\n`;
  text += `- **URL**: ${object.url}\n`;
  if (object.etag) text += `- **ETag**: ${object.etag}\n`;
  return { text, unreadable: reason };
}

/** the line a listing opens with when some of its objects could not be read */
function unreadableLine(count, noun) {
  if (count === 0) return '';
  const [these, are] = count === 1 ? [`1 of these ${noun}`, 'is'] : [`${count} of these ${noun}`, 'are'];
  return `**${these} could not be read** and ${are} listed without details; the note on each says why.\n\n`;
}

/**
 * How many skipped objects a notice names one by one: enough to act on, and a
 * calendar full of them does not flood the answer.
 */
const LISTED_UNREADABLE = 10;

/** the line for the skipped objects past LISTED_UNREADABLE, or '' */
function moreLine(count) {
  return count > LISTED_UNREADABLE ? `- and ${count - LISTED_UNREADABLE} more\n` : '';
}

/**
 * Add the objects a query could not search to its result: they could not be
 * read, so they match no filter — which must not read as "not there".
 *
 * @param {{content: Array<{type:string, text:string}>}} result - formatted list
 * @param {Array<{object: {url: string}, reason: string}>} unsearched - unsearchedObjects
 * @param {string} noun - events, contacts, todos
 * @param {string} listTool - the tool that lists them unfiltered
 */
export function withUnsearched(result, unsearched, noun, listTool) {
  if (!unsearched || unsearched.length === 0) return result;

  let output = `\n\n---\nNot searched: **${unsearched.length}** ${noun} could not be read, so no filter can match them ` +
    `(${listTool} lists them with the reason):\n\n`;
  for (const { object, reason } of unsearched.slice(0, LISTED_UNREADABLE)) output += `- ${object.url} — ${reason}\n`;
  output += moreLine(unsearched.length);

  const [first, ...rest] = result.content;
  return { ...result, content: [{ ...first, text: first.text + output }, ...rest] };
}

/**
 * Add the URLs a multiget could not return to a formatted list result.
 *
 * A multiget answers per URL, so one deleted object must not read as "nothing
 * found" or fail the call: the caller gets what exists, plus which URLs did
 * not and why.
 *
 * @param {{content: Array<{type:string, text:string}>}} result - formatted list
 * @param {Array<{url:string, status?:number, statusText:string}>} missing
 */
export function withMissingObjects(result, missing) {
  if (!missing || missing.length === 0) return result;

  let output = `\n\n---\nNot found: **${missing.length}**\n\n`;
  for (const { url, status, statusText } of missing) {
    let reason;
    if (status === 404) reason = 'not found';
    else if (status === undefined) reason = `not found (${statusText})`;
    else reason = `${status} ${statusText}`.trim();
    output += `- ${url} — ${reason}\n`;
  }

  const [first, ...rest] = result.content;
  return { ...result, content: [{ ...first, text: first.text + output }, ...rest] };
}

/**
 * Format a free/busy answer to LLM-friendly Markdown
 *
 * Free slots come first: the question behind this tool is almost always "when
 * can I put something", not "what am I doing".
 */
export function formatFreeBusy({ busy, free, range, calendarCount = 1, events = null, incomplete = [] }) {
  const scope = calendarCount === 1 ? '1 calendar' : `${calendarCount} calendars`;

  let output = `## Free/Busy\n\n`;
  output += `- **Window**: ${formatDateTime(ICAL.Time.fromJSDate(range.start, true))} to ${formatDateTime(ICAL.Time.fromJSDate(range.end, true))}\n`;
  output += `- **Scope**: ${scope}\n\n`;

  // a series too dense to expand fully may hold busy time not counted below,
  // so neither the free slots nor an empty busy list can be taken as certain
  if (incomplete.length > 0) {
    output += `**Warning**: incomplete — ${incomplete.length === 1 ? 'an event' : `${incomplete.length} events`} could not be read or expanded fully (an object that cannot be read, a series that cannot be read, or too many occurrences), so busy time from ${incomplete.length === 1 ? 'it' : 'them'} may be missing and the free time below is not certain:\n`;
    incomplete.slice(0, LISTED_UNREADABLE).forEach(({ object, summary, reason }) => {
      output += `- ${summary || 'Untitled Event'} (${object.url})${reason ? `: cannot be read — ${reason}` : ''}\n`;
    });
    output += moreLine(incomplete.length);
    output += '\n';
  }

  if (free.length === 0) {
    output += `**No free time** in this window — it is fully booked.\n\n`;
  } else {
    output += `### Free (${free.length})\n\n`;
    free.forEach(slot => {
      output += `- ${formatInterval(slot)}\n`;
    });
    output += '\n';
  }

  if (busy.length === 0) {
    output += incomplete.length > 0
      ? `### Busy (0)\n\nNo busy time found, but the events named above could not be read or fully expanded.\n`
      : `### Busy (0)\n\nNothing blocks this window.\n`;
  } else {
    output += `### Busy (${busy.length})\n\n`;
    busy.forEach(slot => {
      output += `- ${formatInterval(slot)}\n`;
    });
  }

  if (events) {
    output += `\n### Events behind the busy blocks (${events.length})\n\n`;
    events.forEach(({ object, shown }, index) => {
      output += `#### ${index + 1}. `;
      // exactly the occurrences that make up the busy time (calculateFreeBusy)
      output += formatEvent(object, 'Calendar', null, null, shown).replace(/^## /, '') + '\n';
    });
  }

  return {
    content: [{
      type: 'text',
      text: output
    }]
  };
}

function formatInterval({ start, end }) {
  const from = formatDateTime(ICAL.Time.fromJSDate(start, true));
  const to = formatDateTime(ICAL.Time.fromJSDate(end, true));
  const minutes = Math.round((end.getTime() - start.getTime()) / 60000);
  const duration = minutes >= 60
    ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
    : `${minutes}m`;

  return `${from} → ${to} (${duration})`;
}
