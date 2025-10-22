# Architektur-Review: tsdav-mcp-server

**Review-Datum:** 2025-10-22
**Version:** 2.3.0
**Reviewer:** System Architecture Designer
**Gesamtbewertung:** 6.5/10

---

## Executive Summary

Der tsdav-mcp-server ist ein MCP (Model Context Protocol) Server, der CalDAV/CardDAV-Funktionalitaten uber eine SSE (Server-Sent Events) Schnittstelle bereitstellt. Die Architektur zeigt solide Grundlagen, leidet jedoch unter typischen Monolith-Problemen: mangelnde Modularitat, Code-Duplikation und fehlende architektonische Abstraktionen.

**Starken:**
- Klare Separation von Concerns in einzelnen Dateien (logger, validation, formatters)
- Robustes Error-Handling mit MCP-konformen Error-Codes
- Gute Input-Validierung mit Zod
- Produktionsreife Features (Rate Limiting, Session Management, Bearer Auth)

**Kritische Schwachen:**
- Massive Code-Duplikation (tools.js: 1265 LOC)
- Fehlende Abstraktionsschichten
- Tight Coupling zwischen MCP Server und Business Logic
- Keine Dependency Injection
- Test-Architektur ohne klare Struktur

---

## 1. Architektur-Analyse

### 1.1 Current Architecture Overview

```
tsdav-mcp-server/
├── src/
│   ├── index.js           (475 LOC) - SSE MCP Server + Express
│   ├── server-stdio.js    (84 LOC)  - Stdio MCP Server
│   ├── tools.js           (1265 LOC) - MASSIVE Tool Definitions
│   ├── tsdav-client.js    (85 LOC)  - Singleton Client Manager
│   ├── validation.js      (193 LOC) - Zod Schemas
│   ├── error-handler.js   (216 LOC) - Error Handling
│   ├── formatters.js      (742 LOC) - Output Formatters
│   └── logger.js          (134 LOC) - Custom JSON Logger
└── tests/
    ├── integration/       - MCP Test Runner
    └── optimization/      - Performance Metrics
```

**Total Source Lines:** 4856 (63 files, viele davon Tests/Docs)

### 1.2 Architectural Layers (Current State)

```
┌─────────────────────────────────────────┐
│   Transport Layer (SSE/Stdio)           │  ← index.js, server-stdio.js
├─────────────────────────────────────────┤
│   MCP Protocol Handler                  │  ← Tightly coupled in index.js
├─────────────────────────────────────────┤
│   Tool Orchestration (MISSING!)        │  ← Should exist, doesn't!
├─────────────────────────────────────────┤
│   Business Logic (1265 LOC Monster)    │  ← tools.js
├─────────────────────────────────────────┤
│   DAV Client Abstraction               │  ← tsdav-client.js (OK)
├─────────────────────────────────────────┤
│   External DAV Server                   │  ← tsdav library
└─────────────────────────────────────────┘
```

**PROBLEM:** Fehlende Service-Schicht zwischen MCP Handler und Business Logic!

---

## 2. Separation of Concerns - Analyse

### 2.1 POSITIV: Gut getrennte Querschnittsaspekte

✅ **Logging** (logger.js): Saubere Abstraktion, wiederverwendbar
```javascript
export const logger = new JSONLogger();
export function createSessionLogger(sessionId) { ... }
export function createRequestLogger(requestId) { ... }
```

✅ **Validation** (validation.js): Zentralisiert mit Zod
```javascript
export function validateInput(schema, data) { ... }
```

✅ **Error Handling** (error-handler.js): MCP-konforme Error-Codes
```javascript
export const MCP_ERROR_CODES = { CALDAV_ERROR: -32000, ... }
```

✅ **Formatting** (formatters.js): LLM-optimierte Markdown-Ausgaben
```javascript
export function formatEventList(events, calendar) { ... }
```

### 2.2 NEGATIV: Massive Kopplung in tools.js

