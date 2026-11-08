import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENV_FILES, repoRoot, resolveSpacetime } from '../src/config.ts';

test('SpacetimeDB target: SPACETIME_URI wins, else SPACETIME_URL is converted to WebSocket, else Maincloud', () => {
  assert.deepEqual(resolveSpacetime({}), { uri: 'wss://maincloud.spacetimedb.com', db: 'egress-dev' });
  assert.deepEqual(resolveSpacetime({ SPACETIME_URL: 'https://maincloud.spacetimedb.com/', SPACETIME_DB: 'egress-dev' }), { uri: 'wss://maincloud.spacetimedb.com', db: 'egress-dev' });
  assert.deepEqual(resolveSpacetime({ SPACETIME_URL: 'http://127.0.0.1:3010', SPACETIME_DB: 'egress' }), { uri: 'ws://127.0.0.1:3010', db: 'egress' });
  assert.equal(resolveSpacetime({ SPACETIME_URI: 'ws://override:1', SPACETIME_URL: 'https://x' }).uri, 'ws://override:1');
});

test('env files load the runner override before the team file at the repo root', () => {
  assert.equal(ENV_FILES.length, 2);
  assert.match(ENV_FILES[0], /services[\\/]runner[\\/]\.env$/);
  assert.equal(ENV_FILES[1], join(repoRoot, '.env'));
});
