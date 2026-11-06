import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioBroker } from '../src/main/ai-studio/broker.js';
import { STUDIO_NEW_CHAT, studioToolCall, studioUrl } from '../src/shared/ai-studio.js';

const owner = { browser: 'browser-a', tab: 10, document: 'document-a' };
const url = 'https://aistudio.google.com/prompts/prompt-123456789';
const result = { text: 'Done', messageId: 'turn-12345678-abcd', url };
afterEach(() => vi.useRealTimers());
describe('AI Studio browser custody', () => {
  it('claims once, refuses another tab/document/browser and accepts a final response once', async () => {
    const broker = new StudioBroker(); const chat = randomUUID();
    const answer = broker.request(chat, url, 'Edit the file');
    expect(broker.poll(chat, owner, 'https://aistudio.google.com/prompts/wrong-prompt-123')).toEqual({});
    const job = broker.poll(chat, owner, url).job!;
    expect(job.text).toBe('Edit the file');
    expect(broker.poll(chat, owner, url)).toEqual({});
    for (const other of [{ ...owner, tab: 11 }, { ...owner, document: 'reloaded' }, { ...owner, browser: 'browser-b' }]) {
      expect(broker.poll(chat, other, url)).toEqual({});
      expect(broker.complete(chat, job.id, other, result)).toBe(false);
    }
    expect(broker.complete(chat, job.id, owner, { ...result, url: 'https://example.com' })).toBe(false);
    expect(broker.complete(chat, job.id, owner, result)).toBe(true);
    expect(broker.complete(chat, job.id, owner, result)).toBe(false);
    expect(await answer).toEqual(result); broker.stop();
  });
  it('permits only the new-chat to saved-prompt transition', async () => {
    const broker = new StudioBroker(); const chat = randomUUID();
    const answer = broker.request(chat, STUDIO_NEW_CHAT, 'hello');
    const job = broker.poll(chat, owner, STUDIO_NEW_CHAT).job!;
    expect(broker.complete(chat, job.id, owner, result)).toBe(true);
    await answer;
    const next = broker.request(chat, url, 'continue');
    const nextJob = broker.poll(chat, owner, url).job!;
    expect(broker.complete(chat, nextJob.id, owner, { ...result, url: STUDIO_NEW_CHAT })).toBe(false);
    broker.cancel(chat); await expect(next).rejects.toThrow('Stopped');
  });
  it('never replays a claimed send after timeout, Stop, or a document reload', async () => {
    vi.useFakeTimers(); const broker = new StudioBroker(100); const chat = randomUUID();
    const answer = broker.request(chat, url, 'only once'); const refused = expect(answer).rejects.toThrow('not retried');
    const job = broker.poll(chat, owner, url).job!;
    await vi.advanceTimersByTimeAsync(101); await refused;
    expect(broker.poll(chat, { ...owner, document: 'reloaded' }, url).job).toBeUndefined();
    expect(broker.complete(chat, job.id, owner, result)).toBe(false);
    expect(broker.poll(chat, owner, url, job.id)).toEqual({ cancelled: true });
    broker.stop();
  });
  it('does not let one chat consume or cancel another chat’s operation', async () => {
    const broker = new StudioBroker(); const a = randomUUID(); const b = randomUUID();
    const first = broker.request(a, url, 'A'); const second = broker.request(b, url, 'B');
    const jobA = broker.poll(a, owner, url).job!;
    const jobB = broker.poll(b, { ...owner, tab: 11 }, url).job!;
    expect(broker.complete(a, jobB.id, owner, result)).toBe(false);
    broker.cancel(a); await expect(first).rejects.toThrow('Stopped');
    expect(broker.complete(b, jobB.id, { ...owner, tab: 11 }, result)).toBe(true);
    expect(await second).toEqual(result);
    expect(broker.complete(a, jobA.id, owner, result)).toBe(false);
  });
  it('explains a missing or outdated companion before spending the model-response deadline', async () => {
    vi.useFakeTimers(); const broker = new StudioBroker(100_000, 100);
    const answer = broker.request(randomUUID(), url, 'not yet sent');
    const rejected = expect(answer).rejects.toThrow('Reload this fork');
    await vi.advanceTimersByTimeAsync(101); await rejected; broker.stop();
  });
});
it('executes only a complete allowed tool envelope for the current response nonce', () => {
  const envelope = { cos_tool: 'fresh', name: 'apply_patch', arguments: { patch: '*** Begin Patch\n*** End Patch' } };
  expect(studioToolCall(JSON.stringify(envelope), 'fresh')).toEqual(envelope);
  expect(studioToolCall('```json\n' + JSON.stringify(envelope) + '\n```', 'fresh')).toEqual(envelope);
  for (const text of [JSON.stringify({ ...envelope, cos_tool: 'old' }), JSON.stringify({ ...envelope, name: 'agents' }),
    JSON.stringify({ ...envelope, arguments: [] }), JSON.stringify({ ...envelope, sessionId: 'another-chat' }),
    'Example:\n' + JSON.stringify(envelope), JSON.stringify([envelope]), '<script>bad</script>']) expect(studioToolCall(text, 'fresh')).toBeNull();
});
it('accepts only exact AI Studio prompt URLs', () => {
  expect(studioUrl(url + '?key=hidden#fragment')).toBe(url);
  for (const value of ['https://aistudio.google.com.evil.test/prompts/new_chat', 'http://aistudio.google.com/prompts/new_chat',
    'https://aistudio.google.com/apps/example', 'https://aistudio.google.com/prompts/../api-keys', 'file:///prompts/new_chat']) expect(studioUrl(value)).toBeNull();
});

