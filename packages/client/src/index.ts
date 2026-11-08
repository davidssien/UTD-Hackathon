/**
 * @egress/client — the only backend surface the UI uses (docs/ARCHITECTURE.md §8).
 *
 *   const client = createMockClient({ seed: [{ name: 'Two rooms', doc }] });
 *   const view = useEgress(client.document);          // from '@egress/client/react'
 *   await client.edit([{ kind: 'createBox', ... }]);
 */
export type * from './types.ts';
export { createMockClient, type MockClientOptions } from './mock.ts';
export { Playback, type PlaybackClock } from './playback.ts';
export { ghostFor } from './ghost.ts';
export { writable, WritableStore } from './store.ts';
export { OptimisticDocument } from './optimistic.ts';
export { createSpacetimeClient, type SpacetimeClientOptions } from './spacetime.ts';
