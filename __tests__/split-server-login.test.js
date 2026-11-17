import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';

// Servers that serve only one half (CalDAV or CardDAV) at the configured URL
// (#152): iCloud answers the other half's home-set request with the property
// EMPTY (caldav.icloud.com and contacts.icloud.com each), all-inkl answers it
// with a 404. Such a half is left out; any other failure of a half (refused,
// a server fault, ...) still fails the login, so it is retried.
const { tsdavManager } = await import('../src/tsdav-client.js');
const { requestUrlProblem } = await import('../src/request-origins.js');
const { CardDAVError, CalDAVError, MCP_ERROR_CODES, codeForHttpStatus } = await import('../src/error-handler.js');
const { tools } = await import('../src/tools/index.js');

const multistatus = (responses) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  `xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`;

const propResponse = (href, prop) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

const HOMES = {
  calendar: ['calendar-home-set', 'cal', '/calendars/user/'],
  addressbook: ['addressbook-home-set', 'card', '/addressbooks/user/'],
};

// Each home is 'served', 'empty' (the property comes back without an href,
// the iCloud shape), 'drop' (the connection is cut) or an HTTP status the home-set request is answered with
// (404 is the all-inkl shape). Settable while the server runs.
function davServer(homes) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const path = new URL(req.url, 'http://local').pathname;
      const xml = (status, responses) => {
        res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(responses));
      };
      if (path === '/token') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'token', expires_in: 3600, token_type: 'Bearer' }));
      }
      if (path.startsWith('/.well-known/')) { res.writeHead(404); return res.end(); }
      if (body.includes('current-user-principal')) {
        return xml(207, propResponse(path,
          '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
      }
      for (const [kind, [property, ns, href]] of Object.entries(HOMES)) {
        if (!body.includes(property)) continue;
        const home = server.homes[kind];
        if (home === 'drop') return req.socket.destroy();
        if (Number.isInteger(home)) { res.writeHead(home); return res.end(); }
        return xml(207, propResponse(path, home === 'served'
          ? `<${ns}:${property}><d:href>${href}</d:href></${ns}:${property}>`
          : `<${ns}:${property}/>`));
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
  server.homes = homes;
  return {
    server,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

const passwordLogin = (dav) => tsdavManager.initialize({
  serverUrl: `${dav.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret',
});

const oauthLogin = (dav) => tsdavManager.initialize({
  serverUrl: `${dav.origin}/`, authMethod: 'OAuth', username: 'alex@example.com',
  clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh', tokenUrl: `${dav.origin}/token`,
});

const failedLogin = (dav) => passwordLogin(dav).then(() => null, e => e);

describe('password login against a CalDAV-only server (iCloud caldav.icloud.com shape: empty home set)', () => {
  let dav;
  beforeAll(async () => {
    dav = await davServer({ calendar: 'served', addressbook: 'empty' }).start();
    await passwordLogin(dav);
  });
  afterAll(() => dav.stop());

  test('initialize resolves with the CalDAV half and a null CardDAV half', () => {
    expect(tsdavManager.calDavClient).toBeTruthy();
    expect(tsdavManager.cardDavClient).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav']);
  });

  test('the working half still lists calendars', async () => {
    const calendars = await tsdavManager.calDavClient.fetchCalendars();
    expect(calendars.map(c => c.displayName)).toEqual(['Work']);
  });

  test('getCardDavClient says the server does not serve CardDAV, why, and where the URL is set', () => {
    let error;
    try { tsdavManager.getCardDavClient(); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(CardDAVError);
    expect(error.message).toContain(`${dav.origin}/ does not serve CardDAV`);
    expect(error.message).toContain('contact tools are not available');
    expect(error.message).toContain('cannot find homeUrl');
    expect(error.message).toContain('CALDAV_SERVER_URL');
    expect(error.message).not.toMatch(/not initialized/i);
    expect(error.details).toMatchObject({ accountType: 'carddav', serverUrl: `${dav.origin}/` });
  });

  test('a contacts tool fails per call with that typed error', async () => {
    const listAddressbooks = tools.find(t => t.name === 'list_addressbooks');
    await expect(listAddressbooks.handler({})).rejects.toThrow(CardDAVError);
    await expect(listAddressbooks.handler({})).rejects.toThrow(/does not serve CardDAV/);
  });

  test('request origins stay scoped to the working half', () => {
    expect(requestUrlProblem(`${dav.origin}/calendars/user/work/`)).toBeNull();
    expect(requestUrlProblem('https://foreign.example.com/x.ics')).toMatch(/outside/);
  });
});

describe('password login against a CalDAV-only server (all-inkl shape: 404 for the address book home)', () => {
  let dav;
  beforeAll(async () => {
    dav = await davServer({ calendar: 'served', addressbook: 404 }).start();
    await passwordLogin(dav);
  });
  afterAll(() => dav.stop());

  test('initialize resolves with the CalDAV half only', () => {
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav']);
  });

  test('the CardDAV error names the 404', () => {
    expect(() => tsdavManager.getCardDavClient()).toThrow(CardDAVError);
    expect(() => tsdavManager.getCardDavClient()).toThrow(/does not serve CardDAV.*the server answered 404/);
  });
});

describe('password login against a CardDAV-only server (iCloud contacts.icloud.com shape)', () => {
  let dav;
  beforeAll(async () => {
    dav = await davServer({ calendar: 'empty', addressbook: 'served' }).start();
    await passwordLogin(dav);
  });
  afterAll(() => dav.stop());

  test('initialize resolves with the CardDAV half and a null CalDAV half', () => {
    expect(tsdavManager.cardDavClient).toBeTruthy();
    expect(tsdavManager.calDavClient).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['carddav']);
  });

  test('the working half still lists address books', async () => {
    const books = await tsdavManager.cardDavClient.fetchAddressBooks();
    expect(books.map(b => b.displayName)).toEqual(['Book']);
  });

  test('getCalDavClient throws the typed error', () => {
    expect(() => tsdavManager.getCalDavClient()).toThrow(CalDAVError);
    expect(() => tsdavManager.getCalDavClient()).toThrow(/does not serve CalDAV, so the calendar and task tools/);
  });
});

// A half that fails for a reason that may be gone on the next try must not
// leave the server running without that half for good: the login fails, as
// it did before split servers were tolerated, and stdio retries it on the
// next tool call.
describe('a half failing for another reason still fails the login', () => {
  let dav;
  beforeAll(async () => { dav = await davServer({ calendar: 'served', addressbook: 'served' }).start(); });
  afterAll(() => dav.stop());

  // a server fault, a rate limit, forbidden
  test.each([503, 429, 403])('CardDAV home answered %i: initialize rejects', async (status) => {
    dav.server.homes = { calendar: 'served', addressbook: status };
    const error = await failedLogin(dav);
    expect(error).toBeTruthy();
    expect(error.code).not.toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain(`the server answered ${status}`);
  });

  // Discovery has been answered by then, so tsdav's "fetch failed" alone
  // read like a server without CardDAV.
  test('the connection cut on the CardDAV home request: a network error', async () => {
    dav.server.homes = { calendar: 'served', addressbook: 'drop' };
    const error = await failedLogin(dav);
    expect(error).toBeTruthy();
    expect(error.code).toBe(MCP_ERROR_CODES.NETWORK_ERROR);
    expect(error.message).toContain('fetch failed');
    expect(error.message).not.toContain('does not lead to a CalDAV/CardDAV server');
  });

  test('CardDAV refused (401) while CalDAV logs in: an authentication error', async () => {
    dav.server.homes = { calendar: 'served', addressbook: 401 };
    const error = await failedLogin(dav);
    expect(error.name).toBe('AuthenticationError');
  });

  test('a retry once the fault is gone logs in both halves', async () => {
    dav.server.homes = { calendar: 'served', addressbook: 503 };
    expect(await failedLogin(dav)).toBeTruthy();
    dav.server.homes = { calendar: 'served', addressbook: 'served' };
    await passwordLogin(dav);
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav', 'carddav']);
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

  test('a server serving neither half is the CalDAV configuration error', async () => {
    const dav = await davServer({ calendar: 'empty', addressbook: 404 }).start();
    const error = await failedLogin(dav);
    await dav.stop();
    expect(error.code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain('cannot find homeUrl');
    expect(error.message).toContain('does not lead to a CalDAV/CardDAV server');
  });
});

// Google serves no CardDAV at its CalDAV URL. The CardDAV half used to stay
// in place without an account, and contact tools failed inside tsdav ("no
// account for fetchAddressBooks"); now it is left out like any unserved half.
describe('OAuth login against a server without CardDAV (Google shape)', () => {
  let dav;
  beforeAll(async () => {
    dav = await davServer({ calendar: 'served', addressbook: 'empty' }).start();
    await oauthLogin(dav);
  });
  afterAll(() => dav.stop());

  test('the CardDAV half is null and not reported as available', () => {
    expect(tsdavManager.calDavClient).toBeTruthy();
    expect(tsdavManager.cardDavClient).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav']);
  });

  test('a contacts tool fails with the typed error naming the GOOGLE_ settings', async () => {
    const listAddressbooks = tools.find(t => t.name === 'list_addressbooks');
    const error = await listAddressbooks.handler({}).then(() => null, e => e);
    expect(error).toBeInstanceOf(CardDAVError);
    expect(error.message).toContain('does not serve CardDAV');
    expect(error.message).toContain('GOOGLE_SERVER_URL');
  });

  // Under OAuth the CardDAV half stays optional whatever its login fails
  // with, as it always was: Google's answer to it is not known in advance.
  test('a CardDAV half refused with 403 is left out, the server starts with CalDAV', async () => {
    dav.server.homes = { calendar: 'served', addressbook: 403 };
    await oauthLogin(dav);
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav']);
    expect(() => tsdavManager.getCardDavClient()).toThrow(/does not serve CardDAV.*the server answered 403/);
  });

  // The CalDAV half under OAuth is what the setup is for: as before split
  // servers were tolerated, any failure of it fails the login.
  test('a CalDAV half the server does not serve fails the login', async () => {
    dav.server.homes = { calendar: 'empty', addressbook: 'served' };
    const error = await oauthLogin(dav).then(() => null, e => e);
    expect(error).toBeTruthy();
    expect(error.code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain('cannot find homeUrl');
  });
});

// tsdav tries the configured URL and then the server root, and reports only
// the last answer: a 429 on /dav/ came back as the root's 405, which reads
// like a server without CardDAV.
describe('a fault masked by a later answer still fails the login', () => {
  test('CardDAV principal on /dav/ answered 429, server root 405: a rate limit, not a missing CardDAV', async () => {
    let carddav = false;
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const path = new URL(req.url, 'http://local').pathname;
        const xml = (prop) => {
          res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
          res.end(multistatus(propResponse(path, prop)));
        };
        if (path === '/.well-known/carddav') carddav = true;
        if (path.startsWith('/.well-known/')) { res.writeHead(404); return res.end(); }
        if (path === '/') { res.writeHead(405); return res.end(); }
        if (body.includes('current-user-principal')) {
          if (carddav) { res.writeHead(429); return res.end(); }
          return xml('<d:current-user-principal><d:href>/dav/principals/user/</d:href></d:current-user-principal>');
        }
        if (body.includes('calendar-home-set')) {
          return xml('<cal:calendar-home-set><d:href>/dav/calendars/user/</d:href></cal:calendar-home-set>');
        }
        res.writeHead(207, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(''));
      });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const error = await tsdavManager.initialize({
      serverUrl: `${origin}/dav/`, authMethod: 'Basic', username: 'user', password: 'secret',
    }).then(() => null, e => e);
    await new Promise(resolve => server.close(resolve));

    expect(error).toBeTruthy();
    expect(error.code).toBe(codeForHttpStatus(429));
    expect(error.code).not.toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
    expect(error.message).toContain(`failed: ${origin}/dav/ answered 429 (the login then reported:`);
    expect(error.message).not.toContain('does not lead to a CalDAV/CardDAV server');
  });
});

// With any CARDDAV_* set (config.cardDav) the user has said where contacts
// are: a half that fails there fails the login, served or not, instead of
// being left out behind "not available" (#158).
describe('a configured CardDAV endpoint makes both halves required', () => {
  let cal;
  let card;
  beforeAll(async () => {
    cal = await davServer({ calendar: 'served', addressbook: 'empty' }).start();
    card = await davServer({ calendar: 'empty', addressbook: 'served' }).start();
  });
  afterAll(async () => {
    await cal.stop();
    await card.stop();
  });

  const configuredLogin = (calDav, cardDav) => tsdavManager.initialize({
    serverUrl: `${calDav.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret',
    cardDav: { serverUrl: `${cardDav.origin}/`, username: 'user', password: 'secret' },
  }).then(() => null, e => e);

  test('both halves served on their own endpoints: both log in', async () => {
    expect(await configuredLogin(cal, card)).toBeNull();
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav', 'carddav']);
  });

  test('CARDDAV_SERVER_URL at a server that serves no CardDAV fails the login, naming that half', async () => {
    const error = await configuredLogin(cal, cal);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`Login to ${cal.origin}/ failed (CardDAV client)`);
    expect(error.code).toBe(MCP_ERROR_CODES.CONFIGURATION_ERROR);
  });

  test('CALDAV_SERVER_URL at a server that serves no CalDAV fails the login as well', async () => {
    const error = await configuredLogin(card, card);
    expect(error.message).toContain(`Login to ${card.origin}/ failed (CalDAV client)`);
  });

  test('only CARDDAV_PASSWORD set, same URL: an unserved CardDAV half is still fatal', async () => {
    const error = await tsdavManager.initialize({
      serverUrl: `${cal.origin}/`, authMethod: 'Basic', username: 'user', password: 'secret',
      cardDav: { serverUrl: `${cal.origin}/`, username: 'user', password: 'contacts-secret' },
    }).then(() => null, e => e);
    expect(error.message).toContain('(CardDAV client)');
  });

  test('without CARDDAV_* the same server runs with the CalDAV half, and says how to set the other', async () => {
    await passwordLogin(cal);
    expect(tsdavManager.availableAccountTypes()).toEqual(['caldav']);
    expect(() => tsdavManager.getCardDavClient()).toThrow(/set CARDDAV_SERVER_URL to it/);
  });
});
