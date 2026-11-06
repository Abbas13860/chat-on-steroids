/* Isolated content script: exchange one app-owned send at a time, never execute a local tool. */
(() => {
  if (globalThis.COS_STUDIO_RUNNING || !globalThis.COS_STUDIO_DOM) return;
  // Capture at document_start: AI Studio's router may replace the URL before its editor mounts.
  const id = new URLSearchParams(location.hash.slice(1)).get('cos-studio');
  if (!id || !/^[a-f0-9-]{36}$/.test(id)) return;
  globalThis.COS_STUDIO_RUNNING = true;
  const dom = globalThis.COS_STUDIO_DOM;
  let active = null;
  let retired = false;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const request = async payload => {
    const reply = await chrome.runtime.sendMessage({ type: 'ai_studio', chatId: id, ...payload });
    if (!reply?.ok) throw new Error(reply?.error || reply?.data?.error || 'The AI Studio bridge is unavailable.');
    return reply.data;
  };
  async function execute(job) {
    let error; let answer = { text: '', messageId: '', url: location.href };
    try {
      // The native renderer reformats Markdown and paragraph boundaries. A unique receipt
      // proves this newly accepted user turn without depending on a rendered-text roundtrip.
      const receipt = `COSSTUDIOINPUT${job.id.replace(/-/g, '')}`;
      await dom.send(`${receipt}\n(Transport receipt only; do not repeat it in your answer.)\n\n${job.text}`);
      const deadline = Date.now() + 9 * 60_000;
      let accepted = null;
      while (!retired && Date.now() < deadline) {
        await pause(700);
        const status = await request({ action: 'poll', activeId: job.id });
        if (status.cancelled) { dom.stop(); throw new Error('Stopped by the app.'); }
        const state = dom.snapshot();
        // Saving/virtualization can remount earlier turns under new DOM ids. The exact
        // receipt owns the boundary; newly mounted historical rows do not become new input.
        let anchor = state.turns.findIndex(turn => turn.role === 'User' && turn.text.trim().startsWith(receipt));
        if (anchor >= 0) accepted = state.turns[anchor];
        else if (accepted) anchor = state.turns.findIndex(turn => turn.id === accepted.id);
        const following = anchor >= 0 ? state.turns.slice(anchor + 1) : [];
        if (following.some(turn => turn.role === 'User')) throw new Error('The browser chat changed while this send was running. No response was executed.');
        const last = following.at(-1);
        if (accepted && last && last.role === 'Model' && last.done && !state.busy && last.text) {
          if (last.text.length > 200_000) throw new Error('The AI Studio response is too large.');
          answer = { text: last.text, messageId: last.id, url: location.href }; break;
        }
        // A successful native final is stronger than an unrelated save/dashboard toast.
        // A generation error with no verified final still stops immediately, without retry.
        if (state.error && !state.busy) throw new Error(`AI Studio: ${state.error}`);
        if (!accepted && Date.now() > deadline - 9 * 60_000 + 20_000) throw new Error('AI Studio did not accept the message. Check its tab; it was not sent again.');
      }
      if (!answer.messageId) throw new Error('AI Studio did not produce a verified final response. Check its tab before sending again.');
    } catch (reason) { error = String(reason?.message || reason).slice(0, 500); }
    // Results may be retried; sending a prompt may not. App-side job custody makes this idempotent.
    for (let attempt = 0; attempt < 3 && !retired; attempt++) {
      try { await request({ action: 'result', jobId: job.id, ...answer, ...(error ? { error } : {}) }); return; }
      catch { await pause(1000); }
    }
    retired = true;
  }
  async function loop() {
    while (!retired) {
      try {
        // Angular may mount its composer after document_idle. A page that is still loading
        // must not consume a one-shot send before it can actually insert it.
        if (!dom.snapshot().ready) { await pause(1200); continue; }
        const result = await request({ action: 'poll' });
        if (result.job) { active = result.job.id; await execute(result.job); active = null; }
      } catch { /* Pairing or app startup may be in progress; no claimed send is repeated. */ }
      await pause(1200);
    }
  }
  addEventListener('pagehide', () => { retired = true; if (active) dom.stop(); }, { once: true });
  void loop();
})();
