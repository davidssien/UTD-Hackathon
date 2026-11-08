import QRCode from 'qrcode';
import { networkInterfaces } from 'node:os';
import { createSession, sessionError } from '@/lib/server/import-sessions';

export async function POST(request: Request) {
  try {
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin && origin !== (process.env.IMPORT_PUBLIC_ORIGIN ? new URL(process.env.IMPORT_PUBLIC_ORIGIN).origin : undefined)) return Response.json({ error: 'Use the editor to create an upload session.' }, { status: 403 });
    let base = new URL(process.env.IMPORT_PUBLIC_ORIGIN || request.url);
    if (['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
      const lan = Object.values(networkInterfaces()).flat().find(a => a?.family === 'IPv4' && !a.internal);
      if (!lan) throw new Error('Set IMPORT_PUBLIC_ORIGIN to a phone-accessible LAN or HTTPS tunnel URL.');
      base = new URL(`http://${lan.address}:${base.port || '3000'}`);
    }
    if (!['http:', 'https:'].includes(base.protocol)) throw new Error('Invalid public upload URL.');
    const session = await createSession();
    const url = `${base.origin}/scan#${session.id}.${session.uploader}`;
    return Response.json({ id: session.id, token: session.reader, expires: session.expires, url, qr: await QRCode.toDataURL(url, { width: 256, margin: 2 }) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return sessionError(e); }
}
