/**
 * The tool-call log records full tool arguments: event titles, attendees,
 * contact data. It stays off unless asked for, and when on it lands in a
 * per-user file only its owner can read (#88).
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { initializeToolCallLogger, defaultToolCallLogFile } from '../src/tool-call-logger.js';

const saved = { ...process.env };
let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dav-mcp-log-'));
  delete process.env.LOG_TOOL_CALLS;
  delete process.env.TOOL_CALL_LOG_MODE;
  process.env.TOOL_CALL_LOG_FILE = path.join(dir, 'nested', 'calls.jsonl');
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tool-call log', () => {
  test('writes nothing unless LOG_TOOL_CALLS=true', () => {
    for (const value of [undefined, 'false', '1', 'yes']) {
      if (value === undefined) delete process.env.LOG_TOOL_CALLS;
      else process.env.LOG_TOOL_CALLS = value;
      initializeToolCallLogger().logToolCallStart('create_contact', { full_name: 'Ada Lovelace' });
    }
    expect(fs.existsSync(path.join(dir, 'nested'))).toBe(false);
  });

  test('when enabled, the file is readable by its owner only', () => {
    process.env.LOG_TOOL_CALLS = 'true';
    initializeToolCallLogger().logToolCallStart('create_contact', { full_name: 'Ada Lovelace' });

    const file = process.env.TOOL_CALL_LOG_FILE;
    expect(fs.readFileSync(file, 'utf8')).toContain('Ada Lovelace');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  test('an existing log file is narrowed to its owner before anything is written', () => {
    if (process.platform === 'win32') return;
    const file = process.env.TOOL_CALL_LOG_FILE;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '', { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    process.env.LOG_TOOL_CALLS = 'true';
    initializeToolCallLogger();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  test('reports whether it is on, and where it writes', () => {
    expect(initializeToolCallLogger().describe()).toEqual({ enabled: false });
    process.env.LOG_TOOL_CALLS = 'true';
    expect(initializeToolCallLogger().describe())
      .toEqual({ enabled: true, mode: 'file', file: process.env.TOOL_CALL_LOG_FILE });
  });

  test('the default location is per user, never a shared temp directory', () => {
    const home = os.homedir();
    expect(defaultToolCallLogFile({}, 'linux'))
      .toBe(path.join(home, '.local', 'state', 'dav-mcp', 'tool-calls.jsonl'));
    expect(defaultToolCallLogFile({ XDG_STATE_HOME: '/x/state' }, 'linux'))
      .toBe(path.join('/x/state', 'dav-mcp', 'tool-calls.jsonl'));
    expect(defaultToolCallLogFile({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' }, 'win32'))
      .toBe(path.join('C:\\Users\\a\\AppData\\Local', 'dav-mcp', 'tool-calls.jsonl'));
    expect(defaultToolCallLogFile({}, 'linux').startsWith(os.tmpdir())).toBe(false);
  });
});