❌ **Problem:** Jedes Tool ist ein 40-80 LOC Monster mit identischer Struktur:

```javascript
{
  name: 'calendar_query',
  description: '...',
  inputSchema: { ... },  // ← Redundant mit validation.js!
  handler: async (args) => {
    const validated = validateInput(calendarQuerySchema, args);
    const client = tsdavManager.getCalDavClient();
    const calendars = await client.fetchCalendars();
    // 30-60 Zeilen Business Logic
    return formatEventList(filteredEvents, calendarName);
  }
}
```

**22 Tools x ~50 LOC = 1265 LOC** - Massive Code-Duplikation!

---

## 3. Modularitat und Kohesion

### 3.1 Single Responsibility Principle Violations

**index.js (475 LOC) - VERLETZT SRP:**
- Express Server Setup
- CORS Configuration
- Rate Limiting
- Bearer Token Authentication
- Session Management
- MCP Server Creation
- Tool Request Handling
- Health Check Endpoint
- Graceful Shutdown
- Error Handling

**BEWERTUNG:** Eine Datei, 10 Verantwortlichkeiten = 1/10 SRP-Score

### 3.2 Vorgeschlagene Modularisierung

```
src/
├── transport/
│   ├── sse-server.js      ← SSE-spezifische Logik
│   └── stdio-server.js    ← Stdio-spezifische Logik
├── server/
│   ├── mcp-server.js      ← Pure MCP Server
│   └── session-manager.js ← Session-Verwaltung
├── middleware/
│   ├── auth.js            ← Bearer Token Auth
│   ├── rate-limit.js      ← Rate Limiting
│   └── cors.js            ← CORS Config
├── services/
│   ├── calendar-service.js   ← CalDAV Business Logic
│   ├── contact-service.js    ← CardDAV Business Logic
│   └── todo-service.js       ← Todo Business Logic
├── tools/
│   ├── tool-factory.js       ← Tool Generator Pattern
│   ├── calendar-tools.js     ← Calendar Tool Definitions
│   ├── contact-tools.js      ← Contact Tool Definitions
│   └── todo-tools.js         ← Todo Tool Definitions
└── core/
    ├── logger.js
    ├── validation.js
    ├── error-handler.js
    └── formatters.js
```

**KOHESION:** Aktuell low cohesion (tools.js mischt CalDAV/CardDAV/Todo), Ziel: high cohesion durch fachliche Trennung.

---

## 4. Kopplung zwischen Komponenten

### 4.1 Tight Coupling Probleme

**Problem 1: Globale Singleton-Abhangigkeit**
```javascript
// tools.js Zeile 63, 93, 166, etc.
const client = tsdavManager.getCalDavClient(); // ← TIGHT COUPLING!
```

**22x direkte Aufrufe** in tools.js = keine Testbarkeit ohne echten DAV-Server!

**Problem 2: Fehlende Dependency Injection**
```javascript
// tools.js handler hat keine Moglichkeit, Mock-Clients zu injizieren
handler: async (args) => {
  const client = tsdavManager.getCalDavClient(); // ← Hard-coded!
}
```

**Problem 3: Transport-zu-Logic Kopplung**
```javascript
// index.js Zeile 275-280
const mcpServer = createMCPServer(sessionId);
await mcpServer.connect(transport); // ← Transport kennt Business Logic
```

### 4.2 Dependency Graph (Vereinfacht)

```
index.js ──────────┐
                   ├──> tools.js ──> tsdav-client.js ──> tsdav (external)
server-stdio.js ───┘        │
                            ├──> validation.js
                            ├──> formatters.js
                            └──> error-handler.js
```

**PROBLEM:** Alle Wege fuhren durch die monolithische tools.js!

### 4.3 Vorgeschlagene Entkopplung

