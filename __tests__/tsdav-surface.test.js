import { describe, test, expect } from '@jest/globals';
import { DAVClient, makeAddressBook } from 'tsdav';

// tsdav is installed from a git branch, so what a consumer gets is whatever
// dist/ happened to be committed at that ref. A sync from upstream once
// overwrote dist/ with a build that had no VTODO surface, which silently killed
// six of the eight todo tools for everyone installing from npm while working
// fine for anyone whose lockfile still pinned the older commit. This test makes
// that failure loud at install time instead. See issue #41.
describe('the tsdav build we install actually exposes what we call', () => {
  const clientMethods = [
    'fetchTodos',
    'todoQuery',
    'todoMultiGet',
    'createTodo',
    'updateTodo',
    'deleteTodo',
    'fetchCalendars',
    'fetchCalendarObjects',
    'createCalendarObject',
    'updateCalendarObject',
    'deleteCalendarObject',
    'fetchAddressBooks',
    'fetchVCards',
    'createVCard',
    'updateVCard',
    'deleteVCard',
    'deleteObject',
  ];

  test.each(clientMethods)('DAVClient.prototype.%s is a function', (method) => {
    expect(typeof DAVClient.prototype[method]).toBe('function');
  });

  test('makeAddressBook is exported', () => {
    // lost in the same upstream sync that dropped the todo API
    expect(typeof makeAddressBook).toBe('function');
  });
});
