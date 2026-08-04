import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { createApiRouter } from './routes.js';
import { mountMcp } from './mcp-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();

app.use(express.json({ limit: '2mb' }));
app.use('/api', createApiRouter());
mountMcp(app);

app.use(express.static(publicDir));

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const port = config.port;
app.listen(port, '0.0.0.0', () => {
  console.log(`Email verification waterfall listening on :${port}`);
  console.log(`Dashboard: http://0.0.0.0:${port}/`);
  console.log(`MCP endpoint: POST http://0.0.0.0:${port}/mcp`);
});
