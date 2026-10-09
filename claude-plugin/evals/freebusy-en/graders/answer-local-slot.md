---
type: llm
weight: 2
---

freebusy_query answered in Europe/Berlin, the user's zone (its Time zone line names it): busy 14:00-15:30, free 15:30-17:00 (GMT+2 on that date).
PASS if the reply tells the user they are free from 15:30 (3:30 pm) to 17:00 Berlin time, so a one-hour call fits after 15:30.
FAIL if it shifts the times (e.g. presents 13:30 or 17:30 as the local free time), says the whole window is free or fully busy, or gives no time.
