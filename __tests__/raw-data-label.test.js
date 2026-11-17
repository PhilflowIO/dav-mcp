import { describe, test, expect } from '@jest/globals';
import {
  formatSuccess, formatCalendarUpdateSuccess, formatCalendarDeleteSuccess, formatCalendarAlreadyDeleted,
  formatCalendarList, formatAddressBookList,
} from '../src/formatters.js';

// Every tool result ends with a collapsed raw-JSON block. The write results
// once labelled it "Rohdaten (JSON)" while every other result said
// "Raw Data (JSON)" (#146). The literal is pinned here, not the constant, so
// changing the wording anywhere has to change this test too.
const LABEL = '<summary>Raw Data (JSON)</summary>';

const textOf = (result) => result.content[0].text;

/** the JSON inside the raw-data block */
const rawJson = (text) => JSON.parse(text.match(/<summary>[^<]*<\/summary>\n\n```json\n([\s\S]*?)\n```\n<\/details>$/)[1]);

describe('raw-data block label', () => {
  test('a write result (formatSuccess) labels its raw JSON in English', () => {
    const text = textOf(formatSuccess('Event updated successfully', {
      url: 'https://dav.example.com/calendars/user/work/a.ics',
      etag: '"2"',
    }));

    expect(text).toContain(LABEL);
    expect(text).not.toContain('Rohdaten');
    expect(rawJson(text)).toEqual({
      success: true,
      url: 'https://dav.example.com/calendars/user/work/a.ics',
      etag: '"2"',
    });
  });

  test.each([
    ['formatCalendarUpdateSuccess', () => formatCalendarUpdateSuccess({ displayName: 'Work', url: 'https://dav.example.com/c/' }, {})],
    ['formatCalendarDeleteSuccess', () => formatCalendarDeleteSuccess('https://dav.example.com/c/')],
    ['formatCalendarAlreadyDeleted', () => formatCalendarAlreadyDeleted('https://dav.example.com/c/')],
    ['formatCalendarList', () => formatCalendarList([{ displayName: 'Work', url: 'https://dav.example.com/c/' }])],
    ['formatAddressBookList', () => formatAddressBookList([{ displayName: 'Contacts', url: 'https://dav.example.com/a/' }])],
  ])('%s uses the same label', (_, format) => {
    const text = textOf(format());
    expect(text).toContain(LABEL);
    expect(text.match(/<summary>/g)).toHaveLength(1);
  });
});
