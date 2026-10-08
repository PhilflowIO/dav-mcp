import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import ICAL from 'ical.js';
import { connectTo } from './support/request-origins.js';

// Issue #103: vCard 2.1 cards (Outlook/Android exports) are read and edited as
// the 3.0 card that says the same — quoted-printable decoded, 2.1 escaping
// kept, one normalizer for reading and for update_contact.
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';
const CARD_URL = `${ADDRESSBOOK_URL}card.vcf`;
connectTo('https://dav.example.com/');

const updateVCard = jest.fn(async () => ({ ok: true, status: 204, headers: new Headers({ etag: '"2"' }) }));
let storedCard = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      fetchVCards: async () => [{ url: CARD_URL, etag: '"1"', data: storedCard }],
      updateVCard,
    }),
  },
}));

const { updateContactFields } = await import('../src/tools/contacts/update-contact-fields.js');
const { listContacts } = await import('../src/tools/contacts/list-contacts.js');
const { readVCard } = await import('../src/vcard.js');

const v21 = (...lines) => ['BEGIN:VCARD', 'VERSION:2.1', 'UID:card-1', ...lines, 'END:VCARD', ''].join('\r\n');

/** the listing a reader sees, without the Raw Data block */
const listed = async () => (await listContacts.handler({ addressbook_url: ADDRESSBOOK_URL })).content[0].text.split('<details>')[0];

const update = async (fields) => {
  updateVCard.mockClear();
  await updateContactFields.handler({ vcard_url: CARD_URL, vcard_etag: '"1"', fields });
  return updateVCard.mock.calls[0][0].vCard.data;
};

const parsed = (data) => new ICAL.Component(ICAL.parse(data));

describe('update_contact on a vCard 2.1 card', () => {
  beforeEach(() => updateVCard.mockClear());

  test('an edited quoted-printable card is written back decoded, as 3.0', async () => {
    storedCard = v21(
      'N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;Hans',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Hans M=C3=BCller',
      'ORG;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:B=C3=A4ckerei',
      'NOTE;ENCODING=QUOTED-PRINTABLE:Zeile1=0D=0AZeile2 =',
      'weiter');
    const written = await update({ FN: 'Hans Müller-Neu' });

    expect(written).not.toMatch(/ENCODING|CHARSET|=C3/i);
    const card = parsed(written);
    expect(card.getFirstPropertyValue('version')).toBe('3.0');
    expect(card.getFirstPropertyValue('fn')).toBe('Hans Müller-Neu');
    expect(card.getFirstPropertyValue('n')).toEqual(['Müller', 'Hans']);
    expect(card.getFirstPropertyValue('org')).toBe('Bäckerei');
    expect(card.getFirstPropertyValue('note')).toBe('Zeile1\nZeile2 weiter');
  });

  test('a value that looks like quoted-printable is written as plain text', async () => {
    // the new value used to keep the line's ENCODING=QUOTED-PRINTABLE and
    // read back decoded ("=AB" -> "«") or with its "=" eating the next line
    storedCard = v21('FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Hans M=C3=BCller',
      'NOTE;ENCODING=QUOTED-PRINTABLE:alt', 'EMAIL:h@x.de');
    for (const note of ['Rabatt=AB jetzt', 'token abc=']) {
      storedCard = await update({ NOTE: note });
      const card = readVCard(storedCard);
      expect(card.getFirstPropertyValue('note')).toBe(note);
      expect(card.getFirstPropertyValue('email')).toBe('h@x.de');
    }
  });

  test('a card with bare parameters and a soft line break can be edited', async () => {
    // updateFields used to throw "Missing parameter value" and "invalid line"
    storedCard = v21('FN;CHARSET=UTF-8;QUOTED-PRINTABLE:Hans M=C3=',
      '=BCller', 'EMAIL;PREF;INTERNET:h@x.de', 'TEL;CELL:+49 170 1');
    const card = parsed(await update({ TITLE: 'Chef' }));
    expect(card.getFirstPropertyValue('fn')).toBe('Hans Müller');
    expect(card.getFirstPropertyValue('title')).toBe('Chef');
    expect(card.getFirstProperty('email').getParameter('type')).toEqual(['PREF', 'INTERNET']);
    expect(card.getFirstProperty('tel').getParameter('type')).toBe('CELL');
  });

  test('2.1 commas and backslashes survive an edit', async () => {
    storedCard = v21('N:Mueller, Jr.;Hans', 'NOTE:C:\\new, D:\\old');
    const card = parsed(await update({ TITLE: 'Chef' }));
    expect(card.getFirstPropertyValue('n')).toEqual(['Mueller, Jr.', 'Hans']);
    expect(card.getFirstPropertyValue('note')).toBe('C:\\new, D:\\old');
  });

  test('a base64 photo becomes the 3.0 ENCODING=b', async () => {
    storedCard = v21('FN:Pic', 'PHOTO;ENCODING=BASE64;TYPE=JPEG:AAAABBBB', '');
    const written = await update({ TITLE: 'Chef' });
    expect(written).toContain('PHOTO;TYPE=JPEG;ENCODING=b:AAAABBBB');
  });

  test('an indented 2.1 base64 photo is written without whitespace', async () => {
    storedCard = v21('FN:Pic', 'PHOTO;ENCODING=BASE64;TYPE=JPEG:', '  AAAA', '  BBBB', '');
    const written = await update({ TITLE: 'Chef' });
    expect(written).toContain('PHOTO;TYPE=JPEG;ENCODING=b:AAAABBBB');
  });

  test('a 3.0 card with bare parameters and quoted-printable can be edited', async () => {
    // updateFields used to throw "Missing parameter value" on TEL;CELL;VOICE
    storedCard = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:card-1',
      'FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:J=C3=BCrgen', 'TEL;CELL;VOICE:+49 1', 'END:VCARD'].join('\r\n');
    const written = await update({ TITLE: 'Chef' });
    expect(written).not.toMatch(/ENCODING|CHARSET/);
    const card = parsed(written);
    expect(card.getFirstPropertyValue('fn')).toBe('Jürgen');
    expect(card.getFirstProperty('tel').getParameter('type')).toEqual(['CELL', 'VOICE']);
  });

  test('a 3.0 card keeps its version', async () => {
    storedCard = ['BEGIN:VCARD', 'VERSION:3.0', 'UID:card-1', 'FN:Ann', 'N:Lee\\, Jr.;Ann', 'END:VCARD'].join('\r\n');
    const card = parsed(await update({ TITLE: 'Chef' }));
    expect(card.getFirstPropertyValue('version')).toBe('3.0');
    expect(card.getFirstPropertyValue('n')).toEqual(['Lee, Jr.', 'Ann']);
  });
});

