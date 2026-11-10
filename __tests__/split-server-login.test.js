import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';

// An iCloud-like split server: the server serves one account type's home
// and answers the other's home-set request with the property EMPTY — the
// shape caldav.icloud.com and contacts.icloud.com each present.
const { tsdavManager } = await import('../src/tsdav-client.js');
const { requestUrlProblem } = await import('../src/request-origins.js');
const { CardDAVError, CalDAVError } = await import('../src/error-handler.js');
const { tools } = await import('../src/tools/index.js');

const multistatus = (responses) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  `xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`;

const propResponse = (href, prop) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

// mode 'caldav': serves a calendar home, addressbook-home-set empty (caldav.icloud.com).
// mode 'carddav': the mirror (contacts.icloud.com).
function splitServer(mode) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://local').pathname;
      const xml = (status, responses) => {
        res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(responses));
      };
      if (path.startsWith('/.well-known/')) { res.writeHead(404); return res.end(); }
      if (body.includes('current-user-principal')) {
        return xml(207, propResponse(path,
          '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
      }
      if (body.includes('calendar-home-set')) {
        const prop = mode === 'caldav'
          ? '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'
          : '<cal:calendar-home-set/>';
        return xml(207, propResponse(path, prop));
      }
      if (body.includes('addressbook-home-set')) {
        const prop = mode === 'carddav'
          ? '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'
          : '<card:addressbook-home-set/>';
        return xml(207, propResponse(path, prop));
      }
      if (req.method === 'PROPFIND' && path === '/calendars/user/') {
        return xml(207, propResponse('/calendars/user/work/',
          '<d:displayname>Work</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>' +
          '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>'));
      }
      if (req.method === 'PROPFIND' && path === '/addressbooks/user/') {
        return xml(207, propResponse('/addressbooks/user/book/',
          '<d:displayname>Book</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'));
      }
      if (req.method === 'PROPFIND' || req.method === 'REPORT') return xml(207, '');
      res.writeHead(req.method === 'PUT' ? 201 : 204, { etag: '"1"' });
      res.end();
    });
  });
  return {
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

describe('password login against a CalDAV-only server (iCloud caldav.icloud.com shape)', () => {
  let server;
  beforeAll(async () => {
    server = await splitServer('caldav').start();
    await tsdavManager.initialize({
      serverUrl: `${server.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret',
    });
  });
  afterAll(() => server.stop());

  test('initialize resolves with the CalDAV half and a null CardDAV half', () => {
    expect(tsdavManager.calDavClient).toBeTruthy();
    expect(tsdavManager.cardDavClient).toBeNull();
  });

  test('the working half still lists calendars', async () => {
    const calendars = await tsdavManager.calDavClient.fetchCalendars();
    expect(calendars.map(c => c.displayName)).toEqual(['Work']);
  });

  test('getCardDavClient throws the typed error', () => {
    expect(() => tsdavManager.getCardDavClient()).toThrow(CardDAVError);
    expect(() => tsdavManager.getCardDavClient()).toThrow(/not initialized/i);
  });

  test('a contacts tool fails cleanly per call', async () => {
    const listAddressbooks = tools.find(t => t.name === 'list_addressbooks');
    await expect(listAddressbooks.handler({})).rejects.toThrow(/not initialized/i);
  });

  test('request origins stay scoped to the working half', () => {
    expect(requestUrlProblem(`${server.origin}/calendars/user/work/`)).toBeNull();
    expect(requestUrlProblem('https://foreign.example.com/x.ics')).toMatch(/outside/);
  });
});

describe('password login against a CardDAV-only server (iCloud contacts.icloud.com shape)', () => {
  let server;
  beforeAll(async () => {
    server = await splitServer('carddav').start();
    await tsdavManager.initialize({
      serverUrl: `${server.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret',
    });
  });
  afterAll(() => server.stop());

  test('initialize resolves with the CardDAV half and a null CalDAV half', () => {
    expect(tsdavManager.cardDavClient).toBeTruthy();
    expect(tsdavManager.calDavClient).toBeNull();
  });

  test('the working half still lists address books', async () => {
    const books = await tsdavManager.cardDavClient.fetchAddressBooks();
    expect(books.map(b => b.displayName)).toEqual(['Book']);
  });

  test('getCalDavClient throws the typed error', () => {
    expect(() => tsdavManager.getCalDavClient()).toThrow(CalDAVError);
  });
});

describe('both halves failing is still a failed login', () => {
  test('initialize rejects when every login fails', async () => {
    const dead = http.createServer((req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="dav"' });
      res.end('Unauthorized');
    });
    await new Promise(resolve => dead.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${dead.address().port}/`;
    const error = await tsdavManager.initialize({
      serverUrl: url, authMethod: 'Basic', username: 'user', password: 'wrong',
    }).then(() => null, e => e);
    await new Promise(resolve => dead.close(resolve));
    expect(error).toBeTruthy();
    expect(error.name).toBe('AuthenticationError');
  });
});
