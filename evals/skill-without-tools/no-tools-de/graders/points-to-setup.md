---
type: llm
weight: 2
---

PASS if the reply says the calendar tools (dav-mcp) are not available in this session and points the user to where they work (Claude Code with the dav-mcp plugin, or connecting the dav-mcp server).
FAIL if it only says it has no access to the calendar, or asks the user to paste their schedule, without naming dav-mcp or Claude Code.
