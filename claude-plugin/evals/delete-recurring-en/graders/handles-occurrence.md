---
type: llm
weight: 2
---

The user's standup is a recurring series (every weekday) in Europe/Berlin at 09:15. dav-mcp cancels a single occurrence with `update_event` and `cancel_occurrences`, leaving the rest of the series as it is.
PASS if the reply says that only the standup on Monday 12 October was cancelled and the series otherwise continues.
FAIL if the reply says the whole series (or every standup) was cancelled or deleted, or claims Monday was cancelled without having cancelled it.
