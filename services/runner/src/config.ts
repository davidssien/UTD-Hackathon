/**
 * Runner configuration (PLAN.md §3 T). Precedence: shell variables, then the
 * optional local override `services/runner/.env`, then the team file `.env` at
 * the repo root. `process.loadEnvFile` never overwrites a variable that is
 * already set, so the first file loaded wins. The runner's SpacetimeDB token is
 * persisted per connection target next to the override file, so local and
 * Maincloud credentials stay separate across restarts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerDir = join(dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = join(runnerDir, '..', '..');
export const ENV_FILES = [join(runnerDir, '.env'), join(repoRoot, '.env')];

for (const file of ENV_FILES) if (existsSync(file)) process.loadEnvFile(file);

type Env = Record<string, string | undefined>;

/** WebSocket target and database: `SPACETIME_URI` wins, else `SPACETIME_URL` (http→ws, https→wss), else Maincloud. */
export function resolveSpacetime(env: Env): { uri: string; db: string } {
  const uri = env.SPACETIME_URI || (env.SPACETIME_URL ? env.SPACETIME_URL.replace(/^http/, 'ws').replace(/\/+$/, '') : 'wss://maincloud.spacetimedb.com');
  return { uri, db: env.SPACETIME_DB || 'egress-dev' };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}: add it to the repo .env (see .env.example).`);
  return value;
}

const target = resolveSpacetime(process.env);

export const config = {
  spacetimeUri: target.uri,
  spacetimeDb: target.db,
  serviceSecret: () => required('EGRESS_SERVICE_SECRET'),
  nvidiaApiKey: () => required('NVIDIA_API_KEY'),
  nemotronModel: process.env.NEMOTRON_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
  nemotronFallbackModel: process.env.NEMOTRON_FALLBACK_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
  nemotronBaseUrl: process.env.NEMOTRON_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
};

function tokenFile(uri: string, db: string): string {
  const key = createHash('sha256').update(JSON.stringify([uri, db])).digest('hex').slice(0, 16);
  return join(runnerDir, `.env.runner-token-${key}`);
}

export const loadToken = (uri: string, db: string): string | undefined => {
  const path = tokenFile(uri, db);
  return existsSync(path) ? readFileSync(path, 'utf8').trim() || undefined : undefined;
};
export const saveToken = (token: string, uri: string, db: string) => writeFileSync(tokenFile(uri, db), token);
