'use client';
import { useEffect, useState } from 'react';
export default function ScanPage() {
  const [credentials, setCredentials] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { const update = () => { setCredentials(location.hash.slice(1)); setStatus(''); }; update(); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
  useEffect(() => { if (!file) return; const url = URL.createObjectURL(file); setPreview(url); return () => URL.revokeObjectURL(url); }, [file]);
  const choose = (f?: File) => {
    if (!f) return;
    if (!['image/png','image/jpeg','image/webp'].includes(f.type) || f.size > 10*1024*1024) { setStatus('Choose a PNG, JPEG, or WebP smaller than 10 MB.'); return; }
    setFile(f); setStatus('');
  };
  const upload = async () => {
    if (!file) return;
    setBusy(true); setStatus('Sending your floor plan…');
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) { bitmap.close(); throw new Error('Unable to prepare this photo.'); }
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
      const photo = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('Unable to prepare this photo.')),
        'image/jpeg', 0.85,
      ));
      if (photo.size > 4 * 1024 * 1024) throw new Error('This photo is too large. Choose a smaller image.');
      const [id, token] = credentials.split('.');
      const response = await fetch(`/api/import-sessions/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': photo.type }, body: photo });
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      setStatus('Sent! Continue reviewing your floor plan on the desktop.');
    } catch(e) { setStatus(e instanceof Error ? e.message : 'Upload failed. Try again.'); }
    finally { setBusy(false); }
  };
  const valid = /^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(credentials);
  return <main className="scan-page"><div className="scan-card"><span className="import-eyebrow">EXITCRAFT · SKETCH TO HOUSE</span><h1>Your sketch, a little more real.</h1><p>Photograph the drawing straight from above, with the whole plan in frame and good lighting.</p>{!valid ? <p role="alert">Open a fresh QR code from the desktop editor.</p> : <><label className="import-action">Take a photo<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" capture="environment" disabled={busy} onChange={e=>choose(e.target.files?.[0])}/></label><label className="import-action secondary">Choose a photo<input className="sr-only" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>choose(e.target.files?.[0])}/></label>{preview && <img className="scan-preview" src={preview} alt="Photo to send"/>}<button disabled={!file || busy} onClick={upload}>Send to desktop</button></>}<p role="status">{status}</p></div></main>;
}
