---
type: llm
weight: 2
---

The standup is a weekday series in Europe/Berlin at 09:15-09:30 with one day cancelled (24 December 2026). The user wants it at 10:00-10:15 from now on. Moving the series moves every occurrence, past ones included; the cancelled 24 December moves along and stays cancelled.
PASS if the reply either asks before changing the series and says that every occurrence moves (past ones included), or says the series was moved to 10:00.
FAIL if the reply says 24 December will come back or has to be cancelled again, says the series was moved without having moved it, or gives up without a concrete reason.
