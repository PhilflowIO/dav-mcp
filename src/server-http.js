/**
 * dav-mcp Streamable HTTP Server (Stateless)
 *
 * Modern MCP transport for remote clients (n8n, cloud deployments)
 * Implements the MCP Streamable HTTP specification in stateless mode.
 *
 * Each request is independent - no session state maintained.
 * Suitable for horizontal scaling and multi-node deployments.
 *
 * Usage:
 *   node src/server-http.js
 *
 * Configuration via environment variables:
 *   - PORT: Server port (default: 3000)
 *   - BEARER_TOKEN: Required for authentication
 *   - CORS_ALLOWED_ORIGINS: Comma-separated list of allowed origins
 *   - CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD: CalDAV credentials
 *   - AUTH_METHOD: 'Basic' (default), 'Digest' or 'OAuth' (case-insensitive, see auth-config.js)
 */

import express from 'express';
import { SERVER_NAME, SERVER_VERSION } from './server-info.js';
import cors from 'cors';
import crypto from 'crypto';
import dotenv from 'dotenv';
import rateLimit from 'express-rate-limit';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { tsdavManager } from './tsdav-client.js';
import { isLocalOrPrivateAddress } from './client-address.js';
import { buildTsdavConfig } from './auth-config.js';
import { tools } from './tools/index.js';
import { createToolErrorResponse, MCP_ERROR_CODES } from './error-handler.js';
import { logger, createRequestLogger } from './logger.js';
import { initializeToolCallLogger, getToolCallLogger } from './tool-call-logger.js';

// Load environment variables
dotenv.config();

// The MCP SDK's Streamable HTTP transport calls the global `crypto`, which
// Node.js 18 does not have (it arrived in 20). @hono/node-server 1.x sets it as
// a side effect; 2.x (Node.js 20+) does not. npm picks 1.x for a fresh install
// on Node.js 18, but this repository's lockfile pins 2.x, and with it every
// MCP request on Node.js 18 failed with "crypto is not defined". Setting it
// here makes the server independent of which of the two is installed.
// Goes away with Node.js 18 support: #85.
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = crypto.webcrypto;
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5678', 'http://localhost:3000'];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Body parser
app.use(express.json());

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: (req) => {
    const ip = req.ip || req.socket?.remoteAddress;
    return isLocalOrPrivateAddress(ip) ? 10000 : 100;
  },
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/mcp', limiter);

/**
 * Bearer token authentication middleware
 */
function authenticateBearer(req, res, next) {
  const bearerToken = process.env.BEARER_TOKEN;

  if (!bearerToken) {
    logger.error('Server misconfiguration: BEARER_TOKEN not set');
    return res.status(500).json({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Server misconfiguration: BEARER_TOKEN not set' },
      id: null,
    });
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ ip: req.ip }, 'Unauthorized: Bearer token required');
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: Bearer token required' },
      id: null,
    });
  }

  const token = authHeader.substring(7);

  // Timing-safe comparison
  const tokenBuffer = Buffer.from(token);
  const secretBuffer = Buffer.from(bearerToken);

  if (tokenBuffer.length !== secretBuffer.length || !crypto.timingSafeEqual(tokenBuffer, secretBuffer)) {
    logger.warn({ ip: req.ip }, 'Unauthorized: Invalid token');
    return res.status(401).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: Invalid token' },
      id: null,
    });
  }

  next();
}

/**
 * Initialize tsdav clients
 */
async function initializeTsdav() {
  try {
    const config = buildTsdavConfig(process.env);
    logger.info({ configuredAuthMethod: config.authMethod }, 'Initializing tsdav clients');
    await tsdavManager.initialize(config);
  } catch (error) {
    logger.error({ error: error.message }, error.name === 'ConfigurationError'
      ? 'Invalid configuration — server not started'
      : 'Failed to initialize tsdav clients');
    process.exit(1);
  }
}

/**
 * Create MCP Server instance for a request
 */
function createMCPServer(requestId) {
  const requestLogger = createRequestLogger(requestId);

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
    requestLogger.debug({ count: tools.length }, 'tools/list request');
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
    const toolCallLogger = getToolCallLogger();
    const toolName = request.params.name;
    const args = request.params.arguments || {};

    requestLogger.info({ tool: toolName }, 'tools/call request');

    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      requestLogger.error({ tool: toolName }, 'Tool not found');
      const error = new Error(`Unknown tool: ${toolName}`);
      error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
      throw error;
    }

    const startTime = Date.now();
    toolCallLogger.logToolCallStart(toolName, args, {
      requestId,
      transport: 'http',
    });

    try {
      const result = await tool.handler(args);
      const duration = Date.now() - startTime;

      requestLogger.info({ tool: toolName, duration }, 'Tool executed successfully');
      toolCallLogger.logToolCallSuccess(toolName, args, result, {
        requestId,
        transport: 'http',
        duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      requestLogger.error({ tool: toolName, error: error.message }, 'Tool execution error');
      toolCallLogger.logToolCallError(toolName, args, error, {
        requestId,
        transport: 'http',
        duration,
      });

      return createToolErrorResponse(error, process.env.NODE_ENV === 'development');
    }
  });

  return server;
}

/**
 * POST /mcp - Handle MCP requests (stateless)
 */
app.post('/mcp', authenticateBearer, async (req, res) => {
  const requestId = crypto.randomUUID();

  try {
    // Stateless: create new transport and server for each request
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
    });

    const server = createMCPServer(requestId);

    // Cleanup on request close
    res.on('close', () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error({ requestId, error: error.message }, 'Error handling MCP request');
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

/**
 * GET /mcp - Not supported in stateless mode
 */
app.get('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  });
});

/**
 * DELETE /mcp - Not supported in stateless mode
 */
app.delete('/mcp', (req, res) => {
  res.status(405).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Method not allowed. Use POST for MCP requests.' },
    id: null,
  });
});

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http-stateless',
    timestamp: new Date().toISOString(),
    tools: tools.length,
    uptime: process.uptime(),
  });
});

/**
 * Info endpoint
 */
app.get('/', (req, res) => {
  res.json({
    name: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http-stateless',
    description: 'MCP Streamable HTTP Server for CalDAV/CardDAV integration (stateless)',
    endpoints: {
      mcp: '/mcp (POST only)',
      health: '/health (GET)',
    },
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
    })),
  });
});

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, shutting down...');

  if (httpServer) {
    httpServer.close(() => {
      logger.info('HTTP server closed');
    });
  }

  logger.info('Shutdown completed');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

let httpServer;

/**
 * Start server
 */
async function start() {
  logger.info('Starting dav-mcp HTTP Server (stateless)...');

  // Initialize tsdav clients
  await initializeTsdav();

  // Initialize tool call logger
  initializeToolCallLogger();
  logger.info('Tool call logger initialized');

  // Start Express server
  httpServer = app.listen(PORT, () => {
    logger.info({
      port: PORT,
      url: `http://localhost:${PORT}`,
      mcpEndpoint: `http://localhost:${PORT}/mcp`,
      mode: 'stateless',
    }, 'HTTP Server running');

    logger.info({ count: tools.length }, 'Available tools');
  });
}

// Start the server
start().catch(error => {
  logger.error({ error: error.message, stack: error.stack }, 'Failed to start server');
  process.exit(1);
});
