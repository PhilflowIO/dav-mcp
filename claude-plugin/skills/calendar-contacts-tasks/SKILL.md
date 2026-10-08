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
  not `calendar_query`. It expands recurring events. It prints times in UTC:
  convert them to the user's time zone before answering.
- Contacts: `addressbook_query` by name, email or organization, never
  `list_contacts`. To-dos: `todo_query`, never `list_todos`.

## Dates and time zones

- Resolve relative dates ("morgen", "next Friday") from today's date.
- A time the user gives ("3 pm", "um 10") is wall-clock time. Send it
  without a zone (`2026-10-15T15:00:00`). On an update this keeps the
  event's own time zone; on a new event dav-mcp reads it in the zone of the
  computer it runs on, which is the user's when dav-mcp runs there (the
  plugin, the Desktop bundle). On a new event, add an offset only when the
  user names another zone. Never `Z` or an offset on an update of an existing event: it pins the
  event to UTC, and a recurring one shifts by an hour after the next
  daylight-saving change.
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

`calendar_query` returns a series once, dated at its first occurrence in the
range. Changing or deleting it changes every occurrence: `delete_event`
deletes the whole series, `STATUS: CANCELLED` cancels all of it. dav-mcp
cannot change a single occurrence safely: do not add an `EXDATE` or rewrite
the series with `update_event_raw` to drop one day (an `EXDATE` field
replaces the exclusions already there). When the user means one day
("cancel Monday's standup"), say it is a recurring series and that one
occurrence is changed in their calendar app; change the series only when they
ask for the series ("from now on", "every week").

Never move a series (an event with `RRULE`) to another time without asking
first. Moving it moves every occurrence, past ones included, and each day
the user took out (an `EXDATE` line in its data) may stay at the old time
(dav-mcp before 4.4.0 does not move it), so that day comes back. Tell the
user both, name each excluded day, then ask, or point them to their calendar
app.

## When something fails

Tell the user the cause in plain words and what to do, instead of repeating
the call:

- `Invalid credentials` / `401 Unauthorized`: the server rejected the
  username or password. In Claude Code they re-enter it in `/plugin` →
  Installed → dav-mcp → Configure options; iCloud, and Nextcloud with
  two-factor login, need an app password.
- `404` / not found: the URL changed; search again.
- Server not reachable or no calendars: the server URL must be the DAV
  address (e.g. ending in `/remote.php/dav/` for Nextcloud).
