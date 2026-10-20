import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createMcpServer } from './mcp.js';
import { VaultRegistry } from './vault.js';

const registry = new VaultRegistry(loadConfig());
const server = createMcpServer(registry);
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { void server.close().finally(() => registry.close()); });
