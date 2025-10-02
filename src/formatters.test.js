/**
 * Tests for LLM-Friendly Output Formatters
 *
 * Tests RFC-compliant parsing of iCalendar and vCard data
 */

import {
  formatEvent,
  formatEventList,
  formatContact,
  formatContactList,
  formatCalendarList,
  formatAddressBookList,
  formatSuccess,
  formatError,
} from './formatters.js';

describe('RFC-Compliant iCal Event Parsing', () => {
  test('parses basic event with UTC timezone', () => {
    const event = {
      url: 'https://example.com/event1.ics',
      etag: '"123"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-123
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Team Meeting
LOCATION:Conference Room A
DESCRIPTION:Monthly team sync
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Work Calendar');

    expect(output).toContain('Team Meeting');
    expect(output).toContain('Conference Room A');
    expect(output).toContain('Monthly team sync');
    expect(output).toContain('Work Calendar');
  });

  test('parses event with timezone (TZID parameter)', () => {
    const event = {
      url: 'https://example.com/event2.ics',
      etag: '"456"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:STANDARD
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
END:STANDARD
BEGIN:DAYLIGHT
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
END:DAYLIGHT
END:VTIMEZONE
BEGIN:VEVENT
UID:event-456
DTSTAMP:20251002T120000Z
DTSTART;TZID=Europe/Berlin:20251015T100000
DTEND;TZID=Europe/Berlin:20251015T110000
SUMMARY:Berlin Meeting
LOCATION:Office Berlin
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Work Calendar');

    expect(output).toContain('Berlin Meeting');
    expect(output).toContain('Office Berlin');
  });

  test('parses multi-line description (folded lines)', () => {
    const event = {
      url: 'https://example.com/event3.ics',
      etag: '"789"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-789
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Long Description Event
DESCRIPTION:This is a very long description that spans multiple lines in t
 he iCalendar format. According to RFC 5545\\, lines longer than 75 octets
 should be folded. This tests whether our parser correctly handles line fol
 ding.
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Test Calendar');

    expect(output).toContain('Long Description Event');
    // The description should be unfolded and readable
    expect(output).toContain('This is a very long description');
    expect(output).toContain('folding');
  });

  test('parses recurring event with RRULE', () => {
    const event = {
      url: 'https://example.com/event4.ics',
      etag: '"101"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-101
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Weekly Standup
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Work Calendar');

    expect(output).toContain('Weekly Standup');
    expect(output).toContain('Recurring');
  });

  test('parses event with attendees', () => {
    const event = {
      url: 'https://example.com/event5.ics',
      etag: '"202"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-202
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Sprint Planning
ORGANIZER;CN=John Doe:mailto:john@example.com
ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=Alice Smith:mailto:alic
 e@example.com
ATTENDEE;ROLE=OPT-PARTICIPANT;PARTSTAT=TENTATIVE;CN=Bob Johnson:mailto:bob
 @example.com
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Work Calendar');

    expect(output).toContain('Sprint Planning');
    expect(output).toContain('Organizer');
    expect(output).toContain('john@example.com');
    expect(output).toContain('Attendees');
    expect(output).toContain('Alice Smith');
    expect(output).toContain('Bob Johnson');
  });

  test('parses event with alarms (VALARM)', () => {
    const event = {
      url: 'https://example.com/event6.ics',
      etag: '"303"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-303
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Doctor Appointment
BEGIN:VALARM
ACTION:DISPLAY
TRIGGER:-PT15M
DESCRIPTION:Reminder: Doctor appointment in 15 minutes
END:VALARM
BEGIN:VALARM
ACTION:AUDIO
TRIGGER:-PT1H
END:VALARM
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Personal Calendar');

    expect(output).toContain('Doctor Appointment');
    expect(output).toContain('Reminders');
    expect(output).toContain('alarm');
  });

  test('handles escaped characters in summary', () => {
    const event = {
      url: 'https://example.com/event7.ics',
      etag: '"404"',
      data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:event-404
DTSTAMP:20251002T120000Z
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Meeting: Q4 Strategy\\, Budget & Planning
DESCRIPTION:Discuss:\\n1. Q4 goals\\n2. Budget allocation\\n3. Team planning
END:VEVENT
END:VCALENDAR`,
    };

    const output = formatEvent(event, 'Work Calendar');

    // Escaped characters should be properly unescaped
    expect(output).toContain('Meeting: Q4 Strategy, Budget & Planning');
    expect(output).toContain('1. Q4 goals');
    expect(output).toContain('2. Budget allocation');
  });
});

describe('RFC-Compliant vCard Contact Parsing', () => {
  test('parses basic contact', () => {
    const contact = {
      url: 'https://example.com/contact1.vcf',
      etag: '"123"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-123
FN:Alice Smith
N:Smith;Alice;;;
EMAIL;TYPE=INTERNET:alice@example.com
TEL;TYPE=CELL:+1-555-0100
ORG:Example Corp
END:VCARD`),
    };

    const output = formatContact(contact, 'Personal Contacts');

    expect(output).toContain('Alice Smith');
    expect(output).toContain('alice@example.com');
    expect(output).toContain('+1-555-0100');
    expect(output).toContain('Example Corp');
  });

  test('parses contact with multiple emails and phones', () => {
    const contact = {
      url: 'https://example.com/contact2.vcf',
      etag: '"456"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-456
FN:Bob Johnson
N:Johnson;Bob;;;
EMAIL;TYPE=WORK:bob.work@example.com
EMAIL;TYPE=HOME:bob.personal@example.com
TEL;TYPE=WORK:+1-555-0200
TEL;TYPE=CELL:+1-555-0201
TEL;TYPE=HOME:+1-555-0202
ORG:Tech Solutions Inc
END:VCARD`),
    };

    const output = formatContact(contact, 'Work Contacts');

    expect(output).toContain('Bob Johnson');
    expect(output).toContain('3 phone(s)');
    expect(output).toContain('+1-555-0200');
    expect(output).toContain('+1-555-0201');
    expect(output).toContain('+1-555-0202');
    expect(output).toContain('2 email(s)');
    expect(output).toContain('bob.work@example.com');
    expect(output).toContain('bob.personal@example.com');
  });

  test('parses contact with full structured name', () => {
    const contact = {
      url: 'https://example.com/contact3.vcf',
      etag: '"789"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-789
FN:Dr. Jane Elizabeth Doe, PhD
N:Doe;Jane;Elizabeth;Dr.;PhD
EMAIL:jane.doe@example.com
ORG:University of Example
END:VCARD`),
    };

    const output = formatContact(contact, 'Academic Contacts');

    expect(output).toContain('Dr. Jane Elizabeth Doe, PhD');
    expect(output).toContain('jane.doe@example.com');
    expect(output).toContain('University of Example');
  });

  test('parses contact with address', () => {
    const contact = {
      url: 'https://example.com/contact4.vcf',
      etag: '"101"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-101
FN:Charlie Brown
N:Brown;Charlie;;;
EMAIL:charlie@example.com
ADR;TYPE=WORK:;;123 Main Street;Springfield;IL;62701;USA
ADR;TYPE=HOME:;;456 Oak Avenue;Shelbyville;IL;62565;USA
END:VCARD`),
    };

    const output = formatContact(contact, 'Personal Contacts');

    expect(output).toContain('Charlie Brown');
    expect(output).toContain('2 address(es)');
    expect(output).toContain('123 Main Street');
    expect(output).toContain('Springfield');
    expect(output).toContain('456 Oak Avenue');
    expect(output).toContain('Shelbyville');
  });

  test('parses contact with note', () => {
    const contact = {
      url: 'https://example.com/contact5.vcf',
      etag: '"202"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-202
FN:David Miller
N:Miller;David;;;
EMAIL:david@example.com
NOTE:Met at tech conference 2025. Interested in collaboration on AI projects.
END:VCARD`),
    };

    const output = formatContact(contact, 'Network Contacts');

    expect(output).toContain('David Miller');
    expect(output).toContain('Note');
    expect(output).toContain('Met at tech conference 2025');
    expect(output).toContain('AI projects');
  });

  test('handles escaped characters in vCard fields', () => {
    const contact = {
      url: 'https://example.com/contact6.vcf',
      etag: '"303"',
      data: (`BEGIN:VCARD
VERSION:3.0
UID:contact-303
FN:O'Brien\\, Patrick
N:O'Brien;Patrick;;;
EMAIL:patrick@example.com
NOTE:Works at Smith\\, Jones & Associates. Specialty: Tax law.
END:VCARD`),
    };

    const output = formatContact(contact, 'Legal Contacts');

    expect(output).toContain("O'Brien, Patrick");
    expect(output).toContain('patrick@example.com');
  });
});

describe('List Formatters', () => {
  test('formatEventList with multiple events', () => {
    const events = [
      {
        url: 'https://example.com/event1.ics',
        etag: '"1"',
        data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:1
DTSTART:20251015T100000Z
DTEND:20251015T110000Z
SUMMARY:Event 1
END:VEVENT
END:VCALENDAR`,
      },
      {
        url: 'https://example.com/event2.ics',
        etag: '"2"',
        data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:2
DTSTART:20251016T100000Z
DTEND:20251016T110000Z
SUMMARY:Event 2
END:VEVENT
END:VCALENDAR`,
      },
    ];

    const result = formatEventList(events, 'Test Calendar');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Found events: **2**');
    expect(result.content[0].text).toContain('Event 1');
    expect(result.content[0].text).toContain('Event 2');
    expect(result.content[0].text).toContain('Raw Data (JSON)');
  });

  test('formatEventList with no events', () => {
    const result = formatEventList([], 'Empty Calendar');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('No events found');
  });

  test('formatContactList with multiple contacts', () => {
    const contacts = [
      {
        url: 'https://example.com/contact1.vcf',
        etag: '"1"',
        data: (`BEGIN:VCARD
VERSION:3.0
UID:1
FN:Alice Smith
EMAIL:alice@example.com
END:VCARD`),
      },
      {
        url: 'https://example.com/contact2.vcf',
        etag: '"2"',
        data: (`BEGIN:VCARD
VERSION:3.0
UID:2
FN:Bob Johnson
EMAIL:bob@example.com
END:VCARD`),
      },
    ];

    const result = formatContactList(contacts, 'Test Contacts');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('Found contacts: **2**');
    expect(result.content[0].text).toContain('Alice Smith');
    expect(result.content[0].text).toContain('Bob Johnson');
  });

  test('formatCalendarList with calendars', () => {
    const calendars = [
      {
        url: 'https://example.com/cal1/',
        displayName: 'Work Calendar',
        description: 'My work events',
        components: ['VEVENT'],
        calendarColor: '#FF0000',
      },
      {
        url: 'https://example.com/cal2/',
        displayName: 'Personal Calendar',
        components: ['VEVENT', 'VTODO'],
      },
    ];

    const result = formatCalendarList(calendars);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Available calendars: **2**');
    expect(result.content[0].text).toContain('Work Calendar');
    expect(result.content[0].text).toContain('Personal Calendar');
    expect(result.content[0].text).toContain('My work events');
  });

  test('formatAddressBookList with address books', () => {
    const addressBooks = [
      {
        url: 'https://example.com/ab1/',
        displayName: 'Personal Contacts',
        description: 'My personal contacts',
      },
      {
        url: 'https://example.com/ab2/',
        displayName: 'Work Contacts',
      },
    ];

    const result = formatAddressBookList(addressBooks);

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('Available address books: **2**');
    expect(result.content[0].text).toContain('Personal Contacts');
    expect(result.content[0].text).toContain('Work Contacts');
  });
});

describe('Success and Error Formatters', () => {
  test('formatSuccess with details', () => {
    const result = formatSuccess('Event created', {
      url: 'https://example.com/event.ics',
      etag: '"abc123"',
    });

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('✅');
    expect(result.content[0].text).toContain('Event created successful');
    expect(result.content[0].text).toContain('https://example.com/event.ics');
    expect(result.content[0].text).toContain('"abc123"');
  });

  test('formatError with context', () => {
    const error = new Error('Calendar not found');
    const result = formatError(error, 'list_events');

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toContain('❌');
    expect(result.content[0].text).toContain('Error in list_events');
    expect(result.content[0].text).toContain('not found');
    expect(result.content[0].text).toContain('Possible solutions');
  });

  test('formatError handles authentication errors', () => {
    const error = new Error('Authentication failed: 401 Unauthorized');
    const result = formatError(error);

    expect(result.content[0].text).toContain('Authentication failed');
    expect(result.content[0].text).toContain('Check username and password');
  });

  test('formatError handles etag conflicts', () => {
    const error = new Error('Precondition failed: 412 etag mismatch');
    const result = formatError(error);

    expect(result.content[0].text).toContain('resource was modified');
    expect(result.content[0].text).toContain('current ETag');
  });
});
