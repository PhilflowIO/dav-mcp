# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **tsdav-utils 0.7.0** (`@philflow/tsdav-utils`), for its bounded,
  zone-correct occurrence expansion. Its write semantics change too: moving a
  series' DTSTART now moves its overrides with it, and an `EXDATE` or
  `RDATE` given in `update_event`'s fields is the whole list, replacing the
  one stored rather than adding to it (#126 tracks cancelling a single
  occurrence).

### Fixed
- **Free/busy and event queries judge each occurrence as it now stands**
  (#98). A recurring series was expanded from its original dates, and every
  occurrence counted with the series' own STATUS and TRANSP. So a single
  occurrence cancelled (or marked transparent) still showed as busy, one
  moved from the 20th to the 14th was missing from the 14th and still
  reported on the 20th, and an opaque occurrence of a transparent series was
  free. Each occurrence is now taken at its effective time with its own
  STATUS and TRANSP (compared case-insensitively), in `freebusy_query`,
  `calendar_query` and `list_events` alike. An override is a full component:
  one without STATUS of a cancelled series is not cancelled, and blocks time.
- **One definition of "in the range"** (#98). Free/busy counted an
  occurrence that overlaps the window, the event lists one that starts in it
  (end included): a meeting running into the window was busy, yet listed as
  "no occurrence falls inside the queried range". All of them now use the
  CalDAV time-range test (RFC 4791 9.9): it starts before the range ends and
  ends after it starts; one without duration counts when it starts in
  [start, end). A floating time is read on the server's clock throughout.
- **Recurring events are expanded by tsdav-utils** (#98), the reader the
  write side uses, so dav-mcp and the library agree on which occurrences a
  series has. An override replaces the occurrence its RECURRENCE-ID names,
  read in the series' frame by the instant it names: an id written in UTC
  for a series in Europe/Berlin used not to match, and at a DST change a
  local time shown twice is its first pass (RFC 5545 3.3.5; ical.js was up
  to an hour off there). A floating id is read by its digits, a date-time id
  on an all-day series by its date (a Berlin-midnight id for the 13th used
  to cancel the 12th), a date id on a timed series names that day's
  midnight, and a UTC id on a floating series names nothing. An EXDATE
  excludes by instant, a date on a timed series its whole day; a floating
  EXDATE in a zoned series, or a UTC one in a floating series, names
  nothing. A series the library cannot read (a UTC `UNTIL` on a floating
  series, say) is reported incomplete, with the reason, rather than guessed
  at. An all-day occurrence without DTEND or DURATION lasts its day, a timed
  one no time (RFC 5545 3.6.1); a recurring all-day event without an end
  used to block nothing. Times are shown as the library converts them, so a
  time a DST change shows twice reads with the offset of its first pass.
- **THISANDFUTURE and moved overrides** (#98). A `RANGE=THISANDFUTURE`
  override moves every later occurrence by its own move, on its own wall
  clock; one whose RECURRENCE-ID is no occurrence, or an EXDATEd one, is
  ignored like any such override. An override moved into the range from
  anywhere in the series is found from the overrides themselves.
- **Recurring events are expanded from the range, not from their start**
  (#98): from the start of the period that holds the range, for SECONDLY to
  WEEKLY rules with BYDAY, BYMONTH or a BYHOUR/BYMINUTE/BYSECOND that
  expands the rule (BYHOUR on DAILY, BYMINUTE on HOURLY); from a whole
  number of months or years later for MONTHLY and YEARLY rules where every
  month or year surely has an occurrence (a BYMONTHDAY within ±28, an
  ordinal BYDAY within ±4 of a month, BYSETPOS over the weekdays every month
  has, ...); and for a COUNT rule without BY parts. Other rules — a limiting
  BYHOUR (on HOURLY), the 31st, 29 February, a fifth Monday, week 53,
  MONTHLY with BYMONTH — are walked from DTSTART, as ical.js shifts its
  INTERVAL grid where a period is empty. `freebusy_query` used to walk
  every series from its start.
- **No series can stall a tool call** (#98). ical.js tests rule candidates
  one by one without a bound of its own: `FREQ=SECONDLY;BYHOUR=9` from 1950
  took 27 s, fifty `MINUTELY;BYHOUR=10` series 45 s per call, and
  `FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30` never returned. Each tool call now
  has one budget of rule candidates (300 000, at most 100 000 per call into
  the library) and of time (1.5 s of expansion), whichever runs out first;
  each calendar object gets a fair share of both and at least 20 ms, so one
  heavy series cannot leave the others unexpanded. The clock is checked
  before each call into the library, so expansion takes about 1.5 s plus up
  to one call per remaining object: it grows with the number of objects and
  overrides in an answer (20 objects with 4 000 overrides each in range:
  about 10 s), and under machine load a series may come back incomplete
  where it otherwise would not. A year of 100 ordinary series takes about
  1.5 s in all. A walk that needs more than 100 000 candidates is
  incomplete even for a lone series (`FREQ=DAILY;BYMONTHDAY=1,15` from
  1970, which cannot start near the range). ical.js yields a BY list in the
  order it is written (`BYHOUR=17,9`) and the library stops at the first
  candidate past its window, so such rules are read one period further. A
  series that needs more is never reported wrong, only incomplete:
  `freebusy_query`, which used to answer "Nothing blocks this window" for
  it, names it and says its busy time may be missing, and an event list
  says the series could not be expanded fully.
- **Listed events show their STATUS** (e.g. CANCELLED; for a series, the
  occurrence listed), and `freebusy_query`'s event details list exactly the
  occurrences that make up the busy time.

## [4.3.1] - 2026-10-08

### Internal
- **Releases are published to npm from CI with provenance** (#112), via trusted publishing from a `v<version>` tag on `main`.

### Fixed
- **`npx -y dav-mcp` starts on npm 12** (#100). npm 12 refuses git and
  remote-tarball dependencies by default, and dav-mcp installed tsdav
  from a GitHub Release tarball and tsdav-utils from git, so `npx` failed with
  `EALLOWREMOTE` before the server started. Both now come from the npm registry
  as `@philflow/tsdav` 2.4.0 and `@philflow/tsdav-utils` 0.4.1, installed under
  their old names. CI installs and starts the packed package with npm 12
  defaults.
- **Quoted-printable contacts are decoded** (#103). vCard 2.1 cards from
  Outlook and Android exports encode non-ASCII text as
  `ENCODING=QUOTED-PRINTABLE`; they were shown as "Hans M=C3=BCller" and a
  search for "müller" missed them. Such values are now decoded in their
  `CHARSET` (UTF-8, ISO-8859-1, windows-1252, …; a missing or unknown one
  is read as UTF-8, and bytes that are not valid UTF-8 as windows-1252), soft
  line breaks included, for the contact list and the filters alike.
- **vCard 2.1 commas and backslashes are read as text** (#103). Only `\;` is
  an escape in vCard 2.1, but cards were read with 3.0 escaping, so
  `N:Mueller, Jr.;Hans` showed two family names. Quoted-printable text in a
  3.0 or 4.0 card (where some exporters still write it) is read by the same
  2.1 rules once decoded, so `C:=5Cnew` stays `C:\new` there too.
- **`update_contact` writes a vCard 2.1 card back as vCard 3.0** (#103). It
  used to edit the stored 2.1 text: a new value kept the line's
  `ENCODING=QUOTED-PRINTABLE` (and read back altered, or swallowed the next
  line), the other lines stayed encoded, and a card with a bare parameter
  (`TEL;CELL:`) or a soft line break could not be edited at all. The card is
  now edited as it is read and written as the 3.0 card that says the same,
  decoded, which is the version every CardDAV server accepts (sabre/dav,
  i.e. Baïkal and Nextcloud, refuses 2.1). Whitespace inside a `BASE64` or
  `b` value (2.1 lets exporters indent it) is removed when it is written.

## [4.3.0] - 2026-10-07

### Security
- **Requests only go to the configured DAV account**
  ([GHSA-hfg5-7h5r-vgfq](https://github.com/PhilflowIO/dav-mcp/security/advisories/GHSA-hfg5-7h5r-vgfq)).
  Tools that take a calendar, address book, event, todo or contact URL
  accepted a URL on any host, and the DAV login (password or OAuth token) was
  sent along with the request. A URL is now accepted only below the
  configured server URL or below a URL that server named itself while logging
  in or listing the account's collections (for example a per-account host).
  Other hosts, other paths on the same host, plain http for a server
  configured over https, and URLs carrying a user name or password are
  refused before a request is made, with an error naming what is allowed.
  The check runs in the tool parameters and again on every request the DAV
  clients make, including each redirect a server answers with; the OAuth
  token endpoint is only used for token requests. The restriction is scoped to
  the configured path: a server URL that is only the bare host
  (`https://dav.example.com/`) leaves the whole host reachable, so configure
  the DAV path (for example `https://dav.example.com/remote.php/dav/`).

### Added
- **Claude plugin** (`claude-plugin/`, #99). dav-mcp can be installed as a
  Claude Code plugin and listed in the Claude directory: it asks for the server
  URL, username and password (stored in the system credential store), starts
  this package pinned to its exact version, and adds a skill on using the tools
  well. `npm run plugin:sync` writes the pinned version on release.
- **Tool annotations.** Every tool declares a title and whether it only reads,
  or overwrites or deletes data (`readOnlyHint`, `destructiveHint`, …), so
  clients such as Claude can let lookups run and stop changes for approval.
- **Privacy policy** ([PRIVACY.md](PRIVACY.md)), linked from the README and the
  MCP Bundle manifest.

### Changed
- **The tool-call log is off by default** (#88). It used to append every tool
  call, with its full arguments (event titles, attendees, contact data), to
  `/tmp/mcp-tool-calls.jsonl` unless `LOG_TOOL_CALLS=false` was set: readable
  by other local users, never rotated, and on Windows a `C:\tmp` folder.
  Set `LOG_TOOL_CALLS=true` to turn it on. It then writes to
  `$XDG_STATE_HOME/dav-mcp/tool-calls.jsonl` (`~/.local/state/…`, on Windows
  `%LOCALAPPDATA%\dav-mcp\…`) with owner-only permissions, or to
  `TOOL_CALL_LOG_FILE`. **If you ran an earlier version, delete the old log**:
  `/tmp/mcp-tool-calls.jsonl` (on Windows `C:\tmp\mcp-tool-calls.jsonl`) still
  holds the calendar and contact data it recorded.

## [4.2.0] - 2026-10-07

### Fixed
- **Updates to a recurring event or todo reach the series, not one
  occurrence** (#96). A server may store the change to a single occurrence
  before the series itself. `update_event` and `update_todo` then wrote the
  new fields into that occurrence, while the event list showed the series, so
  the update looked lost; `update_todo`'s cleanup (a new due date replacing a
  duration) and its date checks also ran on the occurrence. The update tools,
  the todo list and `todo_query`'s due-date filter now all use the series
  (tsdav-utils 0.4.0).
- **Recurrence rules are written as rules.** `update_event` with
  `fields: { RRULE: 'FREQ=DAILY;COUNT=5' }` stored a garbled line
  (`RRULE:0=F;1=R;2=E;...`) that servers refused with a 500. Rules are now
  checked and written properly, and a rule end can be set together with a
  move to all-day in the same call (`RRULE: 'FREQ=DAILY;UNTIL=2026-10-20'`
  with `start_date: '2026-10-01'`), which used to be refused.
- `freebusy_query` no longer fails with "cannot relate exception to
  exceptions" on a calendar holding several occurrences of a series without
  the series itself (as servers store invitations to single occurrences);
  each occurrence now counts as busy. `update_event`/`update_todo` refuse
  such an object with an error that names the route that works:
  `calendar_multi_get`/`todo_multi_get`, then `update_event_raw`/
  `update_todo_raw`.
- **Dates written through `update_todo` keep their time and zone** (#91).
  `fields.DUE` rejected the iCal form its own description advertised
  (`20261026T180000Z`), and a value with an offset such as
  `2026-10-26T14:00:00-04:00` was stored without its zone — hours off for
  anyone reading it elsewhere. A TZID or all-day marker left on the old value
  produced lines RFC 5545 forbids. The same applied to every date field of
  `update_event` (EXDATE, RECURRENCE-ID) and to `REV` in `update_contact`.
  All date values are now encoded in one place (tsdav-utils 0.3.0): offsets are
  converted to UTC, a bare date (`2026-10-26`) makes an all-day value, and a
  time without a zone keeps the timezone the property already has. The other
  dates of an event or todo (end, due date, excluded dates) follow its start:
  its timezone, and its kind (all-day or timed). Otherwise a time without a zone
  is read in the server timezone, as `create_event` always did.
- `todo_query` finds todos with an all-day due date or one in a named
  timezone; its date filter only matched `DUE:` followed by a UTC time.
- Field names in the `fields` map are case-insensitive, so `due` and `DUE`
  pass the same checks.
- `update_todo` keeps a todo's dates coherent: setting DUE replaces a DURATION
  and the other way round, and a DUE that is not later than DTSTART, or not of
  the same kind (date vs. date-time), is rejected before anything is written.
- `todo_query`, `calendar_query` and `addressbook_query` filter on parsed
  values (#94). A summary, location, name or organization with a parameter
  (`SUMMARY;LANGUAGE=de:`), folded across lines or containing an escaped
  comma now matches; every EMAIL of a contact is searched, not just the
  first; and `name_filter` no longer matches text from other lines (`vcard`
  matched every contact). The filters read exactly what the list shows, so
  an event is always listed with the text it was found by. With a time range,
  `calendar_query` finds a recurring event by any occurrence inside the range
  — one renamed or moved included — and lists the first occurrence that
  matches, with its own title, place and date; summary and location must
  match the same occurrence. Without a range only the series itself is
  searched. A recurring todo is found and listed by its series, not by a
  completed single occurrence. `status_filter` compares
  case-insensitively, and the list shows `STATUS:completed` as COMPLETED.
- Contacts exported with unnamed parameters (vCard 2.1 / Outlook / Android:
  `EMAIL;PREF;INTERNET:`, `TEL;CELL:`) are shown with their name and fields
  and found by `addressbook_query`; they appeared as "Unnamed Contact". A
  one-part name (`N:Cher`) shows as "Cher", not "r h e C", and an
  organization with an empty part reads "Acme, Sales", not "Acme, , Sales".
- When a query result is capped, the earliest events are kept even if they
  carry a timezone; the zone definition's 1970 start date was sorted on
  instead, so the kept events were arbitrary. With a time range, a recurring
  event is sorted by the occurrence it is listed as, not by when the series
  began. A capped contact list says it shows the first contacts by name, not
  "the earliest".
- Range queries over long-running daily or weekly series no longer walk
  every occurrence since the series began: 500 daily series since 2020 are
  listed about five times faster than before.

### Changed
- The default OAuth token endpoint (`GOOGLE_TOKEN_URL`) is Google's current
  `https://oauth2.googleapis.com/token`, the one its OpenID discovery document
  names, instead of the legacy `https://accounts.google.com/o/oauth2/token`.
  Token requests no longer follow redirects. Setting `GOOGLE_TOKEN_URL` still
  overrides the default.
- `create_todo` accepts a bare date for `due_date`, giving a todo due that day;
  before, it became midnight UTC. `create_event`, `create_todo` and the update
  tools now share one date encoder instead of three, and check input against
  the same rules: every write tool accepts `20261026T180000Z`, `20261026` and
  times without seconds (`2026-10-26T18:00`).
- `update_event`: a `start_date`/`end_date` without a zone on an event that has
  a timezone stays in that timezone (18:00 on a Berlin event is 18:00 Berlin);
  before, it was read in the server timezone and stored as UTC. A
  `start_date`/`end_date` pair where one names a zone and the other does not is
  refused, because its order cannot be checked: the zoneless one is read in the
  event's own timezone.

## [4.1.2] - 2026-10-02

### Added
- **One-click install for Claude Desktop** (#87). Releases now carry
  `dav-mcp-<version>.mcpb`, an [MCP Bundle](https://github.com/modelcontextprotocol/mcpb)
  of the stdio server with its production dependencies. Opening it in Claude
  Desktop installs dav-mcp and asks for server URL, username, password (stored
  as a secret) and authentication method — no JSON editing, no Node.js or npx.
  The bundle offers Basic and Digest; OAuth for Google is not part of it.
  `npm test` fails when `manifest.json` disagrees with `package.json`,
  `server.json` or the registered tools; `npm run mcpb:sync` rewrites its
  version and tool list.

## [4.1.1] - 2026-10-02

Security and dependency release. The Docker image of 4.1.0 was built from a
lockfile with known advisories; this one is not. npm installs of 4.1.0 already
resolved fixed versions.

### Security
- **Updated the locked production dependencies with known vulnerabilities**
  (#82). The repository lockfile carried 10 advisories, 7 of them high; fresh
  npm installs already resolved fixed versions. This affected installs from
  the repository lockfile: a git clone, and the Docker image, which is built
  from it. `npm audit --omit=dev` on the lockfile now reports none. One
  advisory affected dav-mcp's HTTP transport: the rate limiter counted all
  IPv4 clients as one, so a single client — even one without a valid token —
  could use up the limit for everyone else. Each IPv4 client now has its own
  limit. The MCP SDK advisory about answers reaching the wrong client did not
  apply: the HTTP server already uses a separate server and transport for
  every request. The other advisories are in code dav-mcp does not call.
- **The HTTP rate limiter gave public addresses the raised limit** (#84).
  Every client address starting with `172.` got the limit meant for local
  and Docker-internal clients, 100 times the normal one, before the bearer
  token was checked — but only 172.16.0.0/12 is private. The raised limit now
  applies to loopback and the private ranges 10.0.0.0/8, 172.16.0.0/12 and
  192.168.0.0/16 exactly, and to no public address. Clients on a 10.x or
  192.168.x network now get the raised limit too; they did not before.

### Fixed
- **Write tools did not return an ETag** (#76). `create_event`,
  `create_todo`, `create_contact` and all `update_*` tools left the ETag out
  of their result, so a second update needed a fetch in between. They now
  return the ETag the server sent, in the form the update and delete tools
  expect, so it can be passed straight to the next call. If the server sends
  none — it may when it changed what was stored — the result says
  "no ETag returned — fetch the object before the next update".
- **The HTTP transport on installs from the repository lockfile on
  Node.js 18** (#82). With the updated lockfile the MCP SDK's HTTP transport
  needs a global that Node.js 18 lacks, and every MCP request would have
  failed with "crypto is not defined". The server now provides it. No
  released version was affected: fresh npm installs on Node.js 18 resolve a
  compatible version, and the Docker image runs Node.js 22.

### Changed
- **The MCP SDK is now 1.31, which rejects oversized input.** Over stdio, a
  message above 10 MB is refused; over HTTP, a JSON-RPC batch of more than
  100 messages is refused. Neither limit existed before. Ordinary tool calls
  are far below both.

### Internal
- CI fails a pull request when a production dependency has a high-severity
  advisory, and now tests the HTTP server end to end on every supported
  Node.js version.

## [4.1.0] - 2026-10-02

Digest authentication, `linux/arm64` images, and a round of fixes to tools
that reported success for writes and deletes the server had refused.

**Check `AUTH_METHOD` before upgrading.** A value dav-mcp does not know now
stops the server at startup instead of silently running Basic, and `oauth` /
`oauth2` now really select OAuth2. Details under Changed and in MIGRATION.md.

### Fixed
- **Tools reported success when the server had refused the write** (#72).
  A create or update the server rejected (403, 412, 405) was reported as done.
  Every write now fails with the server's status and message.
- **`delete_calendar` could not delete a calendar** (#72). The request went
  out without credentials, so the server refused it. `update_calendar` sent
  names containing `&` as invalid XML.
- **`make_calendar` dropped its properties** (#72). Name, description, color,
  timezone and component types were sent under names no server knows, so a
  calendar created as "Team Plan" was named "team-plan". If a live calendar
  already holds the URL, nothing is created and the error names it; if the URL
  is only held by a deleted calendar in the trash, a numbered URL is used.
  A `timezone` is accepted but **not applied yet**: the calendar gets the
  server's default timezone and the result says so (#78).
- **`calendar_multi_get`, `todo_multi_get` and `addressbook_multi_get` returned
  objects without data** (#77). They now return URL, ETag and data for every
  object, and list a URL that no longer exists as not found instead of failing
  the whole call. `todo_multi_get` also finds todos from more than one task
  list in a single call, and a task list that no longer exists only costs its
  own todos. Long URL lists are fetched 100 at a time.
- **Deleting something that is not there no longer reports success.**
  `delete_calendar`, `delete_event`, `delete_todo` and `delete_contact`
  answered "deleted successfully" for a URL that does not exist. They now
  answer "nothing was deleted" with the not-found code.
- **Error codes for conflicts and busy servers.** A calendar URL that is
  confirmed taken, a 409, a locked resource (423) and "all calendar URLs
  taken" are reported as conflicts; 429, 502 and 503 as network errors
  instead of internal errors.

### Added
- **Digest authentication** (#74). Servers that only accept Digest — Baikal in
  its default setting, for example — answered every request with 401. They now
  work without any setting: under the default `AUTH_METHOD=Basic`, dav-mcp
  switches to Digest when the server offers nothing else. `AUTH_METHOD=Digest`
  never sends the password itself and is the better choice when the server is
  not reached over HTTPS. Digest needs Node.js 20 or newer; on Node.js 18
  dav-mcp stops at startup with an error that says so.
- **Container images for `linux/arm64`** (#73), next to `linux/amd64`. The
  image now runs on Apple Silicon, Raspberry Pi and ARM cloud instances without
  emulation.
- **A contributing guide and pull request template** (#75).

### Changed
- **`AUTH_METHOD` is case-insensitive and accepts `OAuth2`** as another name
  for `OAuth`; surrounding quotes and spaces are ignored. `oauth2` — the value
  the registry entry documented — used to run Basic silently. **If you have
  `AUTH_METHOD=oauth` or `oauth2` set but use `CALDAV_*` credentials, the
  server now stops at startup asking for the `GOOGLE_*` variables:** set
  `AUTH_METHOD=Basic` or remove it. A value dav-mcp does not know also stops
  the server at startup, listing the valid values, instead of falling back to
  Basic — over stdio as well as over HTTP. See MIGRATION.md.
- **The tsdav dependency is pinned to a release tarball of the fork**
  (`2.3.5+philflow.5`) instead of following the fork's `master`. Fresh
  installs of a dav-mcp release now always get the tsdav version that release
  was tested with, and tsdav no longer has to be cloned and built at install
  time. (`tsdav-utils` is still a git dependency, so git is still needed.)

### Internal
- CI builds and boots the image on a native arm64 runner for every pull
  request, and each release pulls the published image by digest on native
  amd64 and arm64 runners and waits for it to report healthy. Before, arm64
  had only ever run under emulation, and only as a local build.

## [4.0.1] - 2026-09-10

No functional change to the server. This release exists to correct the
registry entry, which could not be fixed without publishing a version.

### Fixed
- **`server.json` advertised environment variables the code never read.**
  The registry entry named `DAV_BASE_URL`, `DAV_USERNAME` and `DAV_PASSWORD`;
  the code reads `CALDAV_SERVER_URL`, `CALDAV_USERNAME` and `CALDAV_PASSWORD`,
  so a server configured from the registry exited during startup. The names
  were written during the schema migration in April and never matched (#69).
- **The changelog claimed two fixes were unreleased** that shipped in 4.0.0;
  they are listed under that version below, where they belong.

### Added
- **Published container images.** Releases now push to
  `ghcr.io/philflowio/dav-mcp`, tagged with the version, the minor line and
  `latest`. Previously the only documented path was building from source.
- **The registry entry documents the OAuth2 path.** `AUTH_METHOD` and the six
  `GOOGLE_*` variables are declared optional, with secrets marked as such.

### Changed
- **The container runtime is distroless** (#64): non-root (uid 65532), no
  shell, no package manager, both base images pinned by digest. The image is
  roughly a quarter of its previous size.
- **The image healthcheck follows `PORT`.** It previously probed `:3000`
  regardless, reporting unhealthy against a healthy server on another port.

### Internal
- CI builds the image on every pull request, boots it against a live CalDAV
  backend and waits for Docker's own healthy verdict, then asserts the
  non-root user and the absence of a shell (#66). Nothing built the image
  before, so the Dockerfile was the one file whose breakage went unnoticed.

## [4.0.0] - 2026-08-14

A correctness release. Several tools returned confidently wrong answers or
accepted input that produced invalid objects on the server; the fixes change
behaviour, hence the major version.

### Fixed
- **dotenv printed a banner to stdout under the stdio transport**, so the first
  thing a strict MCP client read was not JSON-RPC. Same hazard as #48, from a
  dependency rather than our own code.
- **The version reported to clients was hardcoded** and still said `3.0.1` in
  five places. It now comes from `package.json`, with a protocol-level test that
  speaks to the real server over stdio and asserts the two agree.

### Breaking Changes

- **`update_event` no longer takes dates through `fields`.** `DTSTART`, `DTEND`
  and `DURATION` are rejected there; use the new top-level `start_date`,
  `end_date` and `all_day` parameters instead (#56). The flat map cannot express
  this property family: an all-day value needs a `VALUE=DATE` parameter, which
  the map could only add as a *duplicate* property, and writing `DTEND` on an
  event stored as `DTSTART` + `DURATION` left both present, which RFC 5545 3.6.1
  forbids.
- **The `fields` map of `update_event`, `update_todo` and `update_contact` now
  validates its keys and values** (#44). Keys must be bare property names and
  values must be single-line. Parameterised keys (`DTSTART;VALUE=DATE`) and
  multi-line values are rejected.
- **Query tools return at most 20 results by default** (#34). `calendar_query`,
  `todo_query` and `addressbook_query` previously returned everything in range.
  Pass `limit` (max 500) to raise it; the response states how many matched in
  total.

### Security

- **Property and component injection through the `fields` map** (#44). Keys and
  values reached `updatePropertyWithValue` unvalidated, and that function keys on
  the property *name* alone. A value could terminate the VEVENT and open a
  second, fully caller-shaped one; a key containing `:` or a line break injected
  properties outright; a `VALARM` with `ACTION:EMAIL` and an arbitrary attendee
  could be attached. Verified by re-parsing the emitted documents. Reachable
  through ordinary tool arguments, which matters here because the caller is a
  model that routinely handles untrusted text.
- **Carriage returns survived `sanitizeICalString`**, and `create_event` and
  `create_contact` emitted LF line endings where RFC 5545 3.1 and RFC 6350 3.2
  require CRLF (#47).

### Fixed

- **Recurring events showed the series start, not the occurrence in the queried
  range** (#45). "What's on next week" returned each series once, dated at its
  original start — often years back. Present with a wrong date is worse than
  absent. Expansion is client-side, so it does not depend on a server
  implementing `CALDAV:expand`, and it also surfaces `RECURRENCE-ID` overrides,
  which were silently dropped. The walk is capped so a degenerate `RRULE` cannot
  stall a response.
- **Times were rendered in the server's timezone, not the event's** (#46). A
  meeting booked for 14:00 Berlin showed as 12:00 on a UTC host. An
  Exchange-style TZID made the date vanish entirely, and date-only values shifted
  a day east of Greenwich. Unresolvable TZIDs now render from the offset in the
  object's own VTIMEZONE (#54).
- **Deletes reported success even when the server refused them** (#9). `fetch`
  does not reject on 4xx, and the Response was discarded, so a 403 looked exactly
  like a 204. Server-independent, contrary to the issue's Radicale framing.
- **`[object Object]` as the collection name** (#38), across five call sites plus
  an explicit `null` path that a default parameter does not catch.
- **Contact photos overflowed the context** (#33). One contact with an embedded
  `PHOTO` produced ~171k characters, 99.9% of it base64 echoed into the raw data
  block. Against a real address book: 456k characters of raw cards render in 8.9k.
- **`client.fetchTodos is not a function`** (#41). The fork's committed `dist/`
  had lost the whole VTODO surface to an upstream sync, and a git install never
  rebuilt it, so six of the eight todo tools were dead for npm users while
  working locally. Fixed in the fork; the pin moves to that build and a test now
  asserts the client exposes what this server calls.
- **The tool-call logger could corrupt the JSON-RPC stream** (#48) by writing to
  stdout under the stdio transport.
- Success messages no longer read "created successfully successful".

### Added

- **`freebusy_query`** (#36): answers "when am I free?" client-side, since the
  native CalDAV `free-busy-query` REPORT fails on most servers people run.
  `TRANSP:TRANSPARENT` and cancelled events do not block; recurring series are
  expanded; touching intervals merge.
- **All-day events** (#43): `create_event` and `update_event` accept a bare
  `YYYY-MM-DD` `start_date`/`end_date` (or an explicit `all_day` flag) and emit
  `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE`. `update_event` gained top-level
  `start_date`/`end_date`/`all_day` parameters, which convert an event in both
  directions; the `fields` map cannot express a parameterised property.
  The all-day `DTEND` is exclusive, as RFC 5545 3.8.2.2 requires.
- **`limit`** on the three query tools, with the result set sorted before
  truncation so the subset is the earliest rather than arbitrary (#34, #32).

### Internal

- Tests: 76 → 237, including the first formatter, handler and timezone coverage.
  The suite runs under host timezones from Pacific/Midway to Pacific/Auckland,
  which is where the date-shifting bugs hid.
- Removed `src/utils/tool-helpers.js` (no importers, duplicated
  `src/tools/shared/helpers.js`).

## [3.0.1] - 2026-01-20

### Added
- **CLI flags**: `--http` and `--port` flags for easier server startup
  - `npx dav-mcp` → STDIO mode (default)
  - `npx dav-mcp --http` → HTTP mode on port 3000
  - `npx dav-mcp --http --port=8080` → HTTP mode with custom port

### Changed
- **README restructured** by user type (Claude Desktop, n8n, Docker)
- **Simplified setup**: No git clone needed for most users, just `npx dav-mcp`
- **Cleaned up `.env.example`**: Removed unnecessary `MCP_SERVER_NAME` and `MCP_SERVER_VERSION`

## [3.0.0] - 2026-01-20

### Breaking Changes
- **Removed HTTP+SSE transport**: The deprecated `/sse` and `/messages` endpoints have been removed
- **New transports**: Replaced with STDIO and Stateless HTTP transports
- **n8n users**: Must update endpoint from `/sse` to `/mcp`

### Added
- **STDIO transport** (`src/server-stdio.js`): For local clients (Claude Desktop, Cursor, npx)
- **Stateless HTTP transport** (`src/server-http.js`): For remote clients (n8n, cloud deployments)
- **MIGRATION.md**: Upgrade guide for migrating from v2.x

### Changed
- Default `npm start` now runs STDIO server (was SSE)
- Logger now writes to stderr in STDIO mode (preserves stdout for JSON-RPC)
- Dockerfile updated to use HTTP server
- Simplified HTTP server (stateless, no session management)

### Removed
- `src/index.js` (old HTTP+SSE server)
- Session management in HTTP transport
- `/sse` endpoint
- `/messages` endpoint

### Migration
See [MIGRATION.md](MIGRATION.md) for detailed upgrade instructions.

## [2.7.0] - 2025-10-30

### Added
- **OAuth2 Authentication Support**: Full OAuth2 support for Google Calendar and other OAuth2-enabled CalDAV servers
  - New `AUTH_METHOD` environment variable to switch between Basic Auth and OAuth2
  - Support for Google Calendar via OAuth2 with automatic token refresh
  - CalDAV discovery via RFC 4791 (no Google Calendar API required)
  - Tested with Google Calendar (5 calendars discovered and fully functional)
  - All CRUD operations (Create, Read, Update, Delete) working with OAuth2
- OAuth2 test suite with 10 comprehensive test cases
- OAuth2 configuration in `.env.example` with detailed setup instructions

### Changed
- **Field-agnostic updates**: Integrated tsdav-utils for universal field update support
  - `update_event` now supports all RFC 5545 iCalendar properties (SUMMARY, DESCRIPTION, LOCATION, DTSTART, DTEND, STATUS, etc.)
  - `update_todo` now supports all RFC 5545 VTODO properties (SUMMARY, DESCRIPTION, STATUS, PRIORITY, DUE, PERCENT-COMPLETE, etc.)
  - `update_contact` now supports all RFC 6350 vCard properties (FN, N, EMAIL, TEL, ORG, TITLE, NOTE, URL, ADR, BDAY, etc.)
  - All update tools now accept custom X-* properties for extensions (e.g., X-ZOOM-LINK, X-MEETING-ROOM)
- Replaced manual iCal/vCard string manipulation with structured field updates via tsdav-utils
- Simplified update tool implementations (reduced code by 40-45% per tool)
- Updated input schemas to accept any RFC property name (field-agnostic validation)
- Enhanced `tsdav-client.js` to support both Basic Auth and OAuth2 authentication methods
- Updated `index.js` initialization logic to auto-detect authentication method

### Dependencies
- Added: tsdav-utils (v0.1.0) - Field-agnostic utility layer for RFC-compliant updates

### Compatibility
- Fully backward compatible with existing Basic Auth setup
- No breaking changes - existing configurations continue to work
- Google Calendar tested and verified with OAuth2

## [2.6.0] - Previous Release

Initial release with 26 MCP tools for CalDAV, CardDAV, and VTODO operations.

