import { describe, test, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import http from 'node:http';

// A tool URL decides where tsdav sends the login. These tests stand up real
// HTTP listeners — the configured DAV server and a foreign one — and drive the
// real client manager, real tsdav clients and the real tools, so "refused"
// means the foreign listener never saw a request, not that a mock was skipped.

const { RequestOrigins, RequestOriginError, activateRequestOrigins, requestUrlProblem } =
  await import('../src/request-origins.js');
const { tsdavManager } = await import('../src/tsdav-client.js');
const { tools } = await import('../src/tools/index.js');
const { multiGetObjects } = await import('../src/tools/shared/multiget.js');

const multistatus = (responses) =>
  '<?xml version="1.0"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" ' +
  `xmlns:card="urn:ietf:params:xml:ns:carddav">${responses}</d:multistatus>`;

const propResponse = (href, prop) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop>` +
  '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';

/**
 * A minimal CalDAV/CardDAV server: enough for tsdav to log in and list
 * collections. Every request is recorded.
 *
 * @param {object} [options]
 * @param {(req) => string|undefined} [options.redirect] - Location to send
 *   for /.well-known/ requests
 * @param {() => string} [options.extraCalendarHref] - an absolute href for a
 *   calendar on another origin, listed next to the server's own
 */
function davServer(options = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      const path = new URL(req.url, 'http://local').pathname;
      if (path.startsWith('/.well-known/')) {
        const location = options.redirect?.(req);
        if (location) {
          res.writeHead(301, { location });
        } else {
          res.writeHead(404);
        }
        return res.end();
      }
      const xml = (status, responses) => {
        res.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(multistatus(responses));
      };
      if (body.includes('current-user-principal')) {
        return xml(207, propResponse(path,
          '<d:current-user-principal><d:href>/principals/user/</d:href></d:current-user-principal>'));
      }
      if (body.includes('calendar-home-set')) {
        return xml(207, propResponse(path,
          '<cal:calendar-home-set><d:href>/calendars/user/</d:href></cal:calendar-home-set>'));
      }
      if (body.includes('addressbook-home-set')) {
        return xml(207, propResponse(path,
          '<card:addressbook-home-set><d:href>/addressbooks/user/</d:href></card:addressbook-home-set>'));
      }
      if (req.method === 'PROPFIND' && path === '/calendars/user/') {
        const calendar = (href, name) => propResponse(href,
          `<d:displayname>${name}</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>` +
          '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>');
        const extra = options.extraCalendarHref?.();
        return xml(207, calendar('/calendars/user/work/', 'Work') + (extra ? calendar(extra, 'Elsewhere') : ''));
      }
      if (req.method === 'PROPFIND' && path === '/addressbooks/user/') {
        return xml(207, propResponse('/addressbooks/user/contacts/',
          '<d:displayname>Contacts</d:displayname><d:resourcetype><d:collection/><card:addressbook/></d:resourcetype>'));
      }
      // Anything else: an empty multistatus for reads, success for writes.
      if (req.method === 'PROPFIND' || req.method === 'REPORT') return xml(207, '');
      res.writeHead(req.method === 'PUT' ? 201 : 204, { etag: '"1"' });
      res.end();
    });
  });
  return {
    hits,
    async start() {
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      this.origin = `http://127.0.0.1:${server.address().port}`;
      return this;
    },
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}

const login = (server) => tsdavManager.initialize({
  serverUrl: `${server.origin}/`,
  authMethod: 'Basic',
  username: 'user',
  password: 'secret',
});

// ---------------------------------------------------------------------------

describe('before any login', () => {
  test('no URL is accepted, not even one that looks right', () => {
    expect(requestUrlProblem('https://dav.example.com/calendars/user/work/'))
      .toMatch(/not connected to a DAV server yet/);
  });
});

