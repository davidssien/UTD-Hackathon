import { randomBytes } from 'node:crypto';

export const MAX_UPLOAD = 4 * 1024 * 1024;
type Session = { expires: number; image?: string };

// All instances use the same database. No owner/service token is needed: the
// database procedure checks the separate, unguessable pairing capabilities.
async function call(action: string, id: string, token = '', value = ''): Promise<Session> {
  const host = process.env.SPACETIME_URL || process.env.EGRESS_SPACETIME_URI || 'https://maincloud.spacetimedb.com';
  const db = process.env.SPACETIME_DB_IDENTITY || process.env.SPACETIME_DB || process.env.EGRESS_SPACETIME_DB || 'egress-dev';
  const url = new URL(host.replace(/^ws/, 'http'));
  url.pathname = `/v1/database/${encodeURIComponent(db)}/call/import_session`;
  const response = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([action, id, token, value]), cache: 'no-store',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Phone upload storage is unavailable. Please try again.');
  const result = JSON.parse(await response.json());
  if (result.error) throw new Error(result.error);
  return result;
}
export async function createSession() {
  const id = randomBytes(16).toString('hex');
  const reader = randomBytes(32).toString('hex'), uploader = randomBytes(32).toString('hex');
  const { expires } = await call('create', id, reader, uploader);
  return { id, reader, uploader, expires };
}
export async function getSession(id: string, token: string, role: 'reader' | 'uploader') {
  return call(role === 'reader' ? 'read' : 'check', id, token);
}
export async function saveImage(id: string, token: string, image: string) {
  await call('upload', id, token, image);
}
export async function removeSession(id: string, token: string) {
  await call('remove', id, token);
}
export function bearer(request: Request) { return request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''; }
export function sessionError(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'Upload failed.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}
