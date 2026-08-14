import { describe, test, expect } from '@jest/globals';
import {
  formatEvent,
  formatEventList,
  formatContact,
  formatContactList,
  formatTodo,
  formatTodoList,
} from '../src/formatters.js';

const EVENT = {
  url: 'https://dav.example.com/calendars/user/work/e.ics',
  etag: '"1"',
  data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VEVENT
UID:e@example.com
DTSTART:20260525T100000Z
DTEND:20260525T110000Z
SUMMARY:Standup
END:VEVENT
END:VCALENDAR`,
};

const TODO = {
  url: 'https://dav.example.com/calendars/user/work/t.ics',
  etag: '"1"',
  data: `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Test//Test//EN
BEGIN:VTODO
UID:t@example.com
SUMMARY:Write the report
END:VTODO
END:VCALENDAR`,
};

const CONTACT = {
  url: 'https://dav.example.com/addressbooks/user/default/c.vcf',
  etag: '"1"',
  data: `BEGIN:VCARD
VERSION:3.0
UID:c@example.com
FN:Ada Lovelace
END:VCARD`,
};

const text = (result) => result.content[0].text;

describe('collection names are resolved, never stringified objects', () => {
  const calendarObject = { url: 'https://dav.example.com/calendars/user/work/', displayName: 'Work' };
  const addressBookObject = { url: 'https://dav.example.com/addressbooks/user/default/', displayName: 'Default' };

  test('formatEvent accepts a calendar object', () => {
    expect(formatEvent(EVENT, calendarObject)).toContain('- **Calendar**: Work');
  });

  test('formatEventList accepts a calendar object', () => {
    expect(text(formatEventList([EVENT], calendarObject))).toContain('- **Calendar**: Work');
  });

  test('formatContactList accepts an address book object', () => {
    expect(text(formatContactList([CONTACT], addressBookObject))).toContain('- **Address Book**: Default');
  });

  test('formatTodoList accepts a calendar object', () => {
    expect(text(formatTodoList([TODO], calendarObject))).toContain('- **Calendar**: Work');
  });

  test('a plain name still works', () => {
    expect(formatEvent(EVENT, 'Work')).toContain('- **Calendar**: Work');
    expect(formatContact(CONTACT, 'Default')).toContain('- **Address Book**: Default');
    expect(formatTodo(TODO, 'Work')).toContain('- **Calendar**: Work');
  });

  test('falls back to the URL when the collection has no display name', () => {
    const unnamed = { url: 'https://dav.example.com/calendars/user/work/' };
    expect(formatEvent(EVENT, unnamed)).toContain('- **Calendar**: https://dav.example.com/calendars/user/work/');
  });

  test('unwraps the { _text } shape tsdav sometimes returns', () => {
    const wrapped = { url: 'https://dav.example.com/c/', displayName: { _text: 'Personal' } };
    expect(formatEvent(EVENT, wrapped)).toContain('- **Calendar**: Personal');
  });

  test('null falls back to the placeholder, not the string "null"', () => {
    // a default parameter does not fire for an explicit null
    expect(text(formatContactList([CONTACT], null))).toContain('- **Address Book**: Unknown Address Book');
    expect(text(formatEventList([EVENT], null))).toContain('- **Calendar**: Unknown Calendar');
  });

  test('the empty-result message never renders an object or null', () => {
    expect(text(formatContactList([], addressBookObject))).toContain('No contacts found in Default.');
    expect(text(formatContactList([], null))).toContain('No contacts found in Unknown Address Book.');
  });

  test('no formatter output ever contains [object Object]', () => {
    const outputs = [
      formatEvent(EVENT, calendarObject),
      text(formatEventList([EVENT], calendarObject)),
      formatContact(CONTACT, addressBookObject),
      text(formatContactList([CONTACT], addressBookObject)),
      text(formatContactList([], addressBookObject)),
      formatTodo(TODO, calendarObject),
      text(formatTodoList([TODO], calendarObject)),
    ];
    outputs.forEach(output => expect(output).not.toContain('[object Object]'));
  });
});
