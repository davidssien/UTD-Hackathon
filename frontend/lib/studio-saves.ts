import { parseDocument, type EgressDocument } from '@egress/core';
import { createMockClient, type EgressClient } from '@egress/client';

export const STUDIO_SAVE_KEY = 'egress-studio-slots-v1';
type SavedSlot = { name: string; doc: EgressDocument };
type SavedWorkspace = { version: 1; active: number; slots: SavedSlot[] };

/** Browser persistence around the existing client; no second edit model. */
export function createLocalStudioClient(storage: Pick<Storage, 'getItem' | 'setItem'>, example: EgressDocument, onError: (message: string) => void = () => {}): EgressClient {
  let saved: SavedWorkspace = { version: 1, active: 0, slots: [{ name: 'Courtyard study', doc: example }] };
  let canSave = true;
  try {
    const raw = storage.getItem(STUDIO_SAVE_KEY);
    if (raw) {
      const value = JSON.parse(raw) as SavedWorkspace;
      if (value.version !== 1 || !Array.isArray(value.slots) || !value.slots.length) throw new Error('Invalid save file');
      saved = { version: 1, active: Number.isInteger(value.active) ? value.active : 0, slots: value.slots.map(s => {
        if (typeof s.name !== 'string') throw new Error('Invalid slot name');
        return { name: s.name, doc: parseDocument(s.doc) };
      }) };
    }
  } catch {
    canSave = false;
    onError('Local saves could not be read. Your existing save data has been preserved; export this plan before leaving.');
  }
  const client = createMockClient({ seed: saved.slots });
  const docs = new Map(client.projects.get().map((p, i) => [p.id, saved.slots[i].doc]));
  const initial = client.projects.get()[Math.max(0, Math.min(saved.active, saved.slots.length - 1))];
  if (initial) void client.openProject(initial.id);
  const persist = () => {
    const view = client.document.get();
    if (view.doc && view.projectId) docs.set(view.projectId, view.doc);
    const projects = client.projects.get();
    if (!canSave || projects.some(p => !docs.has(p.id))) return;
    try {
      storage.setItem(STUDIO_SAVE_KEY, JSON.stringify({ version: 1, active: Math.max(0, projects.findIndex(p => p.id === view.projectId)), slots: projects.map(p => ({ name: p.name, doc: docs.get(p.id)! })) } satisfies SavedWorkspace));
    } catch {
      onError('This browser could not save your changes. Export a JSON copy before closing the page.');
    }
  };
  const unsubscribe = client.document.subscribe(persist);
  const dispose = client.dispose.bind(client);
  client.dispose = () => { persist(); unsubscribe(); dispose(); };
  persist();
  return client;
}