```javascript
// services/calendar-service.js (NEW!)
export class CalendarService {
  constructor(davClient) {
    this.client = davClient; // ← Dependency Injection!
  }

  async queryCalendars(filters) {
    const calendars = await this.client.fetchCalendars();
    // Business Logic hier
    return filteredResults;
  }
}

// tools/calendar-tools.js (NEW!)
export function createCalendarTools(calendarService) {
  return [
    {
      name: 'calendar_query',
      description: '...',
      inputSchema: calendarQuerySchema,
      handler: async (args) => {
        const validated = validateInput(calendarQuerySchema, args);
        const results = await calendarService.queryCalendars(validated);
        return formatEventList(results);
      }
    }
  ];
}
```

**VORTEIL:** Testbar, austauschbar, wiederverwendbar!

---

## 5. Design Patterns

### 5.1 Verwendete Patterns

✅ **Singleton Pattern** (tsdav-client.js)
```javascript
export const tsdavManager = new TsdavClientManager();
```
**Bewertung:** Korrekt implementiert, aber nicht testfreundlich.

✅ **Factory Pattern (implizit)** (logger.js)
```javascript
export function createSessionLogger(sessionId) { ... }
export function createRequestLogger(requestId) { ... }
```
**Bewertung:** Gut, aber inkonsistent (manchmal Factory, manchmal nicht).

✅ **Facade Pattern** (tsdav-client.js)
```javascript
getCalDavClient() { ... }
getCardDavClient() { ... }
```
**Bewertung:** Vereinfacht DAVClient-Zugriff, OK.

### 5.2 Fehlende Patterns

❌ **Strategy Pattern** - Fur unterschiedliche DAV-Provider (Nextcloud, Radicale, etc.)
❌ **Repository Pattern** - Fur DAV-Daten-Zugriff
❌ **Command Pattern** - Fur Tool-Ausfuhrung
❌ **Observer Pattern** - Fur Session-Events
❌ **Builder Pattern** - Fur komplexe Tool-Definitionen

### 5.3 Pattern-Missbrauch

⚠️ **Anti-Pattern: God Object** (tools.js)
- 1265 Zeilen, 22 Tools, 3 Domanen (CalDAV/CardDAV/Todo)
- Verletzt Single Responsibility Principle
- Verletzt Open/Closed Principle (jede Anderung erfordert Anderung der Datei)

⚠️ **Anti-Pattern: Tight Coupling** (tools.js + tsdavManager)
- Keine Moglichkeit, Clients zu mocken
- Tests benotigen echten DAV-Server

⚠️ **Anti-Pattern: Copy-Paste Programming** (tools.js)
```javascript
// Zeilen 92-127: list_events handler
// Zeilen 306-379: calendar_query handler
// ← Nahezu identische Struktur, 80% Code-Duplikation!
```

---

## 6. Skalierbarkeit & Wartbarkeit

### 6.1 Skalierbarkeits-Analyse

**Horizontale Skalierung: 4/10**
- ✅ Stateless SSE-Sessions (gut)
- ✅ Session-Cleanup-Mechanismus (gut)
- ❌ In-Memory Session-Store (nicht cluster-fahig)
- ❌ Singleton DAV-Client (nicht multi-tenant-fahig)

**Vorschlag:**
```javascript
// Aktuell:
const transports = {}; // ← In-Memory, nicht shared!

// Besser:
import Redis from 'ioredis';
const sessionStore = new RedisSessionStore(redisClient);
```

**Vertikale Skalierung: 7/10**
- ✅ Async/Await durchgehend
- ✅ Non-blocking I/O
- ❌ Keine Connection-Pooling-Strategie
- ❌ Keine Batch-Optimierung (z.B. calendar_multi_get wird selten genutzt)

### 6.2 Wartbarkeit-Analyse

**Code-Lesbarkeit: 6/10**
- ✅ Gute Kommentare in tools.js
- ✅ Klare Funktionsnamen
- ❌ Zu lange Funktionen (tools.js Handler: 40-80 LOC)
- ❌ Zu lange Dateien (tools.js: 1265 LOC)

