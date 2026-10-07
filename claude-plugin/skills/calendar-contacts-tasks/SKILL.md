---
name: calendar-contacts-tasks
description: How to work with the user's calendars, contacts and to-dos through the dav-mcp tools - finding events and free time, scheduling, updating and deleting safely, and handling dates, time zones and all-day events correctly. Use when the user asks about their schedule, availability, meetings, contacts, or tasks.
---

# Calendars, contacts and tasks with dav-mcp

The dav-mcp tools read and write the user's own CalDAV/CardDAV server. Every
change lands in the calendar apps the user and the people they share calendars
with see. Work so that nothing surprising happens there.

## Find before you list

- To find events, use `calendar_query` with a time range or a text filter. It
  searches every calendar when `calendar_url` is omitted, so there is no need
  to call `list_calendars` first. `list_events` returns a whole calendar and
  can be thousands of entries.
- For "when am I free", "am I available", or finding a meeting slot, use
  `freebusy_query`. It already ignores cancelled and transparent events and
  expands recurring ones.
- Contacts: `addressbook_query` by name, email or organization. To-dos:
  `todo_query` by status, title or due date.
- Results are capped (default 20). The response says how many matched in
  total; narrow the range or raise `limit` when the user needs more.

## Dates and time zones

- Turn relative dates ("tomorrow", "next Friday") into ISO 8601 using today's
  date and the user's time zone. If you don't know the user's zone and the
  time of day matters, ask.
- A datetime with `Z` or an offset is an exact instant. A datetime without a
  zone is read in the event's own zone (updates) or the server's zone (new
  events and to-dos). Prefer sending an explicit offset.
- A bare date (`2026-05-25`) makes an all-day event. The end of an all-day
  event is exclusive: one day on 25 May is start `2026-05-25`, end
  `2026-05-26`.
- Start and end must be the same kind: both dates or both datetimes.

## Changing data

- Updates and deletes need the item's `url` and `etag` from a recent read.
  Read the item first, then change it. If the server reports a conflict, the
  item changed in the meantime: read it again and show the user what changed
  before retrying.
- Use `update_event`, `update_contact` and `update_todo` with the fields that
  change. The `*_raw` variants replace the whole iCalendar or vCard object;
  use them only when the user gives you a complete object or needs a property
  the field tools cannot set.
- Before deleting, name the exact item (title, date, calendar) and make sure
  the user asked for that deletion. `delete_calendar` removes the calendar and
  every event in it.
- Creating an event does not invite anyone. If attendees should be notified,
  tell the user that their calendar app or server handles invitations.

## Recurring events

`calendar_query` and `freebusy_query` expand recurring events into their
occurrences. Changing a single occurrence or the whole series edits the
series' iCalendar data; confirm with the user which one they mean before
updating or deleting a recurring event.

## When something fails

Error messages from dav-mcp name the cause (wrong credentials, unknown URL,
conflicting etag, invalid date). Relay the cause in plain words and what the
user can do about it, rather than retrying the same call.
