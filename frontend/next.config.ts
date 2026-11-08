import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import type { NextConfig } from "next";

/**
 * Reads the team `.env` at the repo root (Plan.md §3 T) without loading it into
 * process.env, so secrets such as NVIDIA_API_KEY never enter this process.
 * Only the public SpacetimeDB address and database name reach the browser.
 */
function repoEnv(): Record<string, string> {
  let dir = process.cwd();
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    if (!existsSync(join(dir, 'Plan.md'))) continue;
    const file = join(dir, '.env');
    if (!existsSync(file)) return {};
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
    return out;
  }
  return {};
}

const file = repoEnv();
const pick = (key: string) => process.env[key] || file[key] || '';
const publicUrl = pick('SPACETIME_PUBLIC_URL') || pick('SPACETIME_URL');

const nextConfig: NextConfig = {
  // Only this machine's LAN addresses and an explicitly configured tunnel.
  allowedDevOrigins: [
    ...Object.values(networkInterfaces()).flatMap(list => (list ?? []).filter(a => a.family === 'IPv4' && !a.internal).map(a => a.address)),
    ...(process.env.IMPORT_PUBLIC_ORIGIN ? [new URL(process.env.IMPORT_PUBLIC_ORIGIN).hostname] : []),
  ],
  env: {
    EGRESS_SPACETIME_URI: publicUrl ? publicUrl.replace(/^http/, 'ws').replace(/\/+$/, '') : '',
    EGRESS_SPACETIME_DB: pick('SPACETIME_DB'),
  },
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
};

export default nextConfig;