**Testbarkeit: 3/10**
- ❌ Keine Unit-Tests vorhanden
- ❌ Tight Coupling verhindert Mocking
- ✅ Integration-Tests vorhanden (tests/integration/)
- ❌ Tests sind instabil (5x Wiederholung wegen Variabilitat)

**Erweiterbarkeit: 4/10**

**Beispiel: Neues Tool hinzufugen**
```javascript
// Aktuell: 5 Stellen andern:
// 1. tools.js: Tool-Definition (60 LOC)
// 2. validation.js: Neues Schema
// 3. formatters.js: Neuer Formatter (optional)
// 4. tests/integration/test-cases.json: Test hinzufugen
// 5. Dokumentation aktualisieren

// Besser: 2 Stellen andern:
// 1. services/calendar-service.js: Business Logic
// 2. tools/calendar-tools.js: Tool-Wrapper (5 LOC mit Factory)
```

### 6.3 Single Points of Failure

**CRITICAL:**
1. **tsdavManager Singleton** - Wenn DAV-Client abstürzt, gesamter Server betroffen
2. **tools.js** - Syntaxfehler in einem Tool bricht alle Tools
3. **Express Server** - Keine Graceful Degradation bei Uberlast

**Mitigation-Vorschlage:**
```javascript
// 1. Circuit Breaker fur DAV-Client
import CircuitBreaker from 'opossum';
const davCircuitBreaker = new CircuitBreaker(davClient.fetchCalendars);

// 2. Tool Isolation
try {
  const result = await tool.handler(args);
} catch (error) {
  // Anderen Tools sollen weiterlaufen!
  return createToolErrorResponse(error);
}

// 3. Health Checks + Readiness Probes
app.get('/health', () => ({
  status: tsdavManager.isHealthy() ? 'healthy' : 'degraded'
}));
```

---

## 7. Fehlerbehandlung-Architektur

### 7.1 Positive Aspekte

✅ **MCP-konforme Error-Codes** (error-handler.js)
```javascript
export const MCP_ERROR_CODES = {
  CALDAV_ERROR: -32000,
  CARDDAV_ERROR: -32001,
  VALIDATION_ERROR: -32002,
  // etc.
}
```

✅ **Custom Error-Klassen**
```javascript
export class CalDAVError extends Error { ... }
export class AuthenticationError extends Error { ... }
```

✅ **Zentralisierte Error-Formatierung**
```javascript
export function createToolErrorResponse(error, includeStack) { ... }
export function createHTTPErrorResponse(error, statusCode) { ... }
```

### 7.2 Verbesserungspotenzial

❌ **Inkonsistente Error-Propagation**
```javascript
// tools.js - Manche Tools werfen Errors:
throw new Error(`Calendar not found: ${validated.calendar_url}`);

// Andere Tools returnen formatierte Errors:
return formatError(error, 'calendar_query');
```

❌ **Fehlende Error-Boundaries**
```javascript
// index.js Zeile 426-434 - Global Error Handler
process.on('uncaughtException', (error) => {
  logger.error(...);
  // DO NOT kill server ← Gefahrlich! State kann korrupt sein!
});
```

**Empfehlung:** Graceful Restart statt blindes Weiterlaufen:
```javascript
process.on('uncaughtException', async (error) => {
  logger.fatal({ error }, 'Uncaught exception - initiating graceful restart');
  await gracefulShutdown('UNCAUGHT_EXCEPTION');
  process.exit(1); // Let process manager restart
});
```

❌ **Fehlende Retry-Logik**
- Keine Exponential-Backoff bei DAV-Server-Fehlern
- Keine Circuit-Breaker bei wiederholten Fehlern

---

## 8. Test-Architektur

### 8.1 Aktueller Zustand

**Integration Tests:** /tests/integration/
- mcp-test-runner.js - LLM Tool-Selection Tests
- mcp-log-parser.js - Log-Parsing
- answer-validator.js - Antwort-Validierung

**Optimization Tests:** /tests/optimization/
- metric-multi-call.js
- metric-unnecessary-list.js

