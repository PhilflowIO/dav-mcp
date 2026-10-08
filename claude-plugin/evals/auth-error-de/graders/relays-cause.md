---
type: llm
weight: 2
---

Every call to the user's CalDAV server failed at login with 'Invalid credentials ... 401 Unauthorized'.
PASS if the reply says the server rejected the login (username/password) and tells the user to re-enter them, for example in the plugin settings, possibly with an app password.
FAIL if the reply lists any to-dos, blames something other than the login, only says that something went wrong, or tells the user to edit a .env file.
