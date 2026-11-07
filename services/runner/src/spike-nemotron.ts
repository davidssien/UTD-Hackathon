/**
 * Pass 0 spike (d): does the hosted Nemotron endpoint accept OpenAI-style
 * tools and the `chat_template_kwargs.enable_thinking` toggle?
 *
 *   node services/runner/src/spike-nemotron.ts
 */
import { config } from './config.ts';
import { chat, type ToolSpec } from './nemotron.ts';

const tools: ToolSpec[] = [{
  type: 'function',
  function: {
    name: 'get_hotspots',
    description: 'Return the most congested regions of a simulation run.',
    parameters: { type: 'object', properties: { runId: { type: 'string' }, topK: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['runId'] },
  },
}];

for (const model of [config.nemotronModel, config.nemotronFallbackModel]) {
  for (const thinking of [false, undefined]) {
    try {
      const { message, latencyMs } = await chat(
        [
          { role: 'system', content: 'You are a building-safety analysis agent. Use tools when they help.' },
          { role: 'user', content: 'Find the worst bottleneck in run r-123.' },
        ],
        { model, tools, thinking, maxTokens: 400 },
      );
      const call = message.tool_calls?.[0];
      console.log(`${model} thinking=${thinking ?? 'default'}: ${latencyMs} ms, tool call = ${call ? `${call.function.name}(${call.function.arguments})` : 'none'}`);
    } catch (e) {
      console.log(`${model} thinking=${thinking ?? 'default'}: FAILED ${(e as Error).message}`);
    }
  }
}