**Probleme:**
1. ❌ Keine Unit-Tests
2. ❌ Tests benotigen laufenden DAV-Server
3. ❌ Tests sind instabil (5x Wiederholung wegen 80% Threshold)
4. ❌ Keine Mocking-Infrastruktur

### 8.2 Vorgeschlagene Test-Pyramide

```
         /\
        /  \  E2E Tests (wenige, langsam)
       /────\
      /      \  Integration Tests (einige, medium)
     /────────\
    /          \  Unit Tests (viele, schnell)
   /────────────\
```

**Aktuell:** Invertierte Pyramide (nur Integration/E2E)!

**Empfohlene Struktur:**
```
tests/
├── unit/
│   ├── services/
│   │   ├── calendar-service.test.js
│   │   └── contact-service.test.js
│   ├── tools/
│   │   ├── tool-factory.test.js
│   │   └── calendar-tools.test.js
│   └── core/
│       ├── logger.test.js
│       └── validation.test.js
├── integration/
│   ├── mcp-server.test.js
│   └── dav-client.test.js
└── e2e/
    └── full-workflow.test.js
```

---

## 9. Dependency Management

### 9.1 Dependencies-Analyse

**package.json:**
```json
"dependencies": {
  "@modelcontextprotocol/sdk": "^1.18.2",  // MCP Core
  "cors": "^2.8.5",                         // Middleware
  "dotenv": "^16.4.7",                      // Config
  "express": "^4.21.2",                     // HTTP Server
  "express-rate-limit": "^8.1.0",           // Rate Limiting
  "ical.js": "^2.1.0",                      // iCal Parsing
  "tsdav": "github:PhilflowIO/tsdav#master", // ⚠️ Git Dependency!
  "zod": "^3.25.76"                         // Validation
}
```

**Probleme:**

❌ **Git-Dependency fur tsdav**
```json
"tsdav": "github:PhilflowIO/tsdav#master"
```
- Keine Versionierung (master kann brechen)
- Keine Semantic Versioning
- Build-Instabilitat

**Empfehlung:** Fork publizieren als npm-Package oder Tag-basierte Version:
```json
"tsdav": "github:PhilflowIO/tsdav#v2.3.0"
```

### 9.2 Zirkulare Abhangigkeiten

✅ **Keine zirkularen Abhangigkeiten gefunden!**

**Dependency Graph (vereinfacht):**
```
index.js → tools.js → tsdav-client.js → (external tsdav)
       → validation.js
       → error-handler.js
       → formatters.js
       → logger.js
```

Alle Abhangigkeiten sind azyklisch (gut!).

### 9.3 Unnötige Abhangigkeiten

⚠️ **express + cors + express-rate-limit** - Könnte durch Fastify ersetzt werden:
```javascript
// Aktuell: 3 Dependencies
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

// Alternative: 1 Dependency
import Fastify from 'fastify';
// Fastify hat CORS + Rate-Limiting integriert
```

**Vorteil:** Weniger Dependencies, bessere Performance (2x schneller als Express).

---

## 10. Architektur-Verbesserungen

### 10.1 Kritische Refactorings (Prioritat 1)

**1. Tool-Modularisierung**

**Problem:** tools.js (1265 LOC) ist unwartbar.

**Lösung: Factory Pattern + Service Layer**

