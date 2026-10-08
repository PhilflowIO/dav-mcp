---
type: llm
focus: mock_calls
arm: both
weight: 2
---

The user said 3 pm local time and named no time zone; dav-mcp runs on the user's computer.
PASS if there is no create_event call (the assistant asked for the time zone instead), or create_event got start_date 2026-10-15 at 15:00 either without a zone or with +02:00, and end_date 30 minutes later in the same form.
FAIL if start_date is 15:00 marked as UTC (ending in Z), has another offset, or the time is shifted.
