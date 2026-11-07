import type { Tool } from './building-editor';

export type ToolMode = { tool: Tool; panel: 'build' | 'furniture' | null; revision: number };
export type ModeAction = { type: 'tool'; tool: Tool } | { type: 'panel'; panel: 'build' | 'furniture' } | { type: 'cancel' };
export const initialMode: ToolMode = { tool: 'select', panel: null, revision: 0 };
export function toolModeReducer(state: ToolMode, action: ModeAction): ToolMode {
  if (action.type === 'cancel') return { ...initialMode, revision: state.revision + 1 };
  if (action.type === 'panel') return { tool: 'select', panel: state.panel === action.panel ? null : action.panel, revision: state.revision + 1 };
  return { tool: state.tool === action.tool ? 'select' : action.tool, panel: null, revision: state.revision + 1 };
}
