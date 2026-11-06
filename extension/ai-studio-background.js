/** Identity comes from Chrome, never from a model/page argument. Pairing stays in background.js. */
export async function studioMessage(message, sender, call) {
  let url;
  try { url = new URL(sender.url); } catch { return { ok: false, error: 'invalid_studio_sender' }; }
  if (sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !sender.documentId ||
      url.origin !== 'https://aistudio.google.com' || !/^\/prompts\/(new_chat|[a-zA-Z0-9_-]{8,160})$/.test(url.pathname) ||
      !/^[a-f0-9-]{36}$/.test(message.chatId || '')) return { ok: false, error: 'invalid_studio_sender' };
  const owner = { tab: sender.tab.id, document: sender.documentId };
  const base = { chatId: message.chatId, owner, url: sender.url };
  let body;
  if (message.action === 'poll') {
    if (message.activeId !== undefined && !/^[a-f0-9-]{36}$/.test(message.activeId)) return { ok: false, error: 'invalid_job' };
    body = { ...base, action: 'poll', ...(message.activeId ? { activeId: message.activeId } : {}) };
  } else if (message.action === 'result' && /^[a-f0-9-]{36}$/.test(message.jobId || '') &&
      typeof message.text === 'string' && message.text.length <= 200_000 &&
      typeof message.messageId === 'string' && message.messageId.length <= 120 &&
      (message.error === undefined || (typeof message.error === 'string' && message.error.length <= 500))) {
    body = { ...base, action: 'result', jobId: message.jobId, text: message.text, messageId: message.messageId, error: message.error };
  } else return { ok: false, error: 'invalid_studio_message' };
  return call('/ai-studio', { method: 'POST', body: JSON.stringify(body) });
}
