import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tsdavManager } from './tsdav-client.js';
import { tools } from './tools/index.js';
import { createToolErrorResponse, createHTTPErrorResponse, AuthenticationError, MCP_ERROR_CODES } from './error-handler.js';
import { logger, createSessionLogger, createRequestLogger } from './logger.js';
import { initializeToolCallLogger, getToolCallLogger } from './tool-call-logger.js';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Configuration
const allowedOrigins = process.env.CORS_ALLOWED_ORIGINS
  ? process.env.CORS_ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5678', 'http://localhost:3000']; // Default for n8n and local dev

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

// Rate Limiting - Higher limits for localhost/Docker testing
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: (req) => {
    // Allow higher rate limit for localhost and Docker networks (for testing)
    const ip = req.ip || req.connection.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip?.startsWith('::ffff:172.')) {
      return 10000; // 10000 requests for local/Docker networks
    }
    return 100; // 100 requests for external IPs
  },
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

app.use('/sse', limiter);
app.use('/messages', limiter);

// Body parser
app.use(express.json());

// Session storage for multiple clients
const transports = {};
const SESSION_TTL = 60 * 60 * 1000; // 1 hour
const SESSION_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Track session last activity
const sessionActivity = new Map();

/**
 * Bearer token authentication middleware
 */
function authenticateBearer(req, res, next) {
  const bearerToken = process.env.BEARER_TOKEN;

  if (!bearerToken) {
    logger.error('Server misconfiguration: BEARER_TOKEN not set');
    const errorResponse = createHTTPErrorResponse(
      new Error('Server misconfiguration: BEARER_TOKEN not set'),
      500
    );
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn({ ip: req.ip }, 'Unauthorized: Bearer token required');
    const errorResponse = createHTTPErrorResponse(
      new AuthenticationError('Unauthorized: Bearer token required')
    );
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  const token = authHeader.substring(7);

  // Use timing-safe comparison to prevent timing attacks
  const tokenBuffer = Buffer.from(token);
  const secretBuffer = Buffer.from(bearerToken);

  if (tokenBuffer.length !== secretBuffer.length || !crypto.timingSafeEqual(tokenBuffer, secretBuffer)) {
    logger.warn({ ip: req.ip }, 'Unauthorized: Invalid token');
    const errorResponse = createHTTPErrorResponse(
      new AuthenticationError('Unauthorized: Invalid token')
    );
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  next();
}

/**
 * Initialize tsdav clients
 *
 * Supports two authentication methods:
 * 1. Basic Auth (default) - set CALDAV_SERVER_URL, CALDAV_USERNAME, CALDAV_PASSWORD
 * 2. OAuth2 - set AUTH_METHOD=OAuth and GOOGLE_* variables
 */
async function initializeTsdav() {
  try {
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

    logger.info('tsdav clients initialized successfully');
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to initialize tsdav clients');
    process.exit(1);
  }
}

/**
 * Cleanup expired sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, lastActivity] of sessionActivity.entries()) {
    if (now - lastActivity > SESSION_TTL) {
      logger.info({ sessionId, age: now - lastActivity }, 'Cleaning up expired session');

      // Close transport if exists
      if (transports[sessionId]) {
        delete transports[sessionId];
      }

      sessionActivity.delete(sessionId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info({ cleanedCount, remainingSessions: sessionActivity.size }, 'Session cleanup completed');
  }
}

/**
 * Update session activity timestamp
 */
function updateSessionActivity(sessionId) {
  sessionActivity.set(sessionId, Date.now());
}

/**
 * Create MCP Server instance
 */
function createMCPServer(sessionId) {
  const sessionLogger = createSessionLogger(sessionId);

  const server = new Server(
    {
      name: process.env.MCP_SERVER_NAME || 'tsdav-mcp-server',
      version: process.env.MCP_SERVER_VERSION || '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // Register tools/list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const requestId = crypto.randomUUID();
    const requestLogger = createRequestLogger(requestId, { sessionId });

    requestLogger.debug('tools/list request received');
    const toolList = tools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    requestLogger.debug({ count: toolList.length }, 'Returning tools list');
    return { tools: toolList };
  });

  // Register tools/call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = crypto.randomUUID();
    const requestLogger = createRequestLogger(requestId, { sessionId });
    const toolCallLogger = getToolCallLogger();

    const toolName = request.params.name;
    const args = request.params.arguments || {};

    requestLogger.info({ tool: toolName, args }, 'tools/call request received');

    const tool = tools.find(t => t.name === toolName);
    if (!tool) {
      requestLogger.error({ tool: toolName }, 'Tool not found');
      const error = new Error(`Unknown tool: ${toolName}`);
      error.code = MCP_ERROR_CODES.METHOD_NOT_FOUND;
      throw error;
    }

    // Log tool call start
    const startTime = Date.now();
    toolCallLogger.logToolCallStart(toolName, args, {
      sessionId,
      requestId
    });

    try {
      requestLogger.debug({ tool: toolName }, 'Executing tool');
      const result = await tool.handler(args);
      const duration = Date.now() - startTime;

      requestLogger.info({ tool: toolName }, 'Tool executed successfully');

      // Log tool call success
      toolCallLogger.logToolCallSuccess(toolName, args, result, {
        sessionId,
        requestId,
        duration
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      requestLogger.error({ tool: toolName, error: error.message, stack: error.stack }, 'Tool execution error');

      // Log tool call error
      toolCallLogger.logToolCallError(toolName, args, error, {
        sessionId,
        requestId,
        duration
      });

      return createToolErrorResponse(error, process.env.NODE_ENV === 'development');
    }
  });

  sessionLogger.info('MCP Server created for session');
  return server;
}

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: process.env.MCP_SERVER_NAME || 'tsdav-mcp-server',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
    timestamp: new Date().toISOString(),
    sessions: {
      active: Object.keys(transports).length,
      total: sessionActivity.size,
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});

/**
 * SSE endpoint - GET /sse
 */
app.get('/sse', authenticateBearer, async (req, res) => {
  try {
    // Create SSE transport (this generates the sessionId internally)
    // Note: SSEServerTransport.start() will set headers and send the initial endpoint event
    const transport = new SSEServerTransport('/messages', res);

    // Use transport's sessionId consistently everywhere
    const sessionId = transport.sessionId;
    const sessionLogger = createSessionLogger(sessionId);

    sessionLogger.info({
      ip: req.ip,
      userAgent: req.get('user-agent') || 'unknown',
      sessionId: sessionId,
    }, 'New SSE connection established');

    sessionLogger.debug('SSE headers set');

    // Store transport BEFORE connecting (prevents race condition)
    transports[sessionId] = transport;
    updateSessionActivity(sessionId);
    sessionLogger.debug('Transport stored');

    // Create MCP server for this session
    sessionLogger.debug('Creating MCP server');
    const mcpServer = createMCPServer(sessionId);

    // Connect MCP server to transport
    sessionLogger.debug('Connecting MCP server to transport');
    await mcpServer.connect(transport);
    sessionLogger.info('MCP server connected successfully, session active');

    // Keep-Alive Heartbeat (every 30 seconds)
    // Send as SSE comment to avoid breaking JSON-RPC parser in MCP clients
    const heartbeat = setInterval(() => {
      if (!res.destroyed) {
        try {
          res.write(': keep-alive\n');
          sessionLogger.debug('Heartbeat sent');
        } catch (error) {
          sessionLogger.debug('Heartbeat failed, connection likely closed');
          clearInterval(heartbeat);
        }
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    // Cleanup on disconnect
    req.on('close', () => {
      sessionLogger.info('SSE connection closed by client');
      clearInterval(heartbeat);
      delete transports[sessionId];
      sessionActivity.delete(sessionId);
    });

    req.on('error', (error) => {
      if (error.code === 'ECONNRESET') {
        sessionLogger.info('SSE connection closed by client (normal)');
      } else {
        sessionLogger.error({
          error: error.message,
          code: error.code,
        }, 'SSE connection error');
      }
      clearInterval(heartbeat);
      delete transports[sessionId];
      sessionActivity.delete(sessionId);
    });

    res.on('finish', () => {
      sessionLogger.debug('Response finished');
    });

    res.on('close', () => {
      sessionLogger.debug('Response closed');
    });
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Error setting up SSE connection');
    if (!res.headersSent) {
      const errorResponse = createHTTPErrorResponse(error);
      res.status(errorResponse.statusCode).json(errorResponse.body);
    }
  }
});

/**
 * Message endpoint - POST /messages
 * Used by SSE clients to send messages back to the server
 */
app.post('/messages', authenticateBearer, async (req, res) => {
  const sessionId = req.query.sessionId;
  const requestLogger = createSessionLogger(sessionId || 'unknown');

  requestLogger.info({ method: req.body?.method }, 'Message received');

  if (!sessionId) {
    requestLogger.error('No sessionId provided');
    const errorResponse = createHTTPErrorResponse(
      new Error('sessionId required'),
      400
    );
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  const transport = transports[sessionId];
  if (!transport) {
    requestLogger.error({
      sessionId,
      availableSessions: Object.keys(transports),
    }, 'Session not found');
    const errorResponse = createHTTPErrorResponse(
      new Error('Session not found'),
      404
    );
    return res.status(errorResponse.statusCode).json(errorResponse.body);
  }

  try {
    // Update session activity
    updateSessionActivity(sessionId);

    // Use the transport's handlePostMessage method
    await transport.handlePostMessage(req, res, req.body);
    requestLogger.debug('Message handled by transport');
  } catch (error) {
    requestLogger.error({ error: error.message }, 'Error handling message');
    if (!res.headersSent) {
      const errorResponse = createHTTPErrorResponse(error);
      res.status(errorResponse.statusCode).json(errorResponse.body);
    }
  }
});

/**
 * Info endpoint - GET /
 */
app.get('/', (req, res) => {
  res.json({
    name: process.env.MCP_SERVER_NAME || 'tsdav-mcp-server',
    version: process.env.MCP_SERVER_VERSION || '1.0.0',
    description: 'MCP SSE Server for tsdav - CalDAV/CardDAV integration',
    endpoints: {
      sse: '/sse (GET)',
      messages: '/messages (POST)',
      health: '/health (GET)',
    },
    tools: tools.map(t => ({
      name: t.name,
      description: t.description,
    })),
    documentation: 'See README.md for n8n integration instructions',
  });
});

/**
 * Graceful shutdown handler
 */
async function gracefulShutdown(signal) {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown...');

  // Stop accepting new connections
  if (server) {
    server.close(() => {
      logger.info('HTTP server closed');
    });
  }

  // Close all active transports
  const sessionIds = Object.keys(transports);
  logger.info({ sessionCount: sessionIds.length }, 'Closing active sessions');

  for (const sessionId of sessionIds) {
    try {
      delete transports[sessionId];
      sessionActivity.delete(sessionId);
    } catch (error) {
      logger.error({ sessionId, error: error.message }, 'Error closing session');
    }
  }

  // Clear cleanup interval
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
  }

  logger.info('Graceful shutdown completed');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught errors - LOG but DO NOT kill the server
// Tool errors are caught in the tool handler try/catch (line 208)
// These handlers are only for truly unexpected errors that escape our error handling
process.on('uncaughtException', (error) => {
  logger.error({ error: error.message, stack: error.stack }, 'Uncaught exception - server continuing');
  // DO NOT call gracefulShutdown() - let the server continue running
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection - server continuing');
  // DO NOT call gracefulShutdown() - let the server continue running
});

let server;
let cleanupInterval;

/**
 * Start server
 */
async function start() {
  logger.info('Starting tsdav MCP Server...');

  // Initialize tsdav clients
  await initializeTsdav();

  // Initialize tool call logger
  const toolCallLogger = initializeToolCallLogger();
  logger.info({
    enabled: toolCallLogger.enabled,
    mode: toolCallLogger.outputMode,
    logFile: toolCallLogger.logFile
  }, 'Tool call logger initialized');

  // Start session cleanup interval
  cleanupInterval = setInterval(cleanupExpiredSessions, SESSION_CLEANUP_INTERVAL);
  logger.info({ interval: SESSION_CLEANUP_INTERVAL, ttl: SESSION_TTL }, 'Session cleanup scheduled');

  // Start Express server
  server = app.listen(PORT, () => {
    logger.info({
      port: PORT,
      url: `http://localhost:${PORT}`,
      sseEndpoint: `http://localhost:${PORT}/sse`,
      healthEndpoint: `http://localhost:${PORT}/health`,
    }, 'MCP Server running');

    logger.info({ count: tools.length }, 'Available tools');
    tools.forEach(tool => {
      logger.debug({ name: tool.name, description: tool.description }, 'Tool registered');
    });

    logger.info('Ready for n8n connections');
  });
}

// Start the server
start().catch(error => {
  logger.error({ error: error.message, stack: error.stack }, 'Failed to start server');
  process.exit(1);
});
