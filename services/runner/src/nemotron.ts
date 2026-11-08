/**
 * Minimal OpenAI-compatible chat client for NVIDIA's hosted Nemotron endpoint
 * (docs/ARCHITECTURE.md §7). Plain fetch; tools in OpenAI function-calling format.
 */
import { config } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatOptions {
  model?: string;
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  /** Nemotron 3.x reasoning toggle; unverified on the hosted API (Pass 0 spike). */
  thinking?: boolean;
  timeoutMs?: number;
}

export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<{ message: ChatMessage; model: string; latencyMs: number }> {
  const model = options.model ?? config.nemotronModel;
  const started = Date.now();
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: options.temperature ?? 0.2,
    max_tokens: options.maxTokens ?? 1500,
  };
  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = 'auto';
  }
  if (options.thinking !== undefined) body.chat_template_kwargs = { enable_thinking: options.thinking };

  const response = await fetch(`${config.nemotronBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.nvidiaApiKey()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Nemotron ${model} returned ${response.status}: ${text.slice(0, 500)}`);
  }
  const json = (await response.json()) as { choices?: { message?: ChatMessage }[] };
  const message = json.choices?.[0]?.message;
  if (!message) throw new Error(`Nemotron ${model} returned no message.`);
  return { message, model, latencyMs: Date.now() - started };
}
