---
type: llm
weight: 2
---

freebusy_query answered in UTC: busy 12:00-13:30 UTC, free 13:30-15:00 UTC. In Berlin (UTC+2 on that date) that is busy 14:00-15:30, free 15:30-17:00.
PASS if the reply tells the user they are free from 15:30 (3:30 pm) to 17:00 Berlin time, so a one-hour call fits after 15:30.
FAIL if it presents 13:30 as the local free time, says the whole window is free or fully busy, or gives no time.
