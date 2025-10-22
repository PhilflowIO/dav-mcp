# Architecture Diagram: Modular Tools Structure

## System Overview (C4 - Level 2: Container Diagram)

```
┌────────────────────────────────────────────────────────────────────┐
│                         MCP Server                                 │
│                      (Express + SSE)                               │
└──────────────────────────┬─────────────────────────────────────────┘
                           │
                           │ imports tools
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│                    src/tools/index.js                              │
│                   Main Tools Aggregator                            │
│                      (46 LOC)                                      │
└─────┬────────────────────┬────────────────────┬─────────────────────┘
      │                    │                    │
      │ imports            │ imports            │ imports
      ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  calendar/      │  │  contacts/      │  │  todos/         │
│  index.js       │  │  index.js       │  │  index.js       │
│  (13 LOC)       │  │  (10 LOC)       │  │  (9 LOC)        │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                    │                     │
         │ exports            │ exports             │ exports
         ▼                    ▼                     ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ Calendar Tools  │  │ Contact Tools   │  │ Todo Tools      │
│ (10 modules)    │  │ (7 modules)     │  │ (6 modules)     │
└─────────────────┘  └─────────────────┘  └─────────────────┘
```

---

## Module Structure (C4 - Level 3: Component Diagram)

### Calendar Tools Domain
```
src/tools/calendar/
│
├── index.js ─────────────────────────┐
│                                     │ exports all
│                                     ▼
├── list-calendars.js ───────► CalDAV Operations
├── list-events.js ──────────►   (10 tools)
├── create-event.js ─────────►
├── update-event.js ─────────►
├── delete-event.js ─────────►
├── calendar-query.js ───────►  Filtering & Search
├── make-calendar.js ────────►  Calendar Management
├── update-calendar.js ──────►
├── delete-calendar.js ──────►
└── calendar-multi-get.js ───►  Batch Operations
```

### Contacts Tools Domain
```
src/tools/contacts/
│
├── index.js ─────────────────────────┐
│                                     │ exports all
│                                     ▼
├── list-addressbooks.js ────► CardDAV Operations
├── list-contacts.js ────────►   (7 tools)
├── create-contact.js ───────►
├── update-contact.js ───────►
├── delete-contact.js ───────►
├── addressbook-query.js ────►  Filtering & Search
└── addressbook-multi-get.js ►  Batch Operations
```

### Todos Tools Domain
```
src/tools/todos/
│
├── index.js ─────────────────────────┐
│                                     │ exports all
│                                     ▼
├── list-todos.js ───────────► VTODO Operations
├── create-todo.js ──────────►   (6 tools)
├── update-todo.js ──────────►
├── delete-todo.js ──────────►
├── todo-query.js ───────────►  Filtering & Search
└── todo-multi-get.js ───────►  Batch Operations
```

---

## Shared Utilities

```
src/tools/shared/
│
└── helpers.js ──────────────────────┐
    │                                │ provides
    │                                ▼
    ├── formatICalDate()        Common Utilities
    ├── generateUID()            for all tools
    ├── findCalendarOrThrow()
    ├── findAddressbookOrThrow()
    ├── buildTimeRangeOptions()
    ├── getCalendarHome()
    └── sanitizeNameForUrl()
```

---

## Data Flow (Sequence Diagram)

```
Client              MCP Server          tools/index.js      calendar/list-calendars.js      tsdav-client
  │                     │                      │                       │                          │
  │  POST /messages     │                      │                       │                          │
  ├────────────────────>│                      │                       │                          │
  │                     │                      │                       │                          │
  │                     │  find tool           │                       │                          │
  │                     ├─────────────────────>│                       │                          │
  │                     │                      │                       │                          │
  │                     │  execute handler     │                       │                          │
  │                     ├──────────────────────┼──────────────────────>│                          │
  │                     │                      │                       │                          │
  │                     │                      │                       │  getCalDavClient()       │
  │                     │                      │                       ├─────────────────────────>│
  │                     │                      │                       │                          │
  │                     │                      │                       │  fetchCalendars()        │
  │                     │                      │                       ├─────────────────────────>│
  │                     │                      │                       │                          │
  │                     │                      │                       │  calendars[]             │
  │                     │                      │                       │<─────────────────────────┤
  │                     │                      │                       │                          │
  │                     │                      │   formatCalendarList()│                          │
  │                     │                      │                       ├──> formatters.js         │
  │                     │                      │                       │                          │
  │                     │  formatted result    │                       │                          │
  │                     │<─────────────────────┼───────────────────────┤                          │
  │                     │                      │                       │                          │
  │  response           │                      │                       │                          │
  │<────────────────────┤                      │                       │                          │
  │                     │                      │                       │                          │
```

---

## Dependency Graph

```
                         src/index.js
                              │
                              │ imports
                              ▼
                      src/tools/index.js
                              │
                    ┌─────────┼─────────┐
                    │         │         │
                    ▼         ▼         ▼
            calendar/   contacts/    todos/
             index       index       index
                    │         │         │
           ┌────────┴───┐     │     ┌───┴────────┐
           │            │     │     │            │
           ▼            ▼     ▼     ▼            ▼
    list-calendars  create-  list- create-  todo-query
    create-event    event    contacts todo
    ...             ...      ...      ...
           │            │     │     │            │
           └────────────┴─────┴─────┴────────────┘
                              │
                              │ all import
                              ▼
                    ┌─────────────────────┐
                    │  Shared Resources   │
                    ├─────────────────────┤
                    │ tsdav-client.js     │
                    │ validation.js       │
                    │ formatters.js       │
                    │ shared/helpers.js   │
                    └─────────────────────┘
```

---

## File Size Distribution

