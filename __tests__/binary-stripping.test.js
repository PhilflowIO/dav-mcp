import { describe, test, expect } from '@jest/globals';
import ICAL from 'ical.js';
import { stripBinaryValues, formatContactList, formatEventList } from '../src/formatters.js';

// A ~120 KB JPEG, base64-encoded and folded the way a server returns it.
const photoBase64 = '/9j/4AAQSkZJRgABAQEAYABgAAD' + 'A'.repeat(160000);
const fold = (name, value) => {
  const first = `${name}:${value.slice(0, 74 - name.length)}`;
  const rest = value.slice(74 - name.length).match(/.{1,73}/g) || [];
  return [first, ...rest.map(chunk => ` ${chunk}`)].join('\r\n');
};

const contactWithPhoto = {
  url: 'https://dav.example.com/addressbooks/user/default/c.vcf',
  etag: '"1"',
  data: [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'UID:c@example.com',
    'FN:Ada Lovelace',
    'EMAIL;TYPE=INTERNET:ada@example.com',
    fold('PHOTO;ENCODING=b;TYPE=JPEG', photoBase64),
    'NOTE:First programmer',
    'END:VCARD',
  ].join('\r\n'),
};

describe('stripBinaryValues', () => {
  test('replaces an inline photo with a placeholder', () => {
    const result = stripBinaryValues(contactWithPhoto.data);
    expect(result).toContain('PHOTO;ENCODING=b;TYPE=JPEG:<stripped');
    expect(result).not.toContain(photoBase64.slice(0, 200));
  });

  test('keeps every other property intact', () => {
    const result = stripBinaryValues(contactWithPhoto.data);
    expect(result).toContain('FN:Ada Lovelace');
    expect(result).toContain('EMAIL;TYPE=INTERNET:ada@example.com');
    expect(result).toContain('NOTE:First programmer');
    expect(result).toContain('END:VCARD');
  });

  test('the result is still parseable', () => {
    const vcard = new ICAL.Component(ICAL.parse(stripBinaryValues(contactWithPhoto.data)));
    expect(vcard.getFirstPropertyValue('fn')).toBe('Ada Lovelace');
    expect(vcard.getFirstPropertyValue('note')).toBe('First programmer');
  });

  test('keeps a short URI value — only blobs are stripped', () => {
    const data = 'BEGIN:VCARD\r\nPHOTO;VALUE=URI:https://example.com/ada.jpg\r\nEND:VCARD';
    expect(stripBinaryValues(data)).toBe(data);
  });

  test('strips a base64 ATTACH on an event', () => {
    const data = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'SUMMARY:With attachment',
      fold('ATTACH;ENCODING=BASE64;VALUE=BINARY', 'B'.repeat(5000)),
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');
    const result = stripBinaryValues(data);
    expect(result).toContain('ATTACH;ENCODING=BASE64;VALUE=BINARY:<stripped');
    expect(result).toContain('SUMMARY:With attachment');
  });

  test('leaves blob-free data byte-identical', () => {
    const data = 'BEGIN:VCARD\r\nFN:Ada\r\nEND:VCARD';
    expect(stripBinaryValues(data)).toBe(data);
  });

  test('tolerates non-string input', () => {
    expect(stripBinaryValues(undefined)).toBeUndefined();
  });
});

describe('list output no longer carries inline blobs', () => {
  test('formatContactList strips the photo from the raw block', () => {
    const withPhoto = formatContactList([contactWithPhoto], 'Default').content[0].text;
    const withoutPhoto = formatContactList([{
      ...contactWithPhoto,
      data: contactWithPhoto.data.replace(/PHOTO[\s\S]*?\r\nNOTE:/, 'NOTE:'),
    }], 'Default').content[0].text;

    expect(withPhoto).not.toContain(photoBase64.slice(0, 200));
    expect(withPhoto).toContain('Ada Lovelace');
    // the blob accounted for essentially all of the output
    expect(withPhoto.length).toBeLessThan(withoutPhoto.length * 1.2);
  });

  test('formatEventList routes through the same shaping', () => {
    const event = {
      url: 'https://dav.example.com/calendars/user/work/e.ics',
      etag: '"1"',
      data: [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'BEGIN:VEVENT',
        'UID:e@example.com',
        'DTSTART:20260525T100000Z',
        'DTEND:20260525T110000Z',
        'SUMMARY:Standup',
        fold('ATTACH;ENCODING=BASE64', 'C'.repeat(9000)),
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    };
    const output = formatEventList([event], 'Work').content[0].text;
    expect(output).not.toContain('CCCCCCCCCC');
    expect(output).toContain('Standup');
  });
});
