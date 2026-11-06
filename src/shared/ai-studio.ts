/** The browser account owns the model; no Gemini API key is used. */
export const STUDIO_ORIGIN = 'https://aistudio.google.com';
export const STUDIO_NEW_CHAT = `${STUDIO_ORIGIN}/prompts/new_chat`;
export const STUDIO_MAX_TEXT = 200_000;
export const STUDIO_TOOLS = ['read', 'find', 'exec_command', 'write_stdin', 'apply_patch', 'update_plan'] as const;
export type StudioTool = typeof STUDIO_TOOLS[number];
export interface StudioChat {
  id: string;
  sessionId: string;
  conversationId: string;
  title: string;
  url: string;
  rootName: string | null;
  coding: boolean;
}
export interface StudioChatView extends StudioChat {
  busy: boolean;
  connected: boolean;
  error: string | null;
}
export interface StudioState {
  chats: StudioChatView[];
  roots: Array<{ name: string; path: string }>;
}
export interface StudioSend {
  chatId?: string;
  sessionId?: string;
  projectId?: string;
  text: string;
  rootName?: string;
  coding?: boolean;
}
export interface StudioControls { chat: StudioChatView; plan: AgentPlan | null }
export function studioUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.origin === STUDIO_ORIGIN && /^\/prompts\/(?:new_chat|[a-zA-Z0-9_-]{8,160})$/.test(url.pathname)
      ? `${url.origin}${url.pathname}` : null;
  } catch { return null; }
}
export function isStudioConversation(id: string | null | undefined): boolean {
  return typeof id === 'string' && /^studio-[a-f0-9-]{36}$/.test(id);
}
export interface StudioToolCall { cos_tool: string; name: StudioTool; arguments: Record<string, unknown> }
/** Only a complete, fresh envelope is executable. Prose and ordinary code examples stay text. */
export function studioToolCall(text: string, nonce: string): StudioToolCall | null {
  const raw = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.cos_tool !== nonce || !(STUDIO_TOOLS as readonly unknown[]).includes(row.name) ||
      !row.arguments || typeof row.arguments !== 'object' || Array.isArray(row.arguments) ||
      Object.keys(row).some(key => !['cos_tool', 'name', 'arguments'].includes(key))) return null;
  return row as unknown as StudioToolCall;
}
import type { AgentPlan } from './agent-plan.js';
