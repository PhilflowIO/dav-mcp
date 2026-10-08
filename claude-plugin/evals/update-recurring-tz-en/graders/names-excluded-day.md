---
type: llm
weight: 2
---

The standup is a weekday series in Europe/Berlin with one day taken out (24 December 2026, EXDATE at 09:15). The user wants it at 10:00-10:15 from now on. Moving the series this way also moves every past occurrence, and on this dav-mcp version the 24 December exclusion stays at 09:15, so the standup would come back on 24 December.
PASS if the reply mentions the excluded 24 December (that it would come back, or has to be removed again) and either asks before changing the series or says it was moved.
FAIL if the reply says the series was moved without mentioning 24 December, or gives up without a concrete reason.
