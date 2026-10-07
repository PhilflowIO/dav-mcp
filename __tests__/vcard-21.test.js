import { describe, test, expect, jest } from '@jest/globals';

// Issue #103: vCard 2.1 cards (Outlook/Android exports) are read as the 3.0
// card that says the same — quoted-printable decoded, 2.1 escaping kept.
const ADDRESSBOOK_URL = 'https://dav.example.com/addressbooks/user/default/';
const CARD_URL = `${ADDRESSBOOK_URL}card.vcf`;

let storedCard = '';

jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: {
    getCardDavClient: () => ({
      fetchAddressBooks: async () => [{ url: ADDRESSBOOK_URL, displayName: 'Default' }],
      fetchVCards: async () => [{ url: CARD_URL, etag: '"1"', data: storedCard }],
    }),
  },
}));

const { listContacts } = await import('../src/tools/contacts/list-contacts.js');
const { readVCard } = await import('../src/vcard.js');

const v21 = (...lines) => ['BEGIN:VCARD', 'VERSION:2.1', 'UID:card-1', ...lines, 'END:VCARD', ''].join('\r\n');

/** the listing a reader sees, without the Raw Data block */
const listed = async () => (await listContacts.handler({ addressbook_url: ADDRESSBOOK_URL })).content[0].text.split('<details>')[0];

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
});
