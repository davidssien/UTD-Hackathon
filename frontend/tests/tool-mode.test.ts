import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMode, toolModeReducer } from '../lib/tool-mode.ts';

test('tool switching is exclusive and clicking the active tool exits', () => {
  const walls = toolModeReducer(initialMode, { type: 'tool', tool: 'wall' });
  const doors = toolModeReducer(walls, { type: 'tool', tool: 'door' });
  assert.equal(doors.tool, 'door');
  assert.equal(doors.panel, null);
  assert.equal(toolModeReducer(doors, { type: 'tool', tool: 'door' }).tool, 'select');
});
test('opening a category cancels placement and replaces the previous category', () => {
  const walls = toolModeReducer(initialMode, { type: 'tool', tool: 'wall' });
  const panel = toolModeReducer(walls, { type: 'panel', panel: 'furniture' });
  assert.equal(panel.tool, 'select');
  assert.equal(panel.panel, 'furniture');
  const other = toolModeReducer(panel, { type: 'panel', panel: 'build' });
  assert.equal(other.panel, 'build');
  assert.equal(toolModeReducer(other, { type: 'panel', panel: 'build' }).panel, null);
});
test('cancellation resets tools and panels and invalidates unfinished gestures', () => {
  const state = toolModeReducer({ tool: 'floor', panel: null, revision: 3 }, { type: 'cancel' });
  assert.deepEqual(state, { tool: 'select', panel: null, revision: 4 });
});
