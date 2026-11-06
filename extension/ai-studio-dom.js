/* Google AI Studio's public, rendered DOM only. No account APIs, Angular internals or keys. */
(() => {
  const visible = node => !!node && node.getClientRects().length > 0;
  const enabled = node => visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  const editor = () => [...document.querySelectorAll('textarea[formcontrolname="promptText"][aria-label="Enter a prompt"]')].find(visible);
  const runButton = () => [...document.querySelectorAll('ms-run-button button')].find(visible);
  const busy = () => /\bstop\b/i.test(`${runButton()?.getAttribute('aria-label') || ''} ${runButton()?.textContent || ''}`);
  const turns = () => [...document.querySelectorAll('ms-chat-turn[id]')];
  const prefix = root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let value = ''; let node;
    while (value.length < 256 && (node = walker.nextNode())) value += (node.textContent || '').slice(0, 256 - value.length);
    return value;
  };
  const text = turn => [...turn.querySelectorAll('ms-text-chunk')]
    .filter(chunk => !chunk.closest('ms-thought-chunk'))
    .map(chunk => {
      // A chunk can render multiple sibling Markdown nodes (including JSON lines).
      // Reading only its first node can return just "{". Nested nodes already belong
      // to their outer node and must not be duplicated in code or ordinary prose.
      const roots = [...chunk.querySelectorAll('ms-cmark-node')]
        .filter(root => !root.parentElement?.closest('ms-cmark-node'));
      // User prefixes only identify the receipt; model text includes every block.
      return role(turn) === 'User' ? prefix(chunk) : roots.map(root => root.innerText).join('\n');
    }).join('\n').trim();
  const role = turn => turn.querySelector('[data-turn-role]')?.getAttribute('data-turn-role') ||
    (turn.querySelector('.chat-turn-container.user') ? 'User' : turn.querySelector('.chat-turn-container.model') ? 'Model' : null);
  function snapshot() {
    const error = [...document.querySelectorAll('[role="alert"]')].filter(visible)
      .map(node => (node.innerText || node.textContent || '').trim())
      .find(value => /permission denied|failed to generate|quota|rate limit|access restricted/i.test(value));
    const rows = turns();
    return { busy: busy(), ready: enabled(editor()), draft: editor()?.value || '',
      error: error?.slice(0, 500) || null,
      // Historical model prose is never re-serialized on every poll. User prefixes carry
      // only bounded receipt evidence; only the newest model row needs its actual output.
      turns: rows.map((turn, index) => ({ id: turn.id, role: role(turn), text: role(turn) === 'User' || index === rows.length - 1 ? text(turn) : '',
        // The final response owns the feedback footer; the separate Thoughts row does not.
        done: !!turn.querySelector('.turn-footer button[aria-label="Good response"]') })) };
  }
  async function send(value) {
    const input = editor();
    if (!enabled(input) || busy() || input.value.trim()) throw new Error('AI Studio is busy, signed out, or has an unsent draft. Open its tab and clear the draft before sending.');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (!setter) throw new Error('The AI Studio composer is unavailable.');
    input.focus(); setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    // Angular updates prompt validity after the input event. Wait for its rendered Run
    // control instead of sending a synthetic hotkey while the form still has old state.
    const deadline = Date.now() + 5000;
    do {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (input !== editor() || input.value !== value || busy()) throw new Error('The AI Studio composer changed before sending. Nothing was sent again.');
      const run = runButton();
      if (enabled(run) && /\brun\b/i.test(run.textContent || '')) { run.click(); return true; }
    } while (Date.now() < deadline);
    throw new Error('AI Studio did not enable Run. Check its tab; the prompt was left in the composer.');
  }
  function stop() { if (busy()) runButton().click(); }
  globalThis.COS_STUDIO_DOM = Object.freeze({ snapshot, send, stop });
})();
