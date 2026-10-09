import { describe, test, expect } from '@jest/globals';
import { formatEventList, formatContactList, formatTodoList } from '../src/formatters.js';
import { listedEtag } from '../src/etags.js';

// What the list, query and get tools show of an object's ETag. An `etag` field
// is only ever one a write tool can send as If-Match; a weak or missing one is
// said out loud in `etag_note`, because the update it would go into is refused
// (#124) and the caller needs to know there is nothing to retry.

const rawData = (result) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(result.content[0].text)[1]);

const ics = (component) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\nBEGIN:${component}\r\nUID:u1\r\n` +
  'DTSTAMP:20260101T000000Z\r\nDTSTART:20261001T100000Z\r\n' +
  `${component === 'VEVENT' ? 'DTEND:20261001T110000Z\r\n' : ''}SUMMARY:Thing\r\nEND:${component}\r\nEND:VCALENDAR\r\n`;
const vcf = 'BEGIN:VCARD\r\nVERSION:3.0\r\nUID:c1\r\nFN:Carol\r\nN:Carol;;;;\r\nEND:VCARD\r\n';

describe('listedEtag', () => {
  test('a strong ETag is the etag field, unchanged', () => {
    expect(listedEtag('"abc"')).toEqual({ etag: '"abc"' });
    // the weak prefix is case-sensitive (RFC 9110 8.8.3): this is not one
    expect(listedEtag('w/"abc"')).toEqual({ etag: 'w/"abc"' });
  });

  test('a weak ETag is a note naming it, and that it is the server that needs fixing', () => {
    const { etag, etag_note: note } = listedEtag('W/"abc"');
    expect(etag).toBeUndefined();
    expect(note).toContain('weak ETag');
    expect(note).toContain('W/"abc"');
    expect(note).toContain('cannot be updated or deleted');
    expect(note).toContain('RFC 4791');
    // a compressing proxy weakens ETag headers, not the getetag in a listing:
    // pointing the user at the proxy would send them the wrong way
    expect(note).toContain('not a compressing proxy');
  });

  test.each([[undefined], [''], ['  ']])('no ETag at all (%p) is a note too', (value) => {
    const { etag, etag_note: note } = listedEtag(value);
    expect(etag).toBeUndefined();
    expect(note).toContain('no ETag');
    expect(note).toContain('cannot be updated or deleted');
  });
});

describe('the list formatters', () => {
  test.each([
    ['events', () => formatEventList([{ url: 'https://dav.example.com/e.ics', etag: 'W/"w"', data: ics('VEVENT') }], 'Work')],
    ['todos', () => formatTodoList([{ url: 'https://dav.example.com/t.ics', etag: 'W/"w"', data: ics('VTODO') }], 'Tasks')],
    ['contacts', () => formatContactList([{ url: 'https://dav.example.com/c.vcf', etag: 'W/"w"', data: vcf }], 'Contacts')],
  ])('%s: Raw Data marks a weak ETag instead of handing it out', (_, format) => {
    const [object] = rawData(format());
    expect(object).not.toHaveProperty('etag');
    expect(object.etag_note).toContain('W/"w"');
  });

  test('an unreadable object shows its weak ETag as unusable, too', () => {
    const result = formatEventList([{ url: 'https://dav.example.com/x.ics', etag: 'W/"w"', data: 'not iCalendar' }], 'Work');
    const etagLine = result.content[0].text.split('\n').find(line => line.startsWith('- **ETag**'));
    expect(etagLine).toContain('weak ETag');
  });

  test('a todo without an ETag no longer reads "undefined (required for updates)"', () => {
    const result = formatTodoList([{ url: 'https://dav.example.com/t.ics', data: ics('VTODO') }], 'Tasks');
    const etagLine = result.content[0].text.split('\n').find(line => line.startsWith('- **ETag**'));
    expect(etagLine).not.toContain('undefined');
    expect(etagLine).toContain('no ETag');
  });
});