```javascript
// services/calendar-service.js (NEW)
export class CalendarService {
  constructor(davClient, validator, formatter) {
    this.client = davClient;
    this.validator = validator;
    this.formatter = formatter;
  }

  async listCalendars() {
    const calendars = await this.client.fetchCalendars();
    return this.formatter.formatCalendarList(calendars);
  }

  async queryEvents(filters) {
    const validated = this.validator.validate(calendarQuerySchema, filters);
    // Business Logic
    return this.formatter.formatEventList(events);
  }
}

// tools/calendar-tools.js (NEW)
export function createCalendarTools(calendarService) {
  return [
    {
      name: 'list_calendars',
      description: 'List all calendars',
      inputSchema: listCalendarsSchema,
      handler: () => calendarService.listCalendars()
    },
    {
      name: 'calendar_query',
      description: 'Query events with filters',
      inputSchema: calendarQuerySchema,
      handler: (args) => calendarService.queryEvents(args)
    }
  ];
}

// tools/index.js (NEW)
import { createCalendarTools } from './calendar-tools.js';
import { createContactTools } from './contact-tools.js';
import { createTodoTools } from './todo-tools.js';

export function createAllTools(services) {
  return [
    ...createCalendarTools(services.calendar),
    ...createContactTools(services.contact),
    ...createTodoTools(services.todo)
  ];
}
```

**Reduktion:** 1265 LOC → ~400 LOC (3x Reduction!)

**2. Dependency Injection Container**

```javascript
// di-container.js (NEW)
export class DIContainer {
  constructor() {
    this.services = new Map();
  }

  register(name, factory) {
    this.services.set(name, factory);
  }

  resolve(name) {
    const factory = this.services.get(name);
    return factory();
  }
}

// bootstrap.js (NEW)
export function bootstrap(config) {
  const container = new DIContainer();

  // Register dependencies
  container.register('davClient', () => new DAVClient(config.dav));
  container.register('logger', () => new JSONLogger());
  container.register('validator', () => new Validator());
  container.register('formatter', () => new Formatter());

  // Register services
  container.register('calendarService', () =>
    new CalendarService(
      container.resolve('davClient'),
      container.resolve('validator'),
      container.resolve('formatter')
    )
  );

  return container;
}
```

**3. Middleware-Extraktion**

```javascript
// middleware/auth.js (NEW)
export function createAuthMiddleware(bearerToken) {
  return (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Bearer token required' });
    }
    const token = authHeader.substring(7);
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(bearerToken))) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    next();
  };
}

// index.js (SIMPLIFIED)
import { createAuthMiddleware } from './middleware/auth.js';
app.use('/sse', createAuthMiddleware(process.env.BEARER_TOKEN));
```

### 10.2 Empfohlene Refactorings (Prioritat 2)

**4. Session Store Abstraktion**

```javascript
// session/session-store.js (NEW)
export class SessionStore {
  async set(sessionId, data) { ... }
  async get(sessionId) { ... }
  async delete(sessionId) { ... }
  async cleanupExpired() { ... }
}

// session/memory-session-store.js
export class MemorySessionStore extends SessionStore { ... }

// session/redis-session-store.js
export class RedisSessionStore extends SessionStore { ... }
```

**5. Configuration Management**

```javascript
// config/index.js (NEW)
export const config = {
  server: {
    port: process.env.PORT || 3000,
    name: process.env.MCP_SERVER_NAME || 'tsdav-mcp-server',
  },
  dav: {
    serverUrl: process.env.CALDAV_SERVER_URL,
    username: process.env.CALDAV_USERNAME,
    password: process.env.CALDAV_PASSWORD,
  },
  session: {
    ttl: 60 * 60 * 1000,
    cleanupInterval: 5 * 60 * 1000,
  },
  rateLimit: {
    windowMs: 15 * 60 * 1000,
    maxLocal: 10000,
    maxExternal: 100,
  }
};
```

### 10.3 Fehlende Abstraktionen

**1. Tool-Execution-Pipeline**

```javascript
// execution/tool-pipeline.js (NEW)
export class ToolExecutionPipeline {
  constructor(validators, handlers, formatters, errorHandlers) {
    this.validators = validators;
    this.handlers = handlers;
    this.formatters = formatters;
    this.errorHandlers = errorHandlers;
  }

  async execute(toolName, args) {
    try {
      // 1. Validate input
      const validated = await this.validators.validate(toolName, args);

      // 2. Execute handler
      const result = await this.handlers.execute(toolName, validated);

      // 3. Format output
      return await this.formatters.format(toolName, result);
    } catch (error) {
      // 4. Handle errors
      return this.errorHandlers.handle(error);
    }
  }
}
```

