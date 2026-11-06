import { randomUUID } from 'node:crypto';
import { afterAll, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir } from './helpers.js';
vi.mock('electron', () => ({ safeStorage: {}, clipboard: {}, shell: {} }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));
const { openInPreferredBrowser } = await import('../src/main/browser.js');
const { initConfigPath, defaultConfig, saveConfig } = await import('../src/main/config.js');
const { initDurableStore, writeDurableNow, flushDurable } = await import('../src/main/durable.js');
const { initSessionStore, createSession, appendEvent, readEvents, flushSessions, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { studioControls, stopStudio } = await import('../src/main/ai-studio/index.js');
let temporary: string;
afterAll(async () => { stopStudio(); await flushSessions(); await flushDurable(); resetSessionStoreForTests(); if (temporary) await removeTempDir(temporary); });
it('loads an existing binding and marks a crashed turn interrupted without replaying any native send', async () => {
  temporary = await makeTempDir('cos-studio-restore-'); initConfigPath(temporary); initDurableStore(temporary); initSessionStore(temporary);
  await saveConfig(defaultConfig());
  const id = randomUUID(), conversationId = `studio-${id}`, turnId = randomUUID();
  const session = await createSession({ conversationId, title: 'Synthetic interrupted coding task' });
  await appendEvent(session.id, { kind: 'turn_start', source: 'app', time: Date.now(), turnId });
  await writeDurableNow('ai-studio-chats', { version: 1, chats: [{ id, sessionId: session.id, conversationId,
    title: 'Synthetic interrupted coding task', rootName: 'project', coding: true, url: 'https://aistudio.google.com/prompts/new_chat' }] });
  const controls = await studioControls(session.id);
  expect(controls.chat.busy).toBe(false); expect(controls.chat.error).toContain('not retried');
  expect((await readEvents(session.id)).at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'interrupted', turnId });
  expect(openInPreferredBrowser).not.toHaveBeenCalled();
});
