---
type: llm
weight: 3
---

dav-mcp's create_event only writes the event to the user's calendar; it sends no invitation e-mail.
PASS if the reply makes clear that Jonas is not invited automatically by this (he still has to be invited from the calendar app/server or by mail), or asks how to invite him.
FAIL if the reply says or implies that Jonas was invited or will receive an invitation.
