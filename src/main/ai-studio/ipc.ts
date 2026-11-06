import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { startBridge } from '../bridge.js';
import { cancelStudioInput, openStudioChat, sendStudioInput, studioHistory, studioState, studioControls } from './index.js';
import type { StudioSend } from '../../shared/ai-studio.js';

export function registerStudioIpc(getWindow: () => BrowserWindow | null): void {
  const chatId = z.object({ id: z.string().uuid() }).strict();
  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    'studio:state': () => studioState(),
    'studio:controls': payload => studioControls(z.object({ sessionId: z.string().min(8).max(64).regex(/^[0-9a-z-]+$/i) }).strict().parse(payload).sessionId),
    'studio:history': payload => studioHistory(chatId.parse(payload).id),
    'studio:open': async payload => { if (!await startBridge()) throw new Error('The browser bridge could not start.'); await openStudioChat(chatId.parse(payload).id); },
    'studio:stop': payload => cancelStudioInput(chatId.parse(payload).id),
    'studio:send': async payload => {
      if (!await startBridge()) throw new Error('The browser bridge could not start.');
      return sendStudioInput(payload as StudioSend);
    }
  };
  for (const [channel, handler] of Object.entries(handlers)) ipcMain.handle(channel, async (event, payload: unknown) => {
    try {
      const target = getWindow();
      if (!target || target.isDestroyed() || event.sender !== target.webContents || event.senderFrame !== target.webContents.mainFrame) throw new Error('This request did not come from the app window.');
      return { ok: true, data: await handler(payload) };
    } catch (error) { return { ok: false, error: error instanceof z.ZodError ? 'Invalid AI Studio request.' : error instanceof Error ? error.message : 'AI Studio failed.' }; }
  });
}
