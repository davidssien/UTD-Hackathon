import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = join(tmpdir(), 'exitcraft-import-sessions');
export const MAX_UPLOAD = 10 * 1024 * 1024;
const TTL = 15 * 60 * 1000;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Session = { expires: number; reader: string; uploader: string; image?: string };
const path = (id: string) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Upload session not found.');
  return join(directory, `${id}.json`);
};
export async function createSession(now = Date.now()) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const files = await readdir(directory);
  for (const file of files) {
    if (!/^[a-f0-9]{32}\.json$/.test(file)) continue;
    try { const s = JSON.parse(await readFile(join(directory, file), 'utf8')); if (s.expires < Date.now()) await unlink(join(directory, file)); } catch { /* Another request may have cleaned it. */ }
  }
  if ((await readdir(directory)).length >= 100) throw new Error('Too many active upload sessions. Try again later.');
  const id = randomBytes(16).toString('hex'), reader = randomBytes(32).toString('hex'), uploader = randomBytes(32).toString('hex');
  const expires = now + TTL;
  await writeFile(path(id), JSON.stringify({ expires, reader: hash(reader), uploader: hash(uploader) }), { mode: 0o600, flag: 'wx' });
  return { id, reader, uploader, expires };
}
export async function getSession(id: string, token: string, role: 'reader' | 'uploader'): Promise<Session> {
  let session: Session;
  try { session = JSON.parse(await readFile(path(id), 'utf8')); } catch { throw new Error('Upload session not found.'); }
  if (session.expires < Date.now()) { await unlink(path(id)).catch(() => {}); throw new Error('Upload session expired. Create a new QR code.'); }
  if (!timingSafeEqual(Buffer.from(hash(token)), Buffer.from(session[role]))) throw new Error('Invalid upload session token.');
  return session;
}
export async function saveImage(id: string, token: string, image: string) {
  const session = await getSession(id, token, 'uploader');
  // A session holds one latest image; desktop review is always explicit.
  const temporary = `${path(id)}.${randomBytes(8).toString('hex')}`;
  await writeFile(temporary, JSON.stringify({ ...session, image }), { mode: 0o600 });
  await rename(temporary, path(id));
}
export async function removeSession(id: string, token: string) {
  await getSession(id, token, 'reader');
  await unlink(path(id));
}
export function bearer(request: Request) { return request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''; }
export function sessionError(error: unknown) {
  return Response.json({ error: error instanceof Error ? error.message : 'Upload failed.' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
}
