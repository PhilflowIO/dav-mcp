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
 * Total: 23 tools organized in 3 categories
 */
export const tools = [
  // ================================
  // CALENDAR TOOLS (10 tools)
  // ================================
  calendarTools.listCalendars,
  calendarTools.listEvents,
  calendarTools.createEvent,
  calendarTools.updateEvent,
  calendarTools.deleteEvent,
  calendarTools.calendarQuery,
  calendarTools.makeCalendar,
  calendarTools.updateCalendar,
  calendarTools.deleteCalendar,
  calendarTools.calendarMultiGet,

  // ================================
  // CONTACT TOOLS (7 tools)
  // ================================
  contactTools.listAddressbooks,
  contactTools.listContacts,
  contactTools.createContact,
  contactTools.updateContact,
  contactTools.deleteContact,
  contactTools.addressbookQuery,
  contactTools.addressbookMultiGet,

  // ================================
  // TODO TOOLS (6 tools)
  // ================================
  todoTools.listTodos,
  todoTools.createTodo,
  todoTools.updateTodo,
  todoTools.deleteTodo,
  todoTools.todoQuery,
  todoTools.todoMultiGet,
];
