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

// Authless MCP: Claude probes these during custom-connector setup.
// Returning the SPA HTML (200) makes Claude think OAuth exists and then fail
// with "Couldn't register with … sign-in service". Serve explicit 404 JSON.
app.get(
  [
    '/.well-known/oauth-authorization-server',
    '/.well-known/openid-configuration',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server/*',
    '/.well-known/oauth-protected-resource/*',
  ],
  (_req, res) => {
    res.status(404).json({
      error: 'not_found',
      message:
        'This MCP server is authless. No OAuth authorization server is configured.',
    });
  }
);

app.use('/api', createApiRouter());
mountMcp(app);

app.use(express.static(publicDir));

// SPA fallback — never steal API / MCP / well-known routes
app.get('*', (req, res, next) => {
  if (
    req.path.startsWith('/api') ||
    req.path.startsWith('/mcp') ||
    req.path.startsWith('/.well-known')
  ) {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

const port = config.port;
app.listen(port, '0.0.0.0', () => {
  console.log(`Email verification waterfall listening on :${port}`);
  console.log(`Dashboard: http://0.0.0.0:${port}/`);
  console.log(`MCP endpoint: POST http://0.0.0.0:${port}/mcp`);
});
