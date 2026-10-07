import { RequestOrigins, activateRequestOrigins } from '../../src/request-origins.js';

/**
 * Make the tool schemas accept URLs on these origins, as they do after a
 * login to the first one (the configured server) during which the server
 * named the others. Tests that stub the client manager need this: without a
 * login no URL is accepted.
 *
 * @param {string} serverUrl - the configured DAV server
 * @param {...string} discovered - further URLs the server reported
 * @returns {RequestOrigins}
 */
export function connectTo(serverUrl, ...discovered) {
  const origins = new RequestOrigins({ serverUrl });
  for (const url of discovered) origins.trust(url);
  origins.endDiscovery();
  activateRequestOrigins(origins);
  return origins;
}
