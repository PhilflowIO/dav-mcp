import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { connectTo } from './support/request-origins.js';

connectTo('https://dav.example.com/');
import { DAVClient } from 'tsdav';

// The cache runs against real tsdav DAVClients with only fetch stubbed: the
// stub plays a CardDAV server that answers PROPFIND with the current hrefs and
// ETags and addressbook-multiget with exactly the vCards asked for, so the
// tests see which requests the cache really sends.

const SERVER = 'https://dav.example.com';
const BOOK_PATH = '/addressbooks/user/contacts/';
const BOOK_URL = `${SERVER}${BOOK_PATH}`;

const vcard = (uid, name) =>
  `BEGIN:VCARD\r\nVERSION:3.0\r\nUID:${uid}\r\nFN:${name}\r\nN:${name};;;;\r\nEND:VCARD\r\n`;

const xml = (members) => new Response(
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">' +
  `${members.join('')}</d:multistatus>`,
  { status: 207, statusText: 'Multi-Status', headers: { 'content-type': 'application/xml; charset=utf-8' } },
);

const ok = (href, props) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${props}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

/**
 * A fake CardDAV server: name -> { etag, name } per address book client.
 * withEtags=false makes PROPFIND omit getetag, as some servers do.
 */
function makeServer() {
  const server = { contacts: new Map(), withEtags: true, requests: [] };
  server.fetch = jest.fn(async (url, init) => {
    server.requests.push({ url, method: init.method, body: init.body });
    if (init.method === 'PROPFIND') {
      return xml([
        ok(BOOK_PATH, '<d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'),
        ok(`${BOOK_PATH}sub/`, '<d:resourcetype><d:collection/></d:resourcetype>'),
        ...[...server.contacts].map(([file, c]) => ok(`${BOOK_PATH}${file}`,
          (server.withEtags ? `<d:getetag>&quot;${c.etag}&quot;</d:getetag>` : '') + '<d:resourcetype/>')),
      ]);
    }
    if (init.method === 'REPORT' && /addressbook-multiget/.test(init.body)) {
      const hrefs = [...init.body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map(m => m[1]);
      return xml(hrefs.map((href) => {
        const c = server.contacts.get(href.slice(BOOK_PATH.length));
        return c
          ? ok(href, `<d:getetag>&quot;${c.etag}&quot;</d:getetag><card:address-data>${vcard(href, c.name)}</card:address-data>`)
          : `<d:response><d:href>${href}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
      }));
    }
    throw new Error(`unexpected request ${init.method} ${url}`);
  });
  server.client = new DAVClient({
    serverUrl: `${SERVER}/`,
    credentials: { username: 'user', password: 'pass' },
    authMethod: 'Basic',
    fetch: server.fetch,
  });
  server.client.authHeaders = { authorization: 'Basic dXNlcjpwYXNz' };
  server.client.fetchAddressBooks = async () => [{ url: BOOK_URL, displayName: 'Contacts' }];
  server.reports = () => server.requests.filter(r => r.method === 'REPORT');
  server.multigetHrefs = () => server.reports()
    .flatMap(r => [...r.body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map(m => m[1]));
  server.reset = () => { server.requests.length = 0; };
  return server;
}

let server;
jest.unstable_mockModule('../src/tsdav-client.js', () => ({
  tsdavManager: { getCardDavClient: () => server.client },
}));

const { fetchVCardsCached } = await import('../src/tools/contacts/vcard-cache.js');
const { listContacts } = await import('../src/tools/contacts/list-contacts.js');

const names = (vcards) => vcards.map(v => /FN:(.*)\r\n/.exec(v.data)[1]).sort();

beforeEach(() => {
  server = makeServer();
  server.contacts.set('a.vcf', { etag: 'a1', name: 'Ada Lovelace' });
  server.contacts.set('b.vcf', { etag: 'b1', name: 'Alan Turing' });
});

describe('fetchVCardsCached', () => {
  test('first call fetches every vCard, a repeated call on an unchanged book only lists', async () => {
    const first = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(names(first)).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(server.multigetHrefs().sort()).toEqual([`${BOOK_PATH}a.vcf`, `${BOOK_PATH}b.vcf`]);

    server.reset();
    const second = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(second).toEqual(first);
    expect(server.requests.map(r => r.method)).toEqual(['PROPFIND']);
  });

  test('the PROPFIND asks for getetag and resourcetype at depth 1; collections are not fetched', async () => {
    await fetchVCardsCached(server.client, { url: BOOK_URL });
    const propfind = server.requests.find(r => r.method === 'PROPFIND');
    expect(propfind.url).toBe(BOOK_URL);
    expect(propfind.body).toMatch(/<d:getetag\/>/);
    expect(propfind.body).toMatch(/<d:resourcetype\/>/);
    expect(server.multigetHrefs()).not.toContain(BOOK_PATH);
    expect(server.multigetHrefs()).not.toContain(`${BOOK_PATH}sub/`);
  });

  test('a changed ETag refetches only that vCard', async () => {
    await fetchVCardsCached(server.client, { url: BOOK_URL });
    server.contacts.set('b.vcf', { etag: 'b2', name: 'Alan M. Turing' });

    server.reset();
    const result = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(server.multigetHrefs()).toEqual([`${BOOK_PATH}b.vcf`]);
    expect(names(result)).toEqual(['Ada Lovelace', 'Alan M. Turing']);
    expect(result.find(v => v.url.endsWith('b.vcf')).etag).toBe('"b2"');
  });

  test('added vCards are fetched, deleted ones drop out', async () => {
    await fetchVCardsCached(server.client, { url: BOOK_URL });
    server.contacts.delete('a.vcf');
    server.contacts.set('c.vcf', { etag: 'c1', name: 'Grace Hopper' });

    server.reset();
    const result = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(server.multigetHrefs()).toEqual([`${BOOK_PATH}c.vcf`]);
    expect(names(result)).toEqual(['Alan Turing', 'Grace Hopper']);
  });

  test('a vCard deleted between listing and multiget is left out', async () => {
    const realFetch = server.fetch.getMockImplementation();
    server.fetch.mockImplementation(async (url, init) => {
      if (init.method === 'REPORT') server.contacts.delete('a.vcf');
      return realFetch(url, init);
    });
    const result = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(names(result)).toEqual(['Alan Turing']);
  });

  test('two logins never share cached vCards, even for the same address book URL', async () => {
    await fetchVCardsCached(server.client, { url: BOOK_URL });
    const other = makeServer();
    other.contacts.set('a.vcf', { etag: 'a1', name: 'Someone Else' });

    const result = await fetchVCardsCached(other.client, { url: BOOK_URL });
    expect(names(result)).toEqual(['Someone Else']);
    expect(other.multigetHrefs()).toEqual([`${BOOK_PATH}a.vcf`]);
  });

  test('callers get copies: annotating a result does not change the cache', async () => {
    const first = await fetchVCardsCached(server.client, { url: BOOK_URL });
    first[0]._addressbookName = 'annotated';
    const second = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(second[0]._addressbookName).toBeUndefined();
  });

  test('without ETags in the listing it falls back to client.fetchVCards', async () => {
    server.withEtags = false;
    const spy = jest.spyOn(server.client, 'fetchVCards').mockResolvedValue([{ url: `${BOOK_URL}a.vcf`, data: 'x' }]);
    const result = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(spy).toHaveBeenCalledWith({ addressBook: { url: BOOK_URL } });
    expect(result).toEqual([{ url: `${BOOK_URL}a.vcf`, data: 'x' }]);
  });

  test('when the PROPFIND listing fails it falls back to client.fetchVCards', async () => {
    const realFetch = server.fetch.getMockImplementation();
    server.fetch.mockImplementation(async (url, init) => {
      if (init.method === 'PROPFIND') return new Response('Forbidden', { status: 403, statusText: 'Forbidden' });
      return realFetch(url, init);
    });
    jest.spyOn(server.client, 'propfind').mockRejectedValue(new Error('PROPFIND refused'));
    const spy = jest.spyOn(server.client, 'fetchVCards').mockResolvedValue([{ url: `${BOOK_URL}a.vcf`, data: 'x' }]);
    const result = await fetchVCardsCached(server.client, { url: BOOK_URL });
    expect(spy).toHaveBeenCalledWith({ addressBook: { url: BOOK_URL } });
    expect(result).toEqual([{ url: `${BOOK_URL}a.vcf`, data: 'x' }]);
  });
});

describe('list_contacts', () => {
  test('lists the address book through the cache: the second call sends no multiget', async () => {
    const first = await listContacts.handler({ addressbook_url: BOOK_URL });
    expect(first.content[0].text).toContain('Ada Lovelace');
    expect(server.reports()).toHaveLength(1);

    server.reset();
    const second = await listContacts.handler({ addressbook_url: BOOK_URL });
    expect(second.content[0].text).toBe(first.content[0].text);
    expect(server.reports()).toHaveLength(0);
  });
});