it('background forwarding takes identity from Chrome and refuses other origins and subframes', async () => {
  const source = readFileSync(new URL('../extension/ai-studio-background.js', import.meta.url), 'utf8');
  const { studioMessage } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const call = vi.fn(async (_path: string, _options: { body: string }) => ({ ok: true }));
  const message = { type: 'ai_studio', action: 'poll', chatId: randomUUID(), owner: { tab: 999, document: 'forged' }, url: 'https://evil.test' };
  const sender = { frameId: 0, tab: { id: 12 }, documentId: 'actual-document', url };
  await studioMessage(message, sender, call);
  expect(call).toHaveBeenCalledOnce();
  expect(JSON.parse(call.mock.calls[0]![1].body)).toMatchObject({ owner: { tab: 12, document: 'actual-document' }, url });
  call.mockClear();
  for (const other of [{ ...sender, frameId: 1 }, { ...sender, documentId: '' },
    { ...sender, url: 'https://aistudio.google.com.evil.test/prompts/new_chat' }, { ...sender, url: 'https://chatgpt.com/' }]) {
    expect(await studioMessage(message, other, call)).toMatchObject({ ok: false });
  }
  expect(call).not.toHaveBeenCalled();
});

describe('observed AI Studio public DOM', () => {
  const source = readFileSync(new URL('../extension/ai-studio-dom.js', import.meta.url), 'utf8');
  function fixture() {
    const dom = new JSDOM('<textarea aria-label="Enter a prompt" formcontrolname="promptText"></textarea><ms-run-button><button aria-disabled="false">Run</button></ms-run-button>', { url, runScripts: 'outside-only' });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value() { return this.hidden ? [] : [{}]; } });
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    dom.window.eval(source);
    const api = (dom.window as unknown as { COS_STUDIO_DOM: { snapshot(): { busy: boolean; error: string | null; turns: Array<{ id: string; role: string; text: string; done: boolean }> }; send(text: string): Promise<boolean>; stop(): void } }).COS_STUDIO_DOM;
    return { dom, api };
  }
  it('waits for the rendered Run control, and refuses unsent drafts and a running generation', async () => {
    const { dom, api } = fixture();
    try {
      const input = dom.window.document.querySelector('textarea')!;
      const inputEvent = vi.fn(); const send = vi.fn();
      input.addEventListener('input', inputEvent);
      dom.window.document.querySelector('button')!.addEventListener('click', send);
      await api.send('A\nUnicode: فارسی');
      expect(input.value).toBe('A\nUnicode: فارسی'); expect(inputEvent).toHaveBeenCalledOnce(); expect(send).toHaveBeenCalledOnce();
      await expect(api.send('do not overwrite')).rejects.toThrow('unsent draft');
      input.value = ''; dom.window.document.querySelector('button')!.textContent = 'stop';
      expect(api.snapshot().busy).toBe(true); await expect(api.send('busy')).rejects.toThrow('busy');
    } finally { dom.window.close(); }
  });
  it('keeps Thoughts separate and requires the final response’s own feedback footer', () => {
    const { dom, api } = fixture();
    try {
      dom.window.document.body.insertAdjacentHTML('beforeend', '<ms-chat-turn id="turn-thought123"><div data-turn-role="Model"><ms-thought-chunk>private reasoning</ms-thought-chunk></div></ms-chat-turn><ms-chat-turn id="turn-answer123"><div data-turn-role="Model"><ms-text-chunk><ms-cmark-node>{"cos_tool":"fresh","name":"read","arguments":{"path":"/project/README.md"}}</ms-cmark-node></ms-text-chunk></div><div class="turn-footer"><button aria-label="Good response"></button></div></ms-chat-turn>');
      const turns = api.snapshot().turns;
      expect(turns[0]).toMatchObject({ text: '', done: false });
      expect(turns[1]).toMatchObject({ role: 'Model', done: true });
      expect(studioToolCall(turns[1]!.text, 'fresh')?.name).toBe('read');
    } finally { dom.window.close(); }
  });
  it('surfaces a native provider permission error without interpreting ordinary chat text as an alert', () => {
    const { dom, api } = fixture();
    try {
      const ordinary = dom.window.document.createElement('p'); ordinary.textContent = 'Permission denied example in a document'; dom.window.document.body.append(ordinary);
      expect(api.snapshot().error).toBeNull();
      const alert = dom.window.document.createElement('div'); alert.setAttribute('role', 'alert'); alert.textContent = 'Permission denied. Please check your account permissions and project settings.'; dom.window.document.body.append(alert);
      expect(api.snapshot().error).toBe(alert.textContent);
    } finally { dom.window.close(); }
  });
  it('reads sibling Markdown blocks completely without duplicating nested code nodes', () => {
    const { dom, api } = fixture();
    try {
      dom.window.document.body.insertAdjacentHTML('beforeend', '<ms-chat-turn id="turn-answer123"><div data-turn-role="Model"><ms-text-chunk><ms-cmark-node>{</ms-cmark-node><ms-cmark-node>"cos_tool":"fresh",</ms-cmark-node><ms-cmark-node>"name":"read",</ms-cmark-node><ms-cmark-node>"arguments":<ms-cmark-node>{"paths":["/project"]}</ms-cmark-node></ms-cmark-node><ms-cmark-node>}</ms-cmark-node></ms-text-chunk></div><div class="turn-footer"><button aria-label="Good response"></button></div></ms-chat-turn>');
      const answer = api.snapshot().turns[0]!;
      expect(studioToolCall(answer.text, 'fresh')).toMatchObject({ name: 'read', arguments: { paths: ['/project'] } });
    } finally { dom.window.close(); }
  });
});

