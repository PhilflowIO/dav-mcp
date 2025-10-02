#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tsdavManager } from './tsdav-client.js';
import { tools } from './tools.js';
import { createToolErrorResponse, MCP_ERROR_CODES } from './error-handler.js';
import { logger } from './logger.js';
import dotenv from 'dotenv';

dotenv.config();

// Initialize tsdav
try {
  await tsdavManager.initialize({
    serverUrl: process.env.CALDAV_SERVER_URL,
    username: process.env.CALDAV_USERNAME,
    password: process.env.CALDAV_PASSWORD,
  });
  logger.info('tsdav MCP server (stdio) initialized successfully');
} catch (error) {
  logger.error({ error: error.message }, 'Failed to initialize tsdav clients');
  process.exit(1);
}

// Create MCP server
const server = new Server(
  {
    name: 'tsdav-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Register tools/list handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug('tools/list request received');
  const toolList = tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  logger.debug({ count: toolList.length }, 'Returning tools list');
  return { tools: toolList };
});

// Register tools/call handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const toolName = request.params.name;
  const args = request.params.arguments || {};

  logger.info({ tool: toolName, args }, 'tools/call request received');

  const tool = tools.find(t => t.name === toolName);
  if (!tool) {
    logger.error({ tool: toolName }, 'Tool not found');
    const error = new Error(`Unknown tool: ${toolName}`);
    error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
    throw error;
  }

  try {
    logger.debug({ tool: toolName }, 'Executing tool');
    const result = await tool.handler(args);
    logger.info({ tool: toolName }, 'Tool executed successfully');
    return result;
  } catch (error) {
    logger.error({ tool: toolName, error: error.message, stack: error.stack }, 'Tool execution error');
    return createToolErrorResponse(error, process.env.NODE_ENV === 'development');
  }
});

// Connect server to stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
logger.info('MCP server connected to stdio transport');

// Keep process alive
process.stdin.resume();
