/**
 * Where a log line may go without corrupting the protocol.
 *
 * Under the stdio transport, stdout carries JSON-RPC and nothing else, so a log
 * line written there breaks the client's parser. Both loggers share this one
 * decision so that neither can drift away from it.
 */

// Read per call rather than at module load: the transport is set from the
// environment, and tests need to exercise both modes in one process.
export function isStdioMode() {
  return process.env.MCP_TRANSPORT === 'stdio';
}

/**
 * Write one line to the safe sink for the current transport.
 */
export function writeLogLine(line) {
  if (isStdioMode()) {
    process.stderr.write(line + '\n');
  } else {
    console.log(line);
  }
}
