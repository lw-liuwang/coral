import { loadConfig } from './config.js';
import { createApp } from './web.js';

const config = loadConfig();
const application = createApp(config);
const server = application.app.listen(config.server.port, config.server.host, () => {
  console.log(`coral: http://${config.server.host}:${config.server.port}`);
  console.log(`MCP: http://${config.server.host}:${config.server.port}/mcp`);
});
server.on('error', error => { console.error(error.message); application.close(); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { application.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
});