describe('the policy', () => {
  const policy = () => {
    const origins = new RequestOrigins({
      serverUrl: 'https://dav.example.com/dav/',
      authUrls: ['https://accounts.example.com/o/oauth2/token'],
    });
    origins.endDiscovery();
    return origins;
  };

  test('accepts any path on the configured origin', () => {
    expect(policy().problem('https://dav.example.com/calendars/user/work/x.ics')).toBeNull();
    expect(policy().problem('https://dav.example.com:443/other/')).toBeNull();
  });

  test('refuses another host, another port and another scheme, naming the allowed origin', () => {
    for (const url of ['https://attacker.example/x', 'https://dav.example.com:8443/x', 'https://dav.example.com.attacker.example/x']) {
      const problem = policy().problem(url);
      expect(problem).toMatch(/is not the configured DAV server/);
      expect(problem).toContain('https://dav.example.com');
    }
  });

  test('refuses a downgrade from https to http, even on the same host', () => {
    expect(policy().problem('http://dav.example.com/calendars/')).toMatch(/plain http.*configured over https/);
  });

  test('never trusts an http origin the server names when it is configured over https', () => {
    const origins = policy();
    expect(origins.trust('http://p01-caldav.example.com/calendars/')).toBe(false);
    expect(origins.problem('http://p01-caldav.example.com/calendars/')).toMatch(/plain http/);
  });

  test('refuses user info in a URL', () => {
    expect(policy().problem('https://user:pw@dav.example.com/calendars/')).toMatch(/user name or password/);
    expect(policy().trust('https://user:pw@other.example.com/')).toBe(false);
  });

  test('refuses non-http schemes', () => {
    expect(policy().problem('file:///etc/passwd')).toMatch(/not an http\(s\) URL/);
  });

  test('accepts an origin the server named', () => {
    const origins = policy();
    origins.trust('https://p42-caldav.example.com:443/123/calendars/');
    expect(origins.problem('https://p42-caldav.example.com/123/calendars/work/')).toBeNull();
  });

  test('the OAuth token endpoint is reachable by the client but never a tool argument', () => {
    const url = 'https://accounts.example.com/anything';
    expect(policy().problem(url)).toMatch(/is not the configured DAV server/);
    expect(policy().problem(url, { transport: true })).toBeNull();
  });

  test('a server URL with user info or a non-http scheme is a configuration error', () => {
    expect(() => new RequestOrigins({ serverUrl: 'https://u:p@dav.example.com/' }))
      .toThrow(expect.objectContaining({ name: 'ConfigurationError' }));
    expect(() => new RequestOrigins({ serverUrl: 'ftp://dav.example.com/' }))
      .toThrow(expect.objectContaining({ name: 'ConfigurationError' }));
  });

  test('its fetch refuses before calling the network', async () => {
    let calls = 0;
    const guarded = policy().fetch(async () => { calls += 1; return new Response(''); });
    await expect(guarded('https://attacker.example/x')).rejects.toBeInstanceOf(RequestOriginError);
    await expect(guarded(new URL('https://attacker.example/x'))).rejects.toBeInstanceOf(RequestOriginError);
    await expect(guarded(new Request('https://attacker.example/x'))).rejects.toBeInstanceOf(RequestOriginError);
    expect(calls).toBe(0);
  });

  test('during login it follows the server\'s redirect, after login it learns nothing', async () => {
    const origins = new RequestOrigins({ serverUrl: 'https://dav.example.com/' });
    const redirect = (location) => async () => new Response('', { status: 301, headers: { location } });

    await origins.fetch(redirect('https://root.example.com/dav/'))('https://dav.example.com/.well-known/caldav');
    expect(origins.problem('https://root.example.com/dav/principals/')).toBeNull();

    // a downgrade is not followed, not even during login
    await origins.fetch(redirect('http://plain.example.com/'))('https://dav.example.com/.well-known/carddav');
    expect(origins.problem('http://plain.example.com/')).not.toBeNull();

    origins.endDiscovery();
    await origins.fetch(redirect('https://later.example.com/'))('https://dav.example.com/x');
    expect(origins.problem('https://later.example.com/')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('against real listeners', () => {
  let dav;
  let attacker;

  beforeAll(async () => {
    dav = await davServer().start();
    attacker = await davServer().start();
    await login(dav);
  });

  afterAll(async () => {
    await dav.stop();
    await attacker.stop();
  });

  beforeEach(() => {
    attacker.hits.length = 0;
  });

  // Values for the non-URL parameters that make each call valid, so a refusal
  // can only come from the URL. A new tool with a URL parameter fails the
  // coverage test below until it is listed here.
  const FIXTURES = {
    list_events: {},
    create_event: { summary: 's', start_date: '2026-10-01T10:00:00Z', end_date: '2026-10-01T11:00:00Z' },
    update_event: { event_etag: '"1"', fields: { SUMMARY: 's' } },
    update_event_raw: { event_etag: '"1"', updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
    delete_event: { event_etag: '"1"' },
    calendar_query: { summary_filter: 's' },
    freebusy_query: { time_range_start: '2026-10-01T00:00:00Z', time_range_end: '2026-10-02T00:00:00Z' },
    update_calendar: { display_name: 'n' },
    delete_calendar: {},
    calendar_multi_get: {},
    list_contacts: {},
    create_contact: { full_name: 'n' },
    update_contact: { vcard_etag: '"1"', fields: { FN: 'n' } },
    update_contact_raw: { vcard_etag: '"1"', updated_vcard_data: 'BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n' },
    delete_contact: { vcard_etag: '"1"' },
    addressbook_query: { name_filter: 'n' },
    addressbook_multi_get: {},
    list_todos: {},
    create_todo: { summary: 's' },
    update_todo: { todo_etag: '"1"', fields: { SUMMARY: 's' } },
    update_todo_raw: { todo_etag: '"1"', updated_ical_data: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' },
    delete_todo: { todo_etag: '"1"' },
    todo_query: { summary_filter: 's' },
    todo_multi_get: {},
  };

  const urlParams = (tool) => Object.entries(tool.inputSchema?.properties ?? {})
    .filter(([name]) => /url/i.test(name))
    .map(([name, schema]) => ({ name, array: schema.type === 'array' }));

  const urlTools = tools.filter(tool => urlParams(tool).length > 0);

  // A plausible URL on a given origin for a parameter
  const urlFor = (origin, name) => {
    if (/addressbook/.test(name)) return `${origin}/addressbooks/user/contacts/`;
    if (/vcard|contact/.test(name)) return `${origin}/addressbooks/user/contacts/c.vcf`;
    if (/calendar/.test(name)) return `${origin}/calendars/user/work/`;
    return `${origin}/calendars/user/work/item.ics`;
  };

  const argsFor = (tool, origin) => {
    const args = { ...FIXTURES[tool.name] };
    for (const { name, array } of urlParams(tool)) {
      args[name] = array ? [urlFor(origin, name)] : urlFor(origin, name);
    }
    return args;
  };

  const cases = urlTools.flatMap(tool => urlParams(tool).map(param => [tool.name, param.name, tool, param]));

  test('every tool that takes a URL is covered', () => {
    // 24 of the 27 tools take a URL; list_calendars, list_addressbooks and
    // make_calendar do not.
    expect(urlTools.length).toBeGreaterThanOrEqual(24);
    for (const tool of urlTools) expect(FIXTURES).toHaveProperty([tool.name]);
  });

  test.each(cases)('%s refuses a foreign %s before any request', async (_toolName, _param, tool, param) => {
    const args = argsFor(tool, dav.origin);
    const evil = urlFor(attacker.origin, param.name);
    // in an array the foreign URL hides behind a good one
    args[param.name] = param.array ? [urlFor(dav.origin, param.name), evil] : evil;
    const davHitsBefore = dav.hits.length;

    const error = await tool.handler(args).then(() => null, e => e);

    expect(error).not.toBeNull();
    expect(error.message).toMatch(/is not the configured DAV server/);
    expect(error.message).toContain(dav.origin);
    expect(attacker.hits).toHaveLength(0);
    // refused while validating: no request at all, not even to the real server
    expect(dav.hits.length).toBe(davHitsBefore);
  });

  test.each(urlTools.map(tool => [tool.name, tool]))('%s still works with URLs on the configured server', async (_name, tool) => {
    const davHitsBefore = dav.hits.length;
    const error = await tool.handler(argsFor(tool, dav.origin)).then(() => null, e => e);
    // the stub server cannot satisfy every tool, but the call got past
    // validation and reached it
    if (error) expect(error.message).not.toMatch(/Validation failed|Request refused/);
    expect(dav.hits.length).toBeGreaterThan(davHitsBefore);
    expect(attacker.hits).toHaveLength(0);
  });

  test('an http downgrade on the same host and port is refused for an https server', () => {
    // covered by the policy tests; here the listener is plain http, so the
    // other direction must still be refused: another scheme is another origin
    const problem = requestUrlProblem(`${dav.origin.replace('http:', 'https:')}/calendars/user/work/`);
    expect(problem).toMatch(/is not the configured DAV server/);
  });

  describe('a request that bypasses the tool schemas still cannot leave the server', () => {
    const evil = () => `${attacker.origin}/calendars/user/work/`;
    const attempts = {
      davRequest: (c) => c.davRequest({ url: evil(), init: { method: 'PROPFIND', namespace: 'd', body: { propfind: {} } } }),
      propfind: (c) => c.propfind({ url: evil(), props: { 'd:displayname': {} }, depth: '0' }),
      deleteObject: (c) => c.deleteObject({ url: evil() }),
      createObject: (c) => c.createObject({ url: `${evil()}x.ics`, data: 'x' }),
      updateObject: (c) => c.updateObject({ url: `${evil()}x.ics`, data: 'x', etag: '"1"' }),
      makeCalendar: (c) => c.makeCalendar({ url: evil(), props: { displayname: 'x' } }),
      fetchCalendarObjects: (c) => c.fetchCalendarObjects({ calendar: { url: evil() } }),
      deleteCalendarObject: (c) => c.deleteCalendarObject({ calendarObject: { url: `${evil()}x.ics`, etag: '"1"' } }),
      fetchVCards: (c) => tsdavManager.getCardDavClient().fetchVCards({ addressBook: { url: evil() } }),
      multiGetObjects: (c) => multiGetObjects(c, { kind: 'calendar', collectionUrl: evil(), objectUrls: [`${evil()}x.ics`] }),
      // a fetch handed to a single call does not replace the check
      'propfind with its own fetch': (c) => c.propfind({ url: evil(), props: {}, depth: '0', fetch: globalThis.fetch }),
      'davRequest with its own fetch': (c) => c.davRequest({ url: evil(), init: { method: 'GET' }, fetch: globalThis.fetch }),
      'fetchCalendars with its own fetch': (c) => c.fetchCalendars({
        account: { ...c.account, rootUrl: evil(), homeUrl: evil() }, fetch: globalThis.fetch,
      }),
    };

    test.each(Object.entries(attempts))('%s', async (_name, attempt) => {
      const error = await attempt(tsdavManager.getCalDavClient()).then(() => null, e => e);
      expect(error).toBeInstanceOf(RequestOriginError);
      expect(attacker.hits).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------

describe('origins the server names during login and listing', () => {
  let entry;
  let root;
  let elsewhere;

  beforeAll(async () => {
    // entry redirects discovery to root (another port, so another origin), as
    // servers move a client from the configured URL to their DAV root; root
    // lists one calendar on a third origin, as iCloud lists calendars on a
    // per-account host
    elsewhere = await davServer().start();
    root = await davServer({ extraCalendarHref: () => `${elsewhere.origin}/calendars/user/shared/` }).start();
    entry = await davServer({ redirect: () => `${root.origin}/` }).start();
    await login(entry);
  });

  afterAll(async () => {
    await entry.stop();
    await root.stop();
    await elsewhere.stop();
  });

  test('the origin discovery redirected to is accepted, and used', async () => {
    expect(requestUrlProblem(`${root.origin}/calendars/user/work/`)).toBeNull();
    expect(root.hits.some(hit => hit.url === '/principals/user/')).toBe(true);
  });

  test('a calendar the server lists on another origin becomes reachable once listed', async () => {
    const shared = `${elsewhere.origin}/calendars/user/shared/`;
    expect(requestUrlProblem(shared)).toMatch(/is not the configured DAV server/);

    const listCalendars = tools.find(tool => tool.name === 'list_calendars');
    await listCalendars.handler({});

    expect(requestUrlProblem(shared)).toBeNull();
    const listEvents = tools.find(tool => tool.name === 'list_events');
    await listEvents.handler({ calendar_url: shared }).catch(() => {});
    expect(elsewhere.hits.length).toBeGreaterThan(0);
  });
});

describe('a failed login', () => {
  test('keeps the previous clients and their policy', async () => {
    const good = await davServer().start();
    await login(good);
    const client = tsdavManager.getCalDavClient();

    await expect(tsdavManager.initialize({ serverUrl: 'not a url', authMethod: 'Basic', username: 'u', password: 'p' }))
      .rejects.toThrow();

    expect(tsdavManager.getCalDavClient()).toBe(client);
    expect(requestUrlProblem(`${good.origin}/calendars/user/work/`)).toBeNull();
    await good.stop();
    activateRequestOrigins(null);
  });
});
