const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function startServer() {
  const port = await getAvailablePort();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, PORT: String(port), GEMINI_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Server did not start in time. Output: ${output}`));
    }, 5000);

    child.on('spawn', () => {
      setTimeout(() => {
        clearTimeout(timer);
        resolve({ child, port });
      }, 500);
    });

    child.on('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Server exited early with code ${code}. Output: ${output}`));
      }
    });
  });
}

test('health endpoint responds ok', async () => {
  const { child, port } = await startServer();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.status, 'ok');
  } finally {
    child.kill();
  }
});

test('chat endpoint returns a reply payload', async () => {
  const { child, port } = await startServer();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Привет' })
    });
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.ok(typeof data.reply === 'string');
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
  } finally {
    child.kill();
  }
});
