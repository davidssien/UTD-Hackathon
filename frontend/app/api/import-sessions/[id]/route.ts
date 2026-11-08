import sharp from 'sharp';
import { bearer, getSession, saveImage, removeSession, MAX_UPLOAD, sessionError } from '@/lib/server/import-sessions';
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    const session = await getSession(id, bearer(request), 'reader');
    return Response.json({ expires: session.expires, image: session.image ?? null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return sessionError(e); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { id } = await context.params;
    await getSession(id, bearer(request), 'uploader');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(request.headers.get('content-type') ?? '')) throw new Error('Choose a PNG, JPEG, or WebP image.');
    const reader = request.body?.getReader();
    if (!reader) throw new Error('Choose an image.');
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > MAX_UPLOAD) { await reader.cancel(); throw new Error('Choose an image smaller than 10 MB.'); }
      chunks.push(value);
    }
    let output: Buffer;
    try { output = await sharp(Buffer.concat(chunks), { limitInputPixels: 40_000_000 }).rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).flatten({ background: '#fff' }).png().toBuffer(); }
    catch { throw new Error('This image could not be decoded. Try another PNG, JPEG, or WebP image.'); }
    await saveImage(id, bearer(request), `data:image/png;base64,${output.toString('base64')}`);
    return Response.json({ uploaded: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return sessionError(e); }
}
export async function DELETE(request: Request, context: Context) {
  try { const { id } = await context.params; await removeSession(id, bearer(request)); return new Response(null, { status: 204 }); }
  catch (e) { return sessionError(e); }
}