it('retains its app binding when AI Studio removes the URL fragment before mounting the composer', async () => {
  vi.useFakeTimers();
  const chatId = randomUUID(); const jobId = randomUUID();
  const dom = new JSDOM('', { url: STUDIO_NEW_CHAT + '#cos-studio=' + chatId, runScripts: 'outside-only' });
  const native = { busy: false, ready: false, draft: '', turns: [] as Array<{ id: string; role: string; text: string; done: boolean }> };
  const send = vi.fn((text: string) => {
    native.turns = [
      { id: 'turn-remounted-user', role: 'User', text: 'An earlier request, remounted after the send', done: false },
      { id: 'turn-remounted-model', role: 'Model', text: 'An earlier answer', done: true },
      { id: 'turn-user123', role: 'User', text, done: false },
      { id: 'turn-model123', role: 'Model', text: 'Connected', done: true }
    ];
  });
  let handedOut = false;
  const results: unknown[] = [];
  const runtime = { sendMessage: vi.fn(async (message: Record<string, unknown>) => {
    expect(message.chatId).toBe(chatId);
    if (message.action === 'result') {
      results.push(message); dom.window.dispatchEvent(new dom.window.Event('pagehide')); return { ok: true, data: { accepted: true } };
    }
    if (message.activeId) return { ok: true, data: { cancelled: false } };
    if (!handedOut) { handedOut = true; return { ok: true, data: { job: { id: jobId, text: 'Connection test' } } }; }
    return { ok: true, data: {} };
  }) };
  Object.assign(dom.window, { Date, COS_STUDIO_DOM: { snapshot: () => native, send, stop: vi.fn() }, chrome: { runtime } });
  try {
    dom.window.eval(readFileSync(new URL('../extension/ai-studio.js', import.meta.url), 'utf8'));
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    dom.window.history.replaceState(null, '', '/prompts/prompt-123456789');
    native.ready = true;
    await vi.advanceTimersByTimeAsync(2200);
    expect(send).toHaveBeenCalledOnce();
    expect(results).toHaveLength(0);
    // A transient first Markdown block and a premature footer must not end the job.
    native.turns[native.turns.length - 1]!.text = '{';
    await vi.advanceTimersByTimeAsync(700);
    expect(results).toHaveLength(0);
    native.turns[native.turns.length - 1]!.text = 'Connected';
    await vi.advanceTimersByTimeAsync(2800);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ action: 'result', jobId, text: 'Connected', messageId: 'turn-model123' });
  } finally { dom.window.close(); }
});
