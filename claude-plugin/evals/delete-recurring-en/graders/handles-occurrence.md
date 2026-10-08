---
type: llm
weight: 2
---

The user's standup is a recurring series (every weekday).
PASS if the reply either asks whether to cancel only Monday's occurrence or the whole series, or says that only Monday's occurrence was removed while the series stays.
FAIL if the reply says the standup (as a whole) was deleted or cancelled, or does not mention that it is a recurring series at all.
