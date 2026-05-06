import { Agent, setGlobalDispatcher } from "undici";

/**
 * Shared HTTP keep-alive agent for Polymarket data-api / gamma calls.
 *
 * Saves ~30-60ms per call vs cold sockets (no TCP/TLS handshake on warm
 * connections). Critical for the 100ms poll loop and the WS-triggered
 * instant check, where every ms of fixed overhead compounds.
 */
const sharedAgent = new Agent({
  keepAliveTimeout: 30_000,         // keep sockets alive 30s
  keepAliveMaxTimeout: 60_000,
  connections: 32,                   // up to 32 concurrent sockets per origin
  pipelining: 1,
});

/**
 * Install as the global dispatcher so plain `fetch(url)` calls
 * automatically benefit from keep-alive without changing call sites.
 */
export function installHttpAgent(): void {
  setGlobalDispatcher(sharedAgent);
}

export { sharedAgent };
