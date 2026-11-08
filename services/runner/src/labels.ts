/**
 * Room labelling (PLAN.md §3 E, D73). One Nemotron call per request labels every room from its
 * geometry facts; anything missing or invalid falls back to the rules, so a label always lands.
 */
import { RoomKindSchema, ruleLabels, type RoomFacts, type RoomLabel } from '@egress/core';
import { z } from 'zod';
import { hasNemotronKey } from './llm.ts';
import { chat } from './nemotron.ts';

export interface LabelBackend {
  claimLabelRequest(projectId: string): Promise<void>;
  publishRoomLabels(projectId: string, labels: string, source: 'nemotron' | 'rules'): Promise<void>;
}

const PROMPT = `You label rooms in a building floor plan for an evacuation tool. For each room you get geometry facts:
area (m²), narrow and long side of its bounding box (m), counts of doors, exits and windows, how many neighbouring rooms it connects to by doors, how many of its walls are outside walls, and a rule-based guess.
Decide its kind: "room" (an ordinary occupied room), "hallway" (corridor or circulation space), "lobby" (large entry or circulation hub), "stair", "closet" (small storage), or "other".
Give it a short human name (max 3 words, e.g. "Office", "Corridor", "Main hall"). Use distinct names.
Answer with ONLY a JSON array: [{"roomHash": "...", "kind": "...", "name": "...", "confidence": 0.0-1.0}], one entry per room.`;

const Answer = z.array(z.object({ roomHash: z.string(), kind: RoomKindSchema, name: z.string().trim().min(1).max(60), confidence: z.number().min(0).max(1) }));

/** Nemotron labels merged over the rule labels; returns which source was used. */
export async function labelRooms(rooms: RoomFacts[], log: (line: string) => void = () => {}): Promise<{ labels: RoomLabel[]; source: 'nemotron' | 'rules' }> {
  const fallback = ruleLabels(rooms);
  if (!rooms.length || !hasNemotronKey()) return { labels: fallback, source: 'rules' };
  try {
    const { message } = await chat([
      { role: 'system', content: PROMPT },
      { role: 'user', content: JSON.stringify(rooms.map(r => ({ roomHash: r.roomHash, areaM2: r.areaM2, widthM: r.widthM, lengthM: r.lengthM, doors: r.doors, exits: r.exits, windows: r.windows, neighbours: r.neighbours.length, exteriorWalls: r.exteriorWalls, ruleGuess: r.ruleKind }))) },
    ], { temperature: 0, maxTokens: 1200, timeoutMs: 30_000, thinking: false });
    // With thinking off the answer is in content; read the reasoning only if content came back empty.
    const text = message.content || String((message as { reasoning_content?: unknown }).reasoning_content ?? '');
    const json = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1);
    const answer = Answer.parse(JSON.parse(json));
    const byHash = new Map(answer.map(a => [a.roomHash, a]));
    const labels = fallback.map(f => {
      const a = byHash.get(f.roomHash);
      return a ? { roomHash: f.roomHash, kind: a.kind, name: a.name, confidence: a.confidence, source: 'nemotron' as const } : f;
    });
    return { labels, source: 'nemotron' };
  } catch (e) {
    log(`[labels] Nemotron labelling failed, using rules: ${e instanceof Error ? e.message : String(e)}`);
    return { labels: fallback, source: 'rules' };
  }
}

export async function processLabelRequest(backend: LabelBackend, request: { projectId: string; rooms: string }, log: (line: string) => void): Promise<void> {
  try {
    await backend.claimLabelRequest(request.projectId);
    const rooms = JSON.parse(request.rooms) as RoomFacts[];
    const { labels, source } = await labelRooms(rooms, log);
    await backend.publishRoomLabels(request.projectId, JSON.stringify(labels.map(({ roomHash, kind, name, confidence }) => ({ roomHash, kind, name, confidence }))), source);
    log(`[labels] ${request.projectId}: ${labels.length} room(s) labelled by ${source}`);
  } catch (e) {
    log(`[labels] ${request.projectId} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
