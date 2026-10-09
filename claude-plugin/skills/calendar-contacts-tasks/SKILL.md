---
name: calendar-contacts-tasks
description: Reads and changes the user's own calendars, contacts and to-dos on their CalDAV/CardDAV server (Nextcloud, iCloud, Baikal, Radicale and others) through the dav-mcp tools - finding events, free time, phone numbers and tasks, and creating, moving, cancelling or deleting them safely. Use whenever the user asks about or wants to change their schedule, appointments, meetings, availability, a contact's details or their to-do list, in any language, e.g. "Was steht morgen an?", "Bin ich Dienstag frei?", "Trag mir einen Termin ein", "Wie ist die Nummer von Lena?", "meine Aufgaben diese Woche", "when am I free?".
---

# Calendars, contacts and tasks with dav-mcp

The tools named here belong to the dav-mcp MCP server (in Claude Code:
`mcp__plugin_dav-mcp_dav-mcp__<name>`). They read and write the user's own
server, so every change shows up in the calendar apps the user and anyone
sharing their calendars see.

If no dav-mcp tools are available in this session, say so and never invent
entries. The tools come from the dav-mcp server: the dav-mcp plugin in Claude
Code, the dav-mcp bundle in Claude Desktop, or a manual MCP setup elsewhere.
claude.ai chat and Cowork load only this guide.

## Find before you list

- Events: `calendar_query` with a time range or text filter. Without
  `calendar_url` it searches every calendar; no `list_calendars` first.
  Never `list_events` to look something up: it returns a whole calendar.
- "When am I free", "am I available", finding a slot: `freebusy_query`,
  not `calendar_query`. It expands recurring events. It prints times in the
  calendar's time zone and names that zone on its **Time zone** line: pass
  the times on as they are, and convert only when the user said they are in
  another zone.
- Contacts: `addressbook_query` by name, email or organization, never
  `list_contacts`. To-dos: `todo_query`, never `list_todos`.

## Dates and time zones

- Resolve relative dates ("morgen", "next Friday") from today's date.
- A time the user gives ("3 pm", "um 10") is wall-clock time. Send it
  without a zone (`2026-10-15T15:00:00`). dav-mcp reads it in the
  calendar's time zone (`list_calendars` shows it); for a calendar without
  one, in the zone dav-mcp runs in, which is the user's when dav-mcp runs on
  their computer (the plugin, the Desktop bundle). On an update the event
  keeps its own time zone, and an event stored without one stays so. On a
  new event, add an offset only when the user names another zone.
- Never `Z` or an offset on an update of an existing event. The user means
  a local time, and a UTC time or offset worked out by hand is easily an
  hour off around a daylight-saving change; without a zone, dav-mcp places
  it in the event's own zone.
- A time the clocks skip or show twice at a daylight-saving change is
  refused for some events. The error says what to give instead; ask the
  user which time they mean if it is not clear.
- `make_calendar` and `update_calendar` take an IANA zone name such as
  `Europe/Berlin`, not an abbreviation like `CEST`.
- All-day events take bare dates and the end is exclusive: vacation from 19
  to 23 October is one event, start `2026-10-19`, end `2026-10-24`.

## Changing data

- Read the item first and pass its `url` and `etag` to the update or delete,
  the etag exactly as returned, quotes included. Use
  `update_event`/`update_contact`/`update_todo`; the `*_raw` tools only for a
  complete object the user supplies.
- If an update fails with `412 Precondition Failed`, the item changed since
  you read it. Do not retry with the same etag. Read it again, tell the user
  what changed, and ask before applying the change to the new version.
- Delete only what the user named, after checking it is the exact item.
  `delete_calendar` removes every event in the calendar.
- `create_event` adds no attendees and sends no invitations. When the user
  wants someone invited, say plainly that the person is not invited and has
  to be invited from their calendar app; never say an invitation was or will
  be sent.

## Recurring events

`calendar_query` lists a series once. With a time range it shows the earliest
occurrence that touches the range, so one running into it from the day before
counts: a 22:00-02:00 shift queried over 12 November is listed with its 11
November occurrence. Its **Occurrence ID** line names that occurrence by its
original start: `(this occurrence)`, `(this occurrence, changed — now at …)`
for one moved before (pass the ID, not the new time), or `(series start, the
first occurrence)` when the query had no range. **Cancelled occurrences**,
**Changed occurrences** and **Exclusions that match no occurrence** (they
cancel nothing) list the series' exceptions.

Fields and dates in `update_event` change every occurrence: `delete_event`
deletes the whole series, `STATUS: CANCELLED` cancels all of it. When the
user means one day ("cancel Monday's standup"), cancel only that occurrence:
`calendar_query` over that day, check the **When** line is the day the user
meant, then `update_event` with `cancel_occurrences: ["<Occurrence ID>"]`,
exactly as listed. Days already cancelled stay cancelled. To bring one back,
`restore_occurrences` with its name from **Cancelled occurrences**.
`update_event` refuses `EXDATE` and `RDATE` in `fields`; extra dates (RDATE)
are edited only by fetching the event with `calendar_multi_get` and sending it
back whole with `update_event_raw`. Never use `update_event_raw` to drop one
day. Change the series only when the user asks for the series ("from now on",
"every week"). Recurring to-dos work the same way with `update_todo` and
`todo_query`.

Never move a series (an event with `RRULE`) to another time without asking
first: moving it moves every occurrence, past ones included. Cancelled and
changed occurrences move along with it. If the move is refused, the error
says what to give instead, usually `restore_occurrences` and
`cancel_occurrences` in the same call; follow it rather than dropping the
exceptions.

## When something fails

Tell the user the cause in plain words and what to do, instead of repeating
the call:

- `Invalid credentials` / `401 Unauthorized`: the server rejected the
  username or password. In Claude Code they re-enter it in `/plugin` →
  Installed → dav-mcp → Configure options; iCloud, and Nextcloud with
  two-factor login, need an app password.
- `404` / not found: the URL changed; search again.
- `unknown parameter`: the tool does not take it and nothing was written.
  Check the tool's input schema; never tell the user it was applied.
- Server not reachable or no calendars: the server URL must be the DAV
  address (e.g. ending in `/remote.php/dav/` for Nextcloud).
