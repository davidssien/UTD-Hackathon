#!/usr/bin/env node
/**
 * The SpacetimeDB CLI for the team, with no `spacetime login` (Plan.md §3 T).
 *
 *   npm run db:publish                 publish the module (never deletes data)
 *   npm run db:logs [-- -n 200 -f]     module logs (owner only)
 *   npm run db:sql -- "SELECT ..."     SQL as the owner
 *   npm run db:generate                regenerate the client bindings
 *   npm run db -- <any spacetime args> anything else, e.g. `npm run db -- list`
 *
 * Settings come from the repo `.env` (see `.env.example`); shell variables win.
 * The CLI runs with a repo-local config (`.spacetime/cli.toml`, gitignored)
 * rebuilt on every call and logged in with SPACETIME_TOKEN, so nobody's
 * personal login changes. The token is never printed.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));

const env = process.env;
const url = (env.SPACETIME_URL || 'https://maincloud.spacetimedb.com').replace(/\/+$/, '');
const db = env.SPACETIME_DB || 'egress-dev';
const target = env.SPACETIME_DB_IDENTITY || db;
const token = env.SPACETIME_TOKEN || '';
const dir = join(root, '.spacetime');
const configPath = join(dir, 'cli.toml');
// The CLI seeds a fresh config with built-in servers (maincloud, local); reuse a built-in entry for the same host.
let SERVER = 'team';

function findCli() {
  if (env.SPACETIME_CLI) return env.SPACETIME_CLI;
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    const shim = join(env.LOCALAPPDATA, 'SpacetimeDB', 'spacetime.exe');
    if (existsSync(shim)) return shim;
  }
  return 'spacetime';
}
const cli = findCli();

const scrub = text => (token ? text.split(token).join('<SPACETIME_TOKEN>') : text);

function run(args, quiet) {
  const result = spawnSync(cli, ['--config-path', configPath, ...args], { cwd: root, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' });
  if (result.error) {
    console.error(`Could not run the SpacetimeDB CLI (${cli}). Install it (https://spacetimedb.com/install) or set SPACETIME_CLI.`);
    process.exit(1);
  }
  return result;
}

function spacetime(args, { quiet = false } = {}) {
  const result = run(args, quiet);
  if (quiet && result.status !== 0) process.stderr.write(scrub(`${result.stdout ?? ''}${result.stderr ?? ''}`));
  return result.status ?? 1;
}

function connect({ needToken }) {
  rmSync(configPath, { force: true });
  mkdirSync(dir, { recursive: true });
  const host = new URL(url).host;
  const listed = run(['server', 'list'], true);
  const existing = `${listed.stdout ?? ''}`.split(/\r?\n/).map(l => l.trim().split(/\s+/)).find(cols => cols.includes(host));
  if (existing) {
    SERVER = existing.at(-1);
    if (spacetime(['server', 'set-default', SERVER], { quiet: true }) !== 0) process.exit(1);
  } else if (spacetime(['server', 'add', '--url', url, '--no-fingerprint', '--default', SERVER], { quiet: true }) !== 0) process.exit(1);
  if (!token) {
    if (needToken) { console.error('SPACETIME_TOKEN is missing: add the team token to the repo .env (see .env.example).'); process.exit(1); }
    return;
  }
  if (spacetime(['login', '--token', token], { quiet: true }) !== 0) { console.error('The SpacetimeDB CLI rejected SPACETIME_TOKEN.'); process.exit(1); }
}

const [command = 'help', ...rest] = process.argv.slice(2);
const describe = () => console.error(`SpacetimeDB ${url} · database ${env.SPACETIME_DB_IDENTITY ? `${db} (by identity)` : db}`);

switch (command) {
  case 'publish':
    connect({ needToken: true }); describe();
    process.exit(spacetime(['publish', target, '--server', SERVER, '--module-path', 'spacetimedb', '--delete-data=never', '--yes', ...rest]));
    break;
  case 'logs':
    connect({ needToken: true }); describe();
    process.exit(spacetime(['logs', target, '--server', SERVER, ...rest]));
    break;
  case 'sql':
    connect({ needToken: true }); describe();
    // npm splits an unquoted query into words; join them back unless flags were passed.
    process.exit(spacetime(['sql', target, '--server', SERVER, ...(rest.some(a => a.startsWith('-')) ? rest : [rest.join(' ')])]));
    break;
  case 'generate':
    process.exit(spacetime(['generate', '--lang', 'typescript', '--import-extension', 'ts', '--out-dir', 'packages/client/src/bindings', '--module-path', 'spacetimedb', '--yes', ...rest]));
    break;
  case 'cli':
    connect({ needToken: false });
    process.exit(spacetime(rest));
    break;
  default:
    console.error('Usage: npm run db:publish | db:logs | db:sql -- "<query>" | db:generate | db -- <spacetime args>');
    process.exit(command === 'help' ? 0 : 1);
}