```
Monolithic (Before):
┌──────────────────────────────────────────────────────────┐
│ tools.js                                          1265 LOC │
└──────────────────────────────────────────────────────────┘

Modular (After):
Calendar Tools (avg ~107 LOC each):
├── list-calendars.js      ████████░░
├── list-events.js         ████████████░░
├── create-event.js        ████████████████░░
├── update-event.js        ████████░░
├── delete-event.js        ████████░░
├── calendar-query.js      ████████████████████░░
├── make-calendar.js       ████████████████░░
├── update-calendar.js     ████████████████████████░░
├── delete-calendar.js     ████████░░
└── calendar-multi-get.js  ████████░░

Contact Tools:
├── list-addressbooks.js   ████████░░
├── list-contacts.js       ████████████░░
├── create-contact.js      ████████████████░░
├── update-contact.js      ████████░░
├── delete-contact.js      ████████░░
├── addressbook-query.js   ████████████████░░
└── addressbook-multi-get.js ████████░░

Todo Tools:
├── list-todos.js          ████████░░
├── create-todo.js         ████████████████████░░
├── update-todo.js         ████████░░
├── delete-todo.js         ████████░░
├── todo-query.js          ████████████████████████░░
└── todo-multi-get.js      ████████░░

Shared:
└── helpers.js             ████████████████████░░

Legend: Each █ = ~20 LOC
```

---

## Tool Distribution by Category

```
┌───────────────────────────────────────────┐
│          Tool Distribution                │
│                                           │
│   Calendar   ██████████ (10 tools, 43%)  │
│   Contacts   ███████ (7 tools, 30%)      │
│   Todos      ██████ (6 tools, 26%)       │
│                                           │
│   Total: 23 tools                         │
└───────────────────────────────────────────┘
```

---

## Import Chain Visualization

```
Entry Point: src/index.js
│
├─ import { tools } from './tools/index.js'
│  │
│  └─ tools/index.js
│     │
│     ├─ import * as calendarTools from './calendar/index.js'
│     │  │
│     │  └─ calendar/index.js
│     │     ├─ export { listCalendars } from './list-calendars.js'
│     │     ├─ export { listEvents } from './list-events.js'
│     │     └─ ... (8 more exports)
│     │
│     ├─ import * as contactTools from './contacts/index.js'
│     │  │
│     │  └─ contacts/index.js
│     │     ├─ export { listAddressbooks } from './list-addressbooks.js'
│     │     └─ ... (6 more exports)
│     │
│     └─ import * as todoTools from './todos/index.js'
│        │
│        └─ todos/index.js
│           ├─ export { listTodos } from './list-todos.js'
│           └─ ... (5 more exports)
```

---

## Benefits Visualization

### Before: Monolithic Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                        tools.js                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Calendar: list, create, update, delete, query...     │   │
│  │ Contacts: list, create, update, delete, query...     │   │
│  │ Todos: list, create, update, delete, query...        │   │
│  │ Helpers: formatICalDate, generateUID, findCalendar...│   │
│  │ ... 1,265 lines of code in one file ...              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘

Problems:
❌ Hard to navigate (1,265 LOC)
❌ High merge conflict risk
❌ Poor separation of concerns
❌ Difficult to test in isolation
❌ Cognitive overload
```

### After: Modular Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                     tools/index.js                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  calendar/   │  │  contacts/   │  │   todos/     │      │
│  │  ├─ list     │  │  ├─ list     │  │  ├─ list     │      │
│  │  ├─ create   │  │  ├─ create   │  │  ├─ create   │      │
│  │  ├─ update   │  │  ├─ update   │  │  ├─ update   │      │
│  │  ├─ delete   │  │  ├─ delete   │  │  ├─ delete   │      │
│  │  └─ query    │  │  └─ query    │  │  └─ query    │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                             │
│  ┌──────────────────────────────────────────────────┐      │
│  │            shared/helpers.js                     │      │
│  │  Common utilities used across all domains        │      │
│  └──────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────┘

Benefits:
✅ Easy to navigate (~107 LOC per file)
✅ Low merge conflict risk (separate files)
✅ Clear separation of concerns (by domain)
✅ Easy to test (isolated modules)
✅ Reduced cognitive load
✅ Scalable architecture
```

---

## Testing Strategy

```
Unit Tests (per module):
├── calendar/__tests__/
│   ├── list-calendars.test.js
│   ├── create-event.test.js
│   └── ...
├── contacts/__tests__/
│   └── ...
└── todos/__tests__/
    └── ...

Integration Tests:
└── tools/index.test.js (verify all tools load correctly)

E2E Tests:
└── server.test.js (verify server endpoints work)
```

---

## Maintenance Guidelines

### Adding a New Tool

1. **Create module file** in appropriate domain folder
   ```javascript
   // src/tools/calendar/new-tool.js
   export const newTool = {
     name: 'new_tool',
     description: '...',
     inputSchema: { /* ... */ },
     handler: async (args) => { /* ... */ }
   };
   ```

2. **Export from domain index**
   ```javascript
   // src/tools/calendar/index.js
   export { newTool } from './new-tool.js';
   ```

3. **Add to main index**
   ```javascript
   // src/tools/index.js
   export const tools = [
     // ...
     calendarTools.newTool,
     // ...
   ];
   ```

### Modifying Existing Tool

1. **Locate tool file** (e.g., `calendar/create-event.js`)
2. **Make changes** in isolation
3. **Test** the specific module
4. **No other files** need to be touched

### Adding Shared Utility

1. **Add function** to `shared/helpers.js`
2. **Export** the function
3. **Import** where needed

---

**Document Version:** 1.0.0
**Last Updated:** 2025-10-22
**Maintained By:** System Architecture Team
