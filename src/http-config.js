/**
 * Settings of the HTTP transport that are checked before it listens.
 *
 * Each of them decides who can reach the server or how it tells clients
 * apart, so a wrong value is a ConfigurationError: the server does not start
 * rather than serve with a setting the operator did not mean.
 */

import { ConfigurationError } from './auth-config.js';

export const MIN_BEARER_TOKEN_LENGTH = 32;

// Values the documentation has shown as examples. Anyone can read them, so a
// server that accepts one has no authentication.
const PLACEHOLDER_TOKENS = new Set([
  'your-secure-token-here',
  'your-secret-token',
  'YOUR_BEARER_TOKEN',
]);

const HOW_TO_GENERATE = 'Generate one with `openssl rand -hex 32` and set it as BEARER_TOKEN.';

/**
 * @param {string|undefined} value - BEARER_TOKEN as read from the environment
 * @returns {string} the token
 * @throws {ConfigurationError} when the token is unset, a documented example
 *   value, or shorter than MIN_BEARER_TOKEN_LENGTH characters
 */
export function checkBearerToken(value) {
  if (!value) {
    throw new ConfigurationError(
      `BEARER_TOKEN is not set; the HTTP transport refuses every request without it. ${HOW_TO_GENERATE}`,
    );
  }
  if (PLACEHOLDER_TOKENS.has(value)) {
    throw new ConfigurationError(
      `BEARER_TOKEN is the example value from the documentation, which anyone can read. ${HOW_TO_GENERATE}`,
    );
  }
  if (value.length < MIN_BEARER_TOKEN_LENGTH) {
    throw new ConfigurationError(
      `BEARER_TOKEN has ${value.length} characters; at least ${MIN_BEARER_TOKEN_LENGTH} are required. ${HOW_TO_GENERATE}`,
    );
  }
  return value;
}
