/**
 * Adapts the Nemotron chat client to the agent's ChatFn, with the fallbacks
 * the Pass 0 spike may need: drop `chat_template_kwargs` if the hosted API
 * rejects it, and switch to the fallback model if the primary is unavailable.
 */
import type { ChatFn } from '@egress/agent';
import { config } from './config.ts';
import { chat, type ChatMessage } from './nemotron.ts';

export function nemotronChatFn(log: (line: string) => void = () => {}): ChatFn {
  let model = config.nemotronModel;
  let sendThinkingFlag = true;
  return async (messages, tools) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { message, latencyMs } = await chat(messages as ChatMessage[], { model, tools, thinking: sendThinkingFlag ? false : undefined, maxTokens: 1200 });
        log(`[nemotron] ${model} ${latencyMs} ms${message.tool_calls?.length ? ` → ${message.tool_calls.map(c => c.function.name).join(', ')}` : ''}`);
        return message;
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        if (sendThinkingFlag && /chat_template_kwargs|enable_thinking|400/.test(text)) {
          sendThinkingFlag = false;
          log('[nemotron] retrying without chat_template_kwargs');
          continue;
        }
        if (model !== config.nemotronFallbackModel && /404|not found|unavailable|503/i.test(text)) {
          log(`[nemotron] ${model} unavailable, switching to ${config.nemotronFallbackModel}`);
          model = config.nemotronFallbackModel;
          continue;
        }
        throw e;
      }
    }
    throw new Error('Nemotron did not respond after retries.');
  };
}

export const hasNemotronKey = () => !!process.env.NVIDIA_API_KEY;
