import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { writeLogLine } from '../src/log-sink.js';

describe('logging never writes to stdout under the stdio transport', () => {
  let stdoutSpy;
  let stderrSpy;
  const previousTransport = process.env.MCP_TRANSPORT;

  beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.env.MCP_TRANSPORT = previousTransport;
  });

  test('stdio mode goes to stderr', () => {
    process.env.MCP_TRANSPORT = 'stdio';
    writeLogLine('{"type":"tool_call_start"}');
    expect(stderrSpy).toHaveBeenCalled();
    expect(stdoutSpy).not.toHaveBeenCalled();
  });

  test('other transports may use stdout', () => {
    process.env.MCP_TRANSPORT = 'http';
    writeLogLine('{"type":"tool_call_start"}');
    // console.log writes through process.stdout
    expect(stdoutSpy).toHaveBeenCalled();
  });

  test('the tool call logger honours it in console mode', async () => {
    process.env.MCP_TRANSPORT = 'stdio';
    const { initializeToolCallLogger } = await import('../src/tool-call-logger.js');
    initializeToolCallLogger({ outputMode: 'console', enabled: true })
      .logToolCallStart('list_calendars', {});
    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalled();
  });
});
