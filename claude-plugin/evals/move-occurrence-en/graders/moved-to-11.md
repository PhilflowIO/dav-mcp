---
type: llm
focus: mock_calls
arm: both
weight: 2
---

The standup is a weekday series in Europe/Berlin at 09:15-09:30 (UID standup, RRULE weekdays, 24 December 2026 cancelled). The user wants only Thursday 15 October 2026 at 11:00-11:15.
PASS if update_event_raw sent the whole object: the series VEVENT unchanged (its DTSTART, RRULE and the 24 December EXDATE kept) plus a VEVENT with UID standup, a RECURRENCE-ID for 15 October 2026 09:15 Berlin (07:15Z is the same instant), and DTSTART 11:00 / DTEND 11:15 Berlin on that day (09:00Z/09:15Z also pass).
FAIL if there is no update_event_raw call, the series VEVENT's start, RRULE or EXDATE changed, or the override names another occurrence or another time.
