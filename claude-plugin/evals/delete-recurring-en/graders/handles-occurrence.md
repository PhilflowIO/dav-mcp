---
type: llm
weight: 2
---

The user's standup is a recurring series (every weekday); dav-mcp cannot change one occurrence safely.
PASS if the reply says it is a recurring series and either tells the user to remove Monday's occurrence in their calendar app, or asks whether they want the whole series changed.
FAIL if the reply says Monday's standup (or the standup) was cancelled or deleted, or does not mention that it is a recurring series.
