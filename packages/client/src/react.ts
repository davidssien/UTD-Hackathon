import { useSyncExternalStore } from 'react';
import type { Store } from './types.ts';

/** Subscribe a React component to any EgressClient store. */
export function useEgress<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
