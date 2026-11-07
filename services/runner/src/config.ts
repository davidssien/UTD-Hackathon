/**
 * Runner configuration from services/runner/.env (gitignored). The runner's
 * SpacetimeDB token is persisted next to it in .env.runner-token so its
 * identity stays stable across restarts.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(root, '.env');
const tokenFile = join(root, '.env.runner-token');

if (existsSync(envFile)) process.loadEnvFile(envFile);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name} in services/runner/.env`);
  return value;
}

export const config = {
  spacetimeUri: process.env.SPACETIME_URI ?? 'wss://maincloud.spacetimedb.com',
  spacetimeDb: process.env.SPACETIME_DB ?? 'egress-dev',
  serviceSecret: () => required('EGRESS_SERVICE_SECRET'),
  nvidiaApiKey: () => required('NVIDIA_API_KEY'),
  nemotronModel: process.env.NEMOTRON_MODEL ?? 'nvidia/nemotron-3-super-120b-a12b',
  nemotronFallbackModel: process.env.NEMOTRON_FALLBACK_MODEL ?? 'nvidia/nemotron-3.5-lightning-30b-a3b',
  nemotronBaseUrl: process.env.NEMOTRON_BASE_URL ?? 'https://integrate.api.nvidia.com/v1',
};

export const loadToken = (): string | undefined => (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() || undefined : undefined);
export const saveToken = (token: string) => writeFileSync(tokenFile, token);
