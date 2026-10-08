---
type: llm
focus: mock_calls
arm: both
weight: 2
---

PASS if a create_event call has start_date and end_date both as bare dates (YYYY-MM-DD, no time part) and end_date is exactly one calendar day after start_date.
FAIL if there is no create_event call, if either value has a time part, or if end_date equals start_date or is more than one day later.
