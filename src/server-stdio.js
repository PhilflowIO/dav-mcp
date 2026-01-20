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
 *   - CALDAV_USERNAME: Username for Basic Auth
 *   - CALDAV_PASSWORD: Password for Basic Auth
 *   - AUTH_METHOD: 'Basic' (default) or 'OAuth'
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
  const { tools } = await import('./tools/index.js');
  const { createToolErrorResponse, MCP_ERROR_CODES } = await import('./error-handler.js');
  const { logger } = await import('./logger.js');
  const { initializeToolCallLogger, getToolCallLogger } = await import('./tool-call-logger.js');

  // Load environment variables
  dotenv.default.config();

  /**
   * Initialize tsdav clients based on auth method
   */
  async function initializeTsdav() {
    const authMethod = process.env.AUTH_METHOD || 'Basic';

    if (authMethod === 'OAuth' || authMethod === 'Oauth') {
      // OAuth2 Configuration (e.g., Google Calendar)
      logger.info('Initializing with OAuth2 authentication');

      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
        throw new Error('OAuth2 requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN');
      }

      await tsdavManager.initialize({
        serverUrl: process.env.GOOGLE_SERVER_URL || 'https://apidata.googleusercontent.com/caldav/v2/',
        authMethod: 'OAuth',
        username: process.env.GOOGLE_USER,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: process.env.GOOGLE_REFRESH_TOKEN,
        tokenUrl: process.env.GOOGLE_TOKEN_URL || 'https://accounts.google.com/o/oauth2/token',
      });

      logger.info('OAuth2 clients initialized successfully');
    } else {
      // Basic Auth Configuration (standard CalDAV servers)
      logger.info('Initializing with Basic authentication');

      if (!process.env.CALDAV_SERVER_URL || !process.env.CALDAV_USERNAME || !process.env.CALDAV_PASSWORD) {
        throw new Error('Basic Auth requires CALDAV_SERVER_URL, CALDAV_USERNAME, and CALDAV_PASSWORD');
      }

      await tsdavManager.initialize({
        serverUrl: process.env.CALDAV_SERVER_URL,
        authMethod: 'Basic',
        username: process.env.CALDAV_USERNAME,
        password: process.env.CALDAV_PASSWORD,
      });

      logger.info('Basic Auth clients initialized successfully');
    }
  }

  /**
   * Create MCP Server with tool handlers
   */
  function createMCPServer() {
    const server = new Server(
      {
        name: process.env.MCP_SERVER_NAME || 'dav-mcp',
        version: process.env.MCP_SERVER_VERSION || '3.0.1',
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
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
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

  // Main entry point
  try {
    logger.info('Starting dav-mcp STDIO server...');

    // Initialize tsdav clients
    await initializeTsdav();

    // Initialize tool call logger
    initializeToolCallLogger();
    logger.info('Tool call logger initialized');

    // Create MCP server
    const server = createMCPServer();
    logger.debug({ count: tools.length }, 'MCP server created with tools');

    // Create STDIO transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    logger.info({
      name: process.env.MCP_SERVER_NAME || 'dav-mcp',
      version: process.env.MCP_SERVER_VERSION || '3.0.1',
      tools: tools.length,
    }, 'dav-mcp STDIO server ready');

  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Fatal error starting server');
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
