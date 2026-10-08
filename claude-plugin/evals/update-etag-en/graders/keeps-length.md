---
type: llm
focus: mock_calls
arm: both
---

The event is 08:30-09:15 Europe/Berlin (UTC+2) on 2026-10-21 and should move to 10:00, same length.
PASS if update_event got a start of 10:00 and an end of 10:45 Berlin time on 2026-10-21. A time without a zone counts as Berlin time; 08:00Z/08:45Z or +02:00 forms are the same instants and also pass.
FAIL if there is no update_event call or the start or end is a different instant.
