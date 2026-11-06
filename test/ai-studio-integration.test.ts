import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { makeTempDir, removeTempDir, faultGate } from './helpers.js';
import type { StudioChat } from '../src/shared/ai-studio.js';

vi.mock('electron', () => ({ safeStorage: {}, clipboard: {}, shell: {} }));
vi.mock('../src/main/browser.js', () => ({ openInPreferredBrowser: vi.fn(async () => 'chrome.exe') }));
const { initConfigPath, defaultConfig, saveConfig, getConfig } = await import('../src/main/config.js');
const { initDurableStore, flushDurable } = await import('../src/main/durable.js');
const { initSessionStore, readEvents, flushSessions, resetSessionStoreForTests } = await import('../src/main/session/store.js');
const { sendStudioInput, studioPageRequest, studioState, studioControls, cancelStudioInput, forgetStudioSession, stopStudio } = await import('../src/main/ai-studio/index.js');
const { addProject } = await import('../src/main/projects.js');
const { openInPreferredBrowser } = await import('../src/main/browser.js');
const correlations = await import('../src/main/session/correlation.js');
const connectorProof = await import('../src/main/connector-proof.js');
let temporary: string;
let workspace: string;
const owner = { tab: 12, document: 'studio-test-document' };
const browser = 'testbrowser123456';
beforeAll(async () => {
  temporary = await makeTempDir('cos-studio-test-'); workspace = path.join(temporary, 'workspace');
  await fs.mkdir(workspace); await fs.writeFile(path.join(workspace, 'original.txt'), 'actual local file content\n');
  initConfigPath(temporary); initDurableStore(temporary); initSessionStore(temporary);
  await saveConfig({ ...defaultConfig(), roots: [{ name: 'project', path: workspace }], multiAgent: { ...defaultConfig().multiAgent, enabled: false } });
});
afterAll(async () => {
  stopStudio(); await flushSessions(); await flushDurable(); resetSessionStoreForTests(); await removeTempDir(temporary);
});
interface Job { id: string; text: string }
async function claim(chat: StudioChat): Promise<Job> {
  let job: Job | undefined;
  await vi.waitFor(async () => {
    const result = await studioPageRequest({ action: 'poll', chatId: chat.id, owner, url: chat.url }, browser) as { job?: Job };
    job = result.job; expect(job).toBeTruthy();
  });
  return job!;
}
const nonce = (job: Job): string => [...job.text.matchAll(/"cos_tool":"([a-f0-9-]{36})"/g)].at(-1)![1]!;
async function answer(chat: StudioChat, job: Job, text: string) {
  return studioPageRequest({ action: 'result', chatId: chat.id, owner, url: chat.url, jobId: job.id,
    text, messageId: `turn-${job.id}` }, browser);
}
async function finished(chat: StudioChat) {
  await vi.waitFor(async () => expect((await studioState()).chats.find(row => row.id === chat.id)?.busy).toBe(false));
}
it('reads a real approved file, edits through the real patch tool, records results and returns them to the same chat', async () => {
  const chat = await sendStudioInput({ text: 'Read original.txt and create greeting.txt.', coding: true, rootName: 'project' });
  const read = await claim(chat);
  await answer(chat, read, JSON.stringify({ cos_tool: nonce(read), name: 'read', arguments: { paths: ['/project/original.txt'] } }));
  const edit = await claim(chat);
  expect(edit.text).toContain('actual local file content');
  expect(nonce(edit)).not.toBe(nonce(read));
  await answer(chat, edit, JSON.stringify({ cos_tool: nonce(edit), name: 'apply_patch', arguments: {
    patch: '*** Begin Patch\n*** Add File: greeting.txt\n+Hello from AI Studio\n*** End Patch' } }));
  const command = await claim(chat);
  expect(command.text).toContain('Local tool result for apply_patch (returned)');
  expect(await fs.readFile(path.join(workspace, 'greeting.txt'), 'utf8')).toBe('Hello from AI Studio\n');
  await answer(chat, command, JSON.stringify({ cos_tool: nonce(command), name: 'exec_command', arguments: {
    cmd: 'node -e "process.stdout.write(\'COS_COMMAND_OK\')"', workdir: '/project', login: false, yield_time_ms: 1000, max_output_tokens: 1000 } }));
  const done = await claim(chat);
  expect(done.text).toContain('COS_COMMAND_OK');
  await answer(chat, done, 'Created greeting.txt and verified its contents.'); await finished(chat);
  const events = await readEvents(chat.sessionId);
  expect(events.filter(event => event.kind === 'tool_call').map(event => event.kind === 'tool_call' && [event.call.tool, event.call.outcome])).toEqual([['read', 'ok'], ['apply_patch', 'ok'], ['exec_command', 'ok']]);
  expect(events.at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'completed' });
  expect(events.filter(event => event.kind === 'assistant_message' && event.final)).toHaveLength(1);
});
it('enforces read-only changes made after a browser prompt was already delivered', async () => {
  const chat = await sendStudioInput({ text: 'Do a task', coding: true, rootName: 'project' });
  const job = await claim(chat); await saveConfig({ ...getConfig(), readOnly: true });
  try {
    await answer(chat, job, JSON.stringify({ cos_tool: nonce(job), name: 'apply_patch', arguments: {
      patch: '*** Begin Patch\n*** Add File: forbidden.txt\n+Must not exist\n*** End Patch' } }));
    const result = await claim(chat);
    expect(result.text).toContain('Local tool result for apply_patch (error)');
    await expect(fs.stat(path.join(workspace, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await answer(chat, result, 'The app refused the edit.'); await finished(chat);
  } finally { await saveConfig({ ...getConfig(), readOnly: false }); }
});
it('stops a claimed operation and refuses its late response without running its tool', async () => {
  const chat = await sendStudioInput({ text: 'Wait for my next instruction', coding: true, rootName: 'project' });
  const job = await claim(chat); await cancelStudioInput(chat.id);
  expect(await answer(chat, job, JSON.stringify({ cos_tool: nonce(job), name: 'apply_patch', arguments: {
    patch: '*** Begin Patch\n*** Add File: after-stop.txt\n+Must not exist\n*** End Patch' } }))).toEqual({ accepted: false });
  await finished(chat);
  await expect(fs.stat(path.join(workspace, 'after-stop.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readEvents(chat.sessionId)).at(-1)).toMatchObject({ kind: 'turn_end', outcome: 'interrupted' });
});
it('keeps ordinary chat tool-free, even when the answer looks like a tool envelope', async () => {
  const chat = await sendStudioInput({ text: 'Explain a snippet', coding: false }); const job = await claim(chat);
  await answer(chat, job, '{"cos_tool":"example","name":"exec_command","arguments":{"cmd":"do not run"}}');
  await finished(chat);
  expect((await readEvents(chat.sessionId)).some(event => event.kind === 'tool_call')).toBe(false);
});
it('rechecks Stop after awaited ownership publication and before admitting a local mutation', async () => {
  const chat = await sendStudioInput({ text: 'Wait during tool admission', coding: true, rootName: 'project' });
  const job = await claim(chat);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const original = correlations.commitRequestCorrelations;
  const spy = vi.spyOn(correlations, 'commitRequestCorrelations').mockImplementationOnce(async () => { entered = true; await gate; await original(); });
  try {
    await answer(chat, job, JSON.stringify({ cos_tool: nonce(job), name: 'apply_patch', arguments: {
      patch: '*** Begin Patch\n*** Add File: admission-stopped.txt\n+Must not exist\n*** End Patch' } }));
    await vi.waitFor(() => expect(entered).toBe(true));
    await cancelStudioInput(chat.id); release(); await finished(chat);
    await expect(fs.stat(path.join(workspace, 'admission-stopped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { release(); spy.mockRestore(); }
});
it('reserves the eight-chat limit before concurrent IPC admissions can overbook it', async () => {
  const replies = await Promise.allSettled(Array.from({ length: 10 }, () => sendStudioInput({ text: 'Pending admission fixture', coding: false })));
  const accepted = replies.filter((row): row is PromiseFulfilledResult<StudioChat> => row.status === 'fulfilled');
  expect(accepted).toHaveLength(8);
  expect(replies.filter(row => row.status === 'rejected')).toHaveLength(2);
  for (const row of accepted) await cancelStudioInput(row.value.id);
  for (const row of accepted) await finished(row.value);
});
it('refuses deletion during work and removes its provider title/URL copy after Stop', async () => {
  const chat = await sendStudioInput({ text: 'Delete this synthetic fixture later', coding: false });
  await claim(chat);
  await expect(forgetStudioSession(chat.sessionId)).rejects.toThrow('Stop this AI Studio chat');
  await cancelStudioInput(chat.id); await finished(chat);
  await forgetStudioSession(chat.sessionId);
  expect((await studioState()).chats.some(row => row.id === chat.id)).toBe(false);
  const saved = await fs.readFile(path.join(temporary, 'state', 'ai-studio-chats.json'), 'utf8');
  expect(saved).not.toContain(chat.id); expect(saved).not.toContain(chat.title);
});
it('uses the shared project folder for real commands and publishes the same agent plan as other CoS chats', async () => {
  const folder = path.join(workspace, 'nested-project'); await fs.mkdir(folder);
  const project = await addProject(folder, { chatgpt: 'later' });
  const chat = await sendStudioInput({ text: 'Inspect this project and show a plan.', coding: true, projectId: project.id });
  const command = await claim(chat);
  expect(command.text).toContain('/project/nested-project');
  await answer(chat, command, JSON.stringify({ cos_tool: nonce(command), name: 'exec_command', arguments: {
    cmd: 'node -e "process.stdout.write(process.cwd())"', login: false, yield_time_ms: 1000, max_output_tokens: 1000 } }));
  const plan = await claim(chat);
  expect(plan.text).toContain(folder);
  await answer(chat, plan, JSON.stringify({ cos_tool: nonce(plan), name: 'update_plan', arguments: {
    plan: [{ step: 'Inspect project', status: 'completed' }, { step: 'Validate result', status: 'in_progress' }] } }));
  const next = await claim(chat);
  expect(next.text).toContain('Plan updated');
  expect((await studioControls(chat.sessionId)).plan?.plan).toEqual([
    { step: 'Inspect project', status: 'completed' }, { step: 'Validate result', status: 'in_progress' }
  ]);
  await answer(chat, next, 'Project inspected.'); await finished(chat);
});
it('does not turn Gemini tool execution into false ChatGPT connector setup proof', async () => {
  const proof = vi.spyOn(connectorProof, 'noteConnectorUse');
  try {
    const chat = await sendStudioInput({ text: 'Read the original file', coding: true, rootName: 'project' });
    const read = await claim(chat);
    await answer(chat, read, JSON.stringify({ cos_tool: nonce(read), name: 'read', arguments: { paths: ['/project/original.txt'] } }));
    const result = await claim(chat); expect(result.text).toContain('actual local file content');
    expect(proof).not.toHaveBeenCalled();
    await answer(chat, result, 'Read the original file.'); await finished(chat);
  } finally { proof.mockRestore(); }
});
it('does not open a replacement tab when its browser disappears during a local tool call', async () => {
  const chat = await sendStudioInput({ text: 'Read a file, then stop if the browser disappears', coding: true, rootName: 'project' });
  const job = await claim(chat); const gate = faultGate();
  const original = correlations.commitRequestCorrelations;
  const hold = vi.spyOn(correlations, 'commitRequestCorrelations').mockImplementationOnce(async () => { await gate.hold(); await original(); });
  let clock: ReturnType<typeof vi.spyOn> | undefined;
  const opens = vi.mocked(openInPreferredBrowser).mock.calls.length;
  try {
    await answer(chat, job, JSON.stringify({ cos_tool: nonce(job), name: 'read', arguments: { paths: ['/project/original.txt'] } }));
    await gate.entered;
    const now = Date.now(); clock = vi.spyOn(Date, 'now').mockReturnValue(now + 20_000);
    gate.release(); await finished(chat);
    expect((await studioControls(chat.sessionId)).chat.error).toContain('No browser tab was reopened');
    expect(vi.mocked(openInPreferredBrowser).mock.calls).toHaveLength(opens);
  } finally { gate.release(); clock?.mockRestore(); hold.mockRestore(); }
});
