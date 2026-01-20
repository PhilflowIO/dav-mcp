#!/usr/bin/env node
/**
 * dav-mcp STDIO Server
 *
 * Entry point for local MCP clients: Claude Desktop, Cursor, VS Code, npx usage
 *
 * CRITICAL: This server uses STDIO transport. All logging MUST go to stderr
 * to avoid corrupting JSON-RPC messages on stdout.
 *
 * Usage:
 *   MCP_TRANSPORT=stdio node src/server-stdio.js
 *
 * Or via npx (after npm publish):
 *   npx dav-mcp
 *
 * Configuration via environment variables:
 *   - CALDAV_SERVER_URL: CalDAV server URL
 *   - CALDAV_USERNAME: Username for Basic Auth
 *   - CALDAV_PASSWORD: Password for Basic Auth
 *   - AUTH_METHOD: 'Basic' (default) or 'OAuth'
 *
 * For OAuth2 (Google Calendar):
 *   - GOOGLE_SERVER_URL: Google CalDAV URL
 *   - GOOGLE_USER: Google account email
 *   - GOOGLE_CLIENT_ID: OAuth2 client ID
 *   - GOOGLE_CLIENT_SECRET: OAuth2 client secret
 *   - GOOGLE_REFRESH_TOKEN: OAuth2 refresh token
 */

// Set STDIO mode BEFORE importing logger
process.env.MCP_TRANSPORT = 'stdio';

import dotenv from 'dotenv';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { tsdavManager } from './tsdav-client.js';
import { tools } from './tools/index.js';
import { createToolErrorResponse, MCP_ERROR_CODES } from './error-handler.js';
import { logger } from './logger.js';
import { initializeToolCallLogger, getToolCallLogger } from './tool-call-logger.js';

// Load environment variables
dotenv.config();

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
      version: process.env.MCP_SERVER_VERSION || '3.0.0',
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
    const args = request.params.arguments || {};
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
    toolCallLogger.logToolCallStart(toolName, args, { transport: 'stdio' });

    try {
      logger.debug({ tool: toolName }, 'Executing tool');
      const result = await tool.handler(args);
      const duration = Date.now() - startTime;

      logger.info({ tool: toolName, duration }, 'Tool executed successfully');
      toolCallLogger.logToolCallSuccess(toolName, args, result, {
        transport: 'stdio',
        duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error({ tool: toolName, error: error.message }, 'Tool execution error');
      toolCallLogger.logToolCallError(toolName, args, error, {
        transport: 'stdio',
        duration,
      });

      return createToolErrorResponse(error, process.env.NODE_ENV === 'development');
    }
  });

  return server;
}

/**
 * Main entry point
 */
async function main() {
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
      version: process.env.MCP_SERVER_VERSION || '3.0.0',
      tools: tools.length,
    }, 'dav-mcp STDIO server ready');

  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Fatal error starting server');
    process.exit(1);
  }
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

// Start the server
main();
