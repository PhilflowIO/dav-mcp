#!/usr/bin/env node
/**
 * dav-mcp - Main Entry Point
 *
 * Supports two modes:
 *   - STDIO (default): For local clients (Claude Desktop, Cursor, VS Code)
 *   - HTTP (--http flag): For remote clients (n8n, cloud deployments)
 *
 * Usage:
 *   npx dav-mcp              # STDIO mode (default)
 *   npx dav-mcp --http       # HTTP mode on port 3000
 *   npx dav-mcp --http --port=8080  # HTTP mode on custom port
 *
 * Configuration via environment variables:
 *   - CALDAV_SERVER_URL: CalDAV server URL
 *   - CALDAV_USERNAME: Username for Basic/Digest Auth
 *   - CALDAV_PASSWORD: Password for Basic/Digest Auth
 *   - AUTH_METHOD: 'Basic' (default), 'Digest' or 'OAuth' (case-insensitive)
 *   - BEARER_TOKEN: Required for HTTP mode
 *
 * For OAuth2 (Google Calendar):
 *   - GOOGLE_SERVER_URL: Google CalDAV URL
 *   - GOOGLE_USER: Google account email
 *   - GOOGLE_CLIENT_ID: OAuth2 client ID
 *   - GOOGLE_CLIENT_SECRET: OAuth2 client secret
 *   - GOOGLE_REFRESH_TOKEN: OAuth2 refresh token
 */

// Parse CLI arguments BEFORE any imports
const args = process.argv.slice(2);
const isHttpMode = args.includes('--http');
const portArg = args.find(a => a.startsWith('--port='));

if (isHttpMode) {
  // HTTP mode - set port and load HTTP server
  if (portArg) {
    process.env.PORT = portArg.split('=')[1];
  }
  // Dynamic import of HTTP server (it will start itself)
  import('./server-http.js');
} else {
  // STDIO mode - run STDIO server
  startStdioServer();
}

async function startStdioServer() {
  // Set STDIO mode BEFORE importing logger
  process.env.MCP_TRANSPORT = 'stdio';

  const dotenv = await import('dotenv');
  const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
  const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
  const { ListToolsRequestSchema, CallToolRequestSchema } = await import('@modelcontextprotocol/sdk/types.js');

  const { tsdavManager } = await import('./tsdav-client.js');
  const { buildTsdavConfig } = await import('./auth-config.js');
  const { tools, toListedTool } = await import('./tools/index.js');
  const { createToolErrorResponse, MCP_ERROR_CODES } = await import('./error-handler.js');
  const { logger } = await import('./logger.js');
  const { initializeToolCallLogger, getToolCallLogger } = await import('./tool-call-logger.js');
  const { SERVER_NAME, SERVER_VERSION } = await import('./server-info.js');

  // Load environment variables. quiet: true because dotenv otherwise prints a
  // banner to STDOUT, which under this transport is the JSON-RPC channel — a
  // strict client fails to parse the first message.
  dotenv.default.config({ quiet: true });

  /**
   * Initialize tsdav clients based on auth method
   */
  async function initializeTsdav() {
    logger.info({ configuredAuthMethod: tsdavConfig.authMethod }, 'Initializing tsdav clients');
    await tsdavManager.initialize(tsdavConfig);
  }

  /**
   * Create MCP Server with tool handlers
   */
  function createMCPServer(ensureInit) {
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register tools/list handler
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      logger.debug({ count: tools.length }, 'tools/list request received');
      return {
        tools: tools.map(toListedTool),
      };
    });

    // Register tools/call handler
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const toolArgs = request.params.arguments || {};
      const toolCallLogger = getToolCallLogger();

      logger.info({ tool: toolName }, 'tools/call request received');

      const tool = tools.find(t => t.name === toolName);
      if (!tool) {
        logger.error({ tool: toolName }, 'Tool not found');
        const error = new Error(`Unknown tool: ${toolName}`);
        error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
        throw error;
      }

      // Ensure DAV clients are initialized before executing any tool
      await ensureInit();

      const startTime = Date.now();
      toolCallLogger.logToolCallStart(toolName, toolArgs, { transport: 'stdio' });

      try {
        logger.debug({ tool: toolName }, 'Executing tool');
        const result = await tool.handler(toolArgs);
        const duration = Date.now() - startTime;

        logger.info({ tool: toolName, duration }, 'Tool executed successfully');
        toolCallLogger.logToolCallSuccess(toolName, toolArgs, result, {
          transport: 'stdio',
          duration,
        });

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        logger.error({ tool: toolName, error: error.message }, 'Tool execution error');
        toolCallLogger.logToolCallError(toolName, toolArgs, error, {
          transport: 'stdio',
          duration,
        });

        return createToolErrorResponse(error, process.env.NODE_ENV === 'development');
      }
    });

    return server;
  }

  // Read once at startup, see the main entry point
  let tsdavConfig;

  // Lazy initialization flag
  let tsdavInitialized = false;

  async function ensureTsdavInitialized() {
    if (!tsdavInitialized) {
      await initializeTsdav();
      tsdavInitialized = true;
    }
  }

  // Main entry point
  try {
    logger.info('Starting dav-mcp STDIO server...');

    // A wrong configuration (unknown AUTH_METHOD, missing credentials) is
    // fatal: unlike an unreachable server it will not be any better on the
    // first tool call, and the user would only learn about it there.
    tsdavConfig = buildTsdavConfig(process.env);

    // Try to initialize tsdav clients eagerly, but don't fail if unavailable
    try {
      await initializeTsdav();
      tsdavInitialized = true;
    } catch (initError) {
      // e.g. a Digest-only server on a Node.js without WebCrypto: no retry will fix it
      if (initError.name === 'ConfigurationError') throw initError;
      logger.warn({ error: initError.message }, 'DAV server not reachable at startup — will retry on first tool call');
    }

    // Initialize tool call logger
    initializeToolCallLogger();
    logger.info('Tool call logger initialized');

    // Create MCP server
    const server = createMCPServer(ensureTsdavInitialized);
    logger.debug({ count: tools.length }, 'MCP server created with tools');

    // Create STDIO transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logger.info({
      name: SERVER_NAME,
      version: SERVER_VERSION,
      tools: tools.length,
    }, 'dav-mcp STDIO server ready');

  } catch (error) {
    if (error.name === 'ConfigurationError') {
      logger.error({ error: error.message }, 'Invalid configuration — server not started');
    } else {
      logger.error({ error: error.message, stack: error.stack }, 'Fatal error starting server');
    }
    process.exit(1);
  }

  // Graceful shutdown handlers
  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down...');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down...');
    process.exit(0);
  });

  // Handle uncaught errors gracefully
  process.on('uncaughtException', (error) => {
    logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Unhandled promise rejection');
    process.exit(1);
  });
}
