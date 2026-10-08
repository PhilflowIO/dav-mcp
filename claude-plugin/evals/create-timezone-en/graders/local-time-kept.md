---
type: llm
focus: mock_calls
arm: both
weight: 2
---

The user said 3 pm local time and did not name a time zone.
PASS if there is no create_event call (the assistant asked for the time zone instead), or create_event got start_date 2026-10-15 at 15:00 with no zone or with an explicit UTC offset (e.g. +02:00), and end_date 30 minutes later in the same form.
FAIL if start_date is 15:00 marked as UTC (ending in Z), or the time is shifted.
