import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

function waitForOutput(child, pattern, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), ms);
    const onData = (buf) => {
      if (pattern.test(String(buf))) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        child.stderr.off('data', onData);
        resolve();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

describe('deploy boot', () => {
  it('declares a Node version Railpack can install and supabase-js accepts', () => {
    assert.match(String(pkg.engines.node), /22/);
    assert.equal(pkg.scripts.start, 'node src/server.js');
  });

  it('starts and serves /api/health without vendor secrets', async () => {
    const port = 18765;
    const child = spawn(process.execPath, ['src/server.js'], {
      cwd: root,
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (buf) => stderr.push(String(buf)));
    try {
      await waitForOutput(child, /listening on/i, 8_000);
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    } catch (err) {
      err.message += `\nstderr:\n${stderr.join('')}`;
      throw err;
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  });
});
