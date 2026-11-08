#!/usr/bin/env node
/**
 * Fails the build if a secret reached the browser (Plan.md §3 T, §3 S).
 * Scans the client bundle (.next/static) and prerendered pages for the values
 * of server-only keys from the repo .env or the shell, and the client bundle
 * for their names. Never prints a secret.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(frontend, '..');
const SECRET_KEYS = ['NVIDIA_API_KEY', 'SPACETIME_TOKEN', 'EGRESS_SERVICE_SECRET'];

const fileEnv = {};
const envPath = join(repo, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) fileEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const secrets = SECRET_KEYS.flatMap(k => [process.env[k], fileEnv[k]].filter(v => v && v.length >= 8).map(value => ({ key: k, value })));

function* files(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(js|mjs|css|html|json|rsc|txt|map)$/.test(name)) yield path;
  }
}

const roots = [join(frontend, '.next', 'static'), join(frontend, '.next', 'server', 'app')];
if (!existsSync(roots[0])) { console.error('check-bundle-secrets: no .next/static; run next build first.'); process.exit(1); }

const problems = [];
let scanned = 0;
for (const root of roots) {
  for (const path of files(root)) {
    const text = readFileSync(path, 'utf8');
    scanned++;
    for (const s of secrets) if (text.includes(s.value)) problems.push(`${relative(frontend, path)} contains the value of ${s.key}`);
    if (root === roots[0]) for (const k of SECRET_KEYS) if (text.includes(k)) problems.push(`${relative(frontend, path)} mentions ${k}`);
  }
}
if (problems.length) {
  console.error(`check-bundle-secrets: ${problems.length} problem(s):\n  ${[...new Set(problems)].join('\n  ')}`);
  process.exit(1);
}
console.log(`check-bundle-secrets: ${scanned} files clean (${secrets.length} secret value(s) checked).`);