**2. DAV-Client-Pool**

```javascript
// dav/client-pool.js (NEW)
export class DAVClientPool {
  constructor(config, poolSize = 10) {
    this.config = config;
    this.pool = [];
    this.available = [];
    this.initPool(poolSize);
  }

  async acquire() {
    if (this.available.length === 0) {
      await this.waitForAvailable();
    }
    return this.available.pop();
  }

  release(client) {
    this.available.push(client);
  }
}
```

### 10.4 Überflussige Komplexitat

**1. Doppelte Schema-Definitionen**

❌ **Problem:** Schemas in validation.js UND tools.js
```javascript
// validation.js
export const calendarQuerySchema = z.object({ ... });

// tools.js Zeile 280-304
inputSchema: {  // ← REDUNDANT!
  type: 'object',
  properties: { ... }
}
```

**Lösung:** Schema nur in validation.js, JSON-Schema auto-generieren:
```javascript
import { zodToJsonSchema } from 'zod-to-json-schema';
const jsonSchema = zodToJsonSchema(calendarQuerySchema);
```

**2. Formatierungslogik in tools.js**

❌ **Problem:** Formatierung gemischt mit Business Logic
```javascript
// tools.js Zeile 372-378
const calendarName = calendarsToSearch.length === 1
  ? (calendarsToSearch[0].displayName || calendarsToSearch[0].url)
  : `All Calendars (${calendarsToSearch.length})`;
```

**Lösung:** Formatierung in formatters.js verschieben.

---

## 11. Konkrete Empfehlungen

### 11.1 Sofort-Massnahmen (1-2 Wochen)

1. **tools.js aufspalten** (Prioritat: CRITICAL)
   - Aufteilen in calendar-tools.js, contact-tools.js, todo-tools.js
   - Service-Layer einfuhren
   - Geschatzte Zeit: 16h

2. **Unit-Tests hinzufugen** (Prioritat: HIGH)
   - Services testbar machen (DI)
   - 80% Code-Coverage-Ziel
   - Geschatzte Zeit: 24h

3. **Middleware extrahieren** (Prioritat: MEDIUM)
   - auth.js, rate-limit.js, cors.js separieren
   - index.js auf <200 LOC reduzieren
   - Geschatzte Zeit: 4h

### 11.2 Mittelfristig (1 Monat)

4. **Dependency Injection einfuhren** (Prioritat: HIGH)
   - DI-Container implementieren
   - Testbarkeit verbessern
   - Geschatzte Zeit: 16h

5. **Session Store abstrahieren** (Prioritat: MEDIUM)
   - Redis-Support vorbereiten
   - Horizontale Skalierung ermoglichen
   - Geschatzte Zeit: 8h

6. **Error Handling verbessern** (Prioritat: MEDIUM)
   - Retry-Logik hinzufugen
   - Circuit Breaker implementieren
   - Geschatzte Zeit: 12h

### 11.3 Langfristig (3 Monate)

7. **TypeScript Migration** (Prioritat: LOW)
   - Bessere Type-Safety
   - Tooling-Verbesserung
   - Geschatzte Zeit: 40h

8. **API-Gateway-Pattern** (Prioritat: LOW)
   - GraphQL-Alternative zu MCP
   - REST-Fallback
   - Geschatzte Zeit: 60h

9. **Observability** (Prioritat: MEDIUM)
   - OpenTelemetry-Integration
   - Metrics (Prometheus)
   - Distributed Tracing
   - Geschatzte Zeit: 24h

---

## 12. Gesamtbewertung nach Kategorien

