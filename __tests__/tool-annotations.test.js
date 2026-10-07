/**
 * Every tool declares MCP tool annotations. Claude uses them to decide which
 * calls run without asking (read-only) and which always ask (destructive),
 * and the Claude directory rejects tools without a title and those hints.
 * A tool added without them fails here, not in review.
 */

import { describe, test, expect } from '@jest/globals';
import { tools } from '../src/tools/index.js';

// The verb a tool name starts with says what it does to the user's data.
const READ = /^(list|get)_|_query$|_multi_get$/;
const DELETE = /^delete_/;
const MODIFY = /^update_/;
const CREATE = /^(create|make)_/;

describe.each(tools.map(t => [t.name, t]))('%s', (name, tool) => {
  const a = tool.annotations;

  test('has a short human-readable title', () => {
    expect(typeof a?.title).toBe('string');
    expect(a.title.length).toBeGreaterThan(0);
    expect(a.title.length).toBeLessThanOrEqual(64);
  });

  test('declares every hint explicitly', () => {
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      expect(typeof a[hint]).toBe('boolean');
    }
  });

  test('hints match what the tool does to the user\'s data', () => {
    const kind = [READ, DELETE, MODIFY, CREATE].filter(re => re.test(name));
    expect(kind).toHaveLength(1);

    if (READ.test(name)) {
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
    } else if (CREATE.test(name)) {
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(false);
      expect(a.idempotentHint).toBe(false);
    } else {
      // updates overwrite stored values, deletes remove them
      expect(a.readOnlyHint).toBe(false);
      expect(a.destructiveHint).toBe(true);
    }
  });

  test('talks to the user\'s DAV server, an open world', () => {
    expect(a.openWorldHint).toBe(true);
  });
});

test('tool names fit the 64-character limit', () => {
  for (const { name } of tools) expect(name.length).toBeLessThanOrEqual(64);
});
