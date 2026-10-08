---
name: calendar-contacts-tasks
description: Reads and changes the user's own calendars, contacts and to-dos on their CalDAV/CardDAV server (Nextcloud, iCloud, Baikal, Radicale and others) through the dav-mcp tools - finding events, free time, phone numbers and tasks, and creating, moving or deleting them safely. Use whenever the user asks about their schedule, appointments, meetings, availability, a contact's details or their to-do list, in any language, e.g. "Was steht morgen an?", "Bin ich Dienstag frei?", "Trag mir einen Termin ein", "Wie ist die Nummer von Lena?", "meine Aufgaben diese Woche", "when am I free?".
---

# Calendars, contacts and tasks with dav-mcp

The tools named here belong to the dav-mcp MCP server (in Claude Code:
`mcp__plugin_dav-mcp_dav-mcp__<name>`). They read and write the user's own
server, so every change shows up in the calendar apps the user and anyone
sharing their calendars see.

If no dav-mcp tools are available in this session, say so: they run only in
Claude Code with the dav-mcp plugin (claude.ai chat and Cowork load just this
guide). Never invent entries.

## Find before you list

- Events: `calendar_query` with a time range or text filter. Without
  `calendar_url` it searches every calendar; no `list_calendars` first.
  Never `list_events` to look something up: it returns a whole calendar.
- "When am I free", "am I available", finding a slot: `freebusy_query`,
  not `calendar_query`. It expands recurring events.
- Contacts: `addressbook_query` by name, email or organization, never
  `list_contacts`. To-dos: `todo_query`, never `list_todos`.

## Dates and time zones

- Resolve relative dates ("morgen", "next Friday") from today's date.
- A time the user gives ("3 pm", "um 10") is wall-clock time. Send it
  without a zone (`2026-10-15T15:00:00`). On an update this keeps the
  event's own time zone; on a new event dav-mcp reads it in the zone of the
  computer it runs on, which is the user's when dav-mcp runs there (the
  plugin, the Desktop bundle). Add an offset only when the user names another
  zone. Never `Z` or an offset on an update of an existing event: it pins the
  event to UTC, and a recurring one shifts by an hour after the next
  daylight-saving change.
- All-day events take bare dates and the end is exclusive: vacation from 19
  to 23 October is one event, start `2026-10-19`, end `2026-10-24`.

## Changing data

- Read the item first and pass its `url` and `etag` to the update or delete,
  the etag exactly as returned, quotes included. Use
  `update_event`/`update_contact`/`update_todo`; the `*_raw` tools only for a
  complete object the user supplies.
- On a conflict (412, "modified in the meantime"), do not retry with the
  same etag. Read the item again, tell the user what changed, and ask before
  applying the change to the new version.
- Delete only what the user named, after checking it is the exact item.
  `delete_calendar` removes every event in the calendar.
- `create_event` adds no attendees and sends no invitations. When the user
  wants someone invited, say plainly that the person is not invited and has
  to be invited from their calendar app; never say an invitation was or will
  be sent.

## Recurring events

`calendar_query` returns a series once, dated at its first occurrence in the
range. `delete_event` on a series deletes every occurrence, and
`STATUS: CANCELLED` on it cancels all of them. To drop one occurrence ("cancel
Monday's standup"), tell the user it is a recurring series and ask whether they mean
only that day or the whole series before changing anything.

## When something fails

Tell the user the cause in plain words and what to do, instead of repeating
the call:

- Authentication error: the server rejected the username or password. They
  re-enter it with `/config`; iCloud, and Nextcloud with two-factor login,
  need an app password.
- Not found: the URL changed; search again.
- Server not reachable or no calendars: the server URL must be the DAV
  address (e.g. ending in `/remote.php/dav/` for Nextcloud).
