/**
 * MCP Tools Main Index
 * Combines all tool modules into a single exportable array
 */

// Calendar Tools (CalDAV)
import * as calendarTools from './calendar/index.js';

// Contact Tools (CardDAV)
import * as contactTools from './contacts/index.js';

// Todo Tools (VTODO)
import * as todoTools from './todos/index.js';

/**
 * All available MCP tools
 * Total: 27 tools organized in 3 categories
 */
export const tools = [
  // ================================
  // CALENDAR TOOLS (12 tools)
  // ================================
  calendarTools.listCalendars,
  calendarTools.listEvents,
  calendarTools.createEvent,
  calendarTools.updateEventFields,
  calendarTools.updateEventRaw,
  calendarTools.deleteEvent,
  calendarTools.calendarQuery,
  calendarTools.freeBusyQuery,
  calendarTools.makeCalendar,
  calendarTools.updateCalendar,
  calendarTools.deleteCalendar,
  calendarTools.calendarMultiGet,

  // ================================
  // CONTACT TOOLS (8 tools)
  // ================================
  contactTools.listAddressbooks,
  contactTools.listContacts,
  contactTools.createContact,
  contactTools.updateContactFields,
  contactTools.updateContactRaw,
  contactTools.deleteContact,
  contactTools.addressbookQuery,
  contactTools.addressbookMultiGet,

  // ================================
  // TODO TOOLS (7 tools)
  // ================================
  todoTools.listTodos,
  todoTools.createTodo,
  todoTools.updateTodoFields,
  todoTools.updateTodoRaw,
  todoTools.deleteTodo,
  todoTools.todoQuery,
  todoTools.todoMultiGet,
];

/**
 * The tools/list entry for a tool: everything the client sees, without the
 * handler. Both transports answer tools/list with this, so a field added to
 * the tool definitions reaches every client the same way.
 */
export const toListedTool = ({ name, description, inputSchema, annotations }) => ({
  name,
  description,
  inputSchema,
  annotations,
});
