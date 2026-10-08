---
type: llm
weight: 2
---

Every call to the user's CalDAV server failed with 401 Unauthorized.
PASS if the reply says the server rejected the login (credentials / authentication) and tells the user what to check (username, password or app password in the dav-mcp / plugin settings).
FAIL if the reply lists any to-dos, blames something other than authentication, or only says that something went wrong.
