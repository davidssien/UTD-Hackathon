/**
 * Egress runner entry point (Plan.md §7).
 *
 * Pass 0: config + identity bootstrap. The SpacetimeDB connection lands once
 * bindings are generated (`npm run generate -w @egress/spacetimedb`):
 *   1. connect with the token in .env.runner-token (saved on first connect)
 *   2. call register_service(EGRESS_SERVICE_SECRET) once
 *   3. subscribe to runner_queue / runner_agent_queue / runner_inputs
 *   4. claim → compile → simulate (paced) → append_replay_chunk → publish_run_result
 */
import { config, loadToken } from './config.ts';

console.log(`[runner] target ${config.spacetimeUri} / ${config.spacetimeDb}`);
console.log(`[runner] identity token ${loadToken() ? 'found' : 'not yet created (created on first connect)'}`);
console.log(`[runner] agent model ${config.nemotronModel} (fallback ${config.nemotronFallbackModel})`);
console.log('[runner] SpacetimeDB connection pending generated bindings — see Plan.md Pass 0.7.');