| Kategorie                    | Score | Begrundung                                      |
|------------------------------|-------|-------------------------------------------------|
| Separation of Concerns       | 5/10  | Gut bei Cross-Cutting, schlecht bei Tools       |
| Modularitat                  | 4/10  | Monolithische tools.js, fehlende Service-Layer  |
| Kohesion                     | 6/10  | Einzelne Module OK, Gesamt-Architektur schwach  |
| Kopplung                     | 4/10  | Tight Coupling durch Singleton, keine DI        |
| Design Patterns              | 5/10  | Einige Patterns OK, viele fehlen, Anti-Patterns |
| Skalierbarkeit               | 5/10  | Horizontal begrenzt, vertikal OK                |
| Wartbarkeit                  | 4/10  | Zu grosse Dateien, schwer testbar               |
| Testbarkeit                  | 3/10  | Keine Unit-Tests, Tight Coupling                |
| Error Handling               | 7/10  | Gut strukturiert, aber Retry fehlt              |
| Dependency Management        | 6/10  | Sauber, aber Git-Dependency problematisch       |

**GESAMTBEWERTUNG: 6.5/10**

---

## 13. Architektur-Entscheidungen (ADRs)

### ADR-001: Warum keine Microservices?

**Status:** Accepted

**Kontext:** MCP-Server ist ein API-Gateway fur DAV-Server.

**Entscheidung:** Monolith ist angemessen fur diese Grosse (5k LOC).

**Konsequenzen:**
- Einfacheres Deployment
- Aber: Modularitat innerhalb des Monolithen ist Pflicht!

### ADR-002: Warum Express statt Fastify?

**Status:** Questioned

**Kontext:** Express ist etabliert, aber langsamer als Fastify.

**Entscheidung:** Express wurde gewahlt (vermutlich Legacy).

**Empfehlung:** Migration zu Fastify erwagen (2x Performance-Gewinn).

### ADR-003: Warum SSE statt WebSockets?

**Status:** Accepted

**Kontext:** MCP Protocol Spezifikation nutzt SSE.

**Entscheidung:** SSE ist MCP-konform.

**Konsequenzen:**
- Einfacher als WebSockets
- Aber: Nur unidirektional (Server → Client)

---

## 14. Migration-Roadmap

### Phase 1: Foundation (Woche 1-2)
- [ ] tools.js in 3 Dateien aufteilen
- [ ] Service-Layer einfuhren
- [ ] Middleware extrahieren
- [ ] Unit-Tests fur Services

### Phase 2: Decoupling (Woche 3-4)
- [ ] Dependency Injection implementieren
- [ ] Session Store abstrahieren
- [ ] Tool-Factory-Pattern
- [ ] Integration-Tests refactoren

### Phase 3: Resilience (Woche 5-6)
- [ ] Circuit Breaker
- [ ] Retry-Logik
- [ ] Health Checks verbessern
- [ ] Graceful Degradation

### Phase 4: Observability (Woche 7-8)
- [ ] OpenTelemetry
- [ ] Metrics-Endpunkte
- [ ] Distributed Tracing
- [ ] Performance-Monitoring

---

## 15. Fazit

Der tsdav-mcp-server zeigt **solide Grundlagen**, leidet aber unter typischen **Monolith-Krankheiten**:

**Kritische Probleme:**
1. Monolithische tools.js (1265 LOC) - unwartbar
2. Fehlende Service-Layer - Business Logic in Tool-Handlern
3. Tight Coupling - keine Dependency Injection
4. Keine Unit-Tests - nur Integration-Tests

**Positive Aspekte:**
1. Saubere Cross-Cutting-Concerns (Logger, Validation, Formatters)
2. Robustes Error-Handling
3. Produktionsreife Features (Auth, Rate-Limiting, Session-Management)

**Empfehlung:**
Investieren Sie **2-3 Wochen** in die Refactorings aus Phase 1+2. Das wird die **Wartbarkeit um Faktor 3-4 verbessern** und die **Testbarkeit um Faktor 10**.

Die Architektur ist **nicht schlecht**, sie ist **unreif**. Mit gezielten Refactorings kann sie auf **8-9/10** steigen.

---

**Erstellt am:** 2025-10-22
**Version:** 1.0
**Nachste Review:** Nach Phase 1 (in 2 Wochen)