describe('reading a vCard 2.1 card', () => {
  test('list_contacts shows quoted-printable values decoded', async () => {
    storedCard = v21('N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;Hans',
      'FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Hans M=FCller');
    const text = await listed();
    expect(text).toContain('### 1. Hans Müller');
    expect(text).toContain('- **Full Name**: Hans Müller');
  });

  test('2.1 escaping: commas and backslashes are text, \\; a literal semicolon', () => {
    const card = readVCard(v21('N:Mueller, Jr.;Hans', 'FN:A\\;B',
      'NOTE;ENCODING=QUOTED-PRINTABLE:C:=5Cnew', 'ORG:Acme\\;Corp;Sales'));
    expect(card.getFirstPropertyValue('n')).toEqual(['Mueller, Jr.', 'Hans']);
    expect(card.getFirstPropertyValue('fn')).toBe('A;B');
    expect(card.getFirstPropertyValue('note')).toBe('C:\\new');
    expect(card.getFirstPropertyValue('org')).toEqual(['Acme;Corp', 'Sales']);
  });

  test('decoded quoted-printable text in a 3.0 card keeps its commas and backslashes', () => {
    const card = readVCard(['BEGIN:VCARD', 'VERSION:3.0', 'FN:X',
      'NOTE;ENCODING=QUOTED-PRINTABLE:C:=5Cnew', 'N;ENCODING=QUOTED-PRINTABLE:Mueller=2C Jr.;Hans', 'END:VCARD'].join('\r\n'));
    expect(card.getFirstPropertyValue('note')).toBe('C:\\new');
    expect(card.getFirstPropertyValue('n')).toEqual(['Mueller, Jr.', 'Hans']);
  });

  test('a dangling soft line break does not swallow the next property', () => {
    const atEnd = readVCard(v21('FN:X', 'NOTE;ENCODING=QUOTED-PRINTABLE:abc='));
    expect(atEnd.getFirstPropertyValue('note')).toBe('abc');

    const beforeFn = readVCard(v21('NOTE;ENCODING=QUOTED-PRINTABLE:x=', 'FN:Lost', 'item1.TEL;CELL:+49 1'));
    expect(beforeFn.getFirstPropertyValue('note')).toBe('x');
    expect(beforeFn.getFirstPropertyValue('fn')).toBe('Lost');
    expect(beforeFn.getFirstPropertyValue('tel')).toBe('+49 1');
  });

  test('a soft line break before text holding a colon continues the value', () => {
    const card = readVCard(v21('FN:X', 'NOTE;ENCODING=QUOTED-PRINTABLE:Ruf an=', 'Note: morgen 10:00'));
    expect(card.getFirstPropertyValue('note')).toBe('Ruf anNote: morgen 10:00');
  });

  test('a 1 MB folded photo parses in linear time', () => {
    // the soft-break check once rescanned the growing line: 9 s for this card
    const base64 = Buffer.alloc(750_000, 7).toString('base64');
    const lines = ['PHOTO;ENCODING=b;TYPE=JPEG:' + base64.slice(0, 48)];
    for (let i = 48; i < base64.length; i += 74) lines.push(' ' + base64.slice(i, i + 74));
    const card = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Big', ...lines, 'END:VCARD'].join('\r\n');

    const started = performance.now();
    expect(readVCard(card).getFirstPropertyValue('fn')).toBe('Big');
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('40 000 BEGIN:VCARD lines without END or VERSION are read in linear time', () => {
    // each BEGIN used to search the rest of the body for its VERSION: 71 s here
    const body = Array(40_000).fill('BEGIN:VCARD').join('\r\n');
    const started = performance.now();
    expect(() => readVCard(body)).toThrow();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test('a parameter list folded over 8000 lines is read in linear time', () => {
    // each line used to rescan the whole parameter list so far: 70 s here
    const lines = ['X-A;' + 'p'.repeat(70) + '='];
    for (let i = 0; i < 8000; i++) lines.push(' ' + 'q'.repeat(70) + '=');
    lines.push(' :v');
    const card = ['BEGIN:VCARD', 'VERSION:3.0', 'FN:Long', ...lines, 'END:VCARD'].join('\r\n');

    const started = performance.now();
    expect(readVCard(card).getFirstPropertyValue('fn')).toBe('Long');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
