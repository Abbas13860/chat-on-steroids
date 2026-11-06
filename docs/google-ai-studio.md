# Google AI Studio in this fork

This integration uses the chat at `aistudio.google.com`, signed in with your own Google
account. Choose the model in AI Studio. A Gemini API key and the ChatGPT MCP tunnel are
not required for this provider.

## Run it

1. Install dependencies with `npm ci`, then start the fork with `npm run dev`.
2. Close any other running Chat On Steroids instance while testing this fork, so the
   companion pairs with the correct local app.
3. In Chrome, Edge or Brave, load this checkout's `extension` folder as an unpacked
   extension. Reload it if that folder was already loaded, then refresh AI Studio.
4. Sign in to [Google AI Studio](https://aistudio.google.com/prompts/new_chat) in that
   browser. In the app's Setup settings, choose the same external browser.
5. Add/approve your working folder in **Settings → Workspace**. Start a chat inside
   your usual CoS project and select **Google AI Studio** in the composer. The sidebar's
   Google AI Studio shortcut also starts a Gemini chat in the main conversation view.
   An unfiled chat chooses an approved folder beside the provider selector.
6. Send a request. The app opens its own marked AI Studio tab. Keep that tab open;
   subsequent messages and local tool results use it. **Open in browser** reopens an
   idle saved chat from the sidebar menu. The ordinary **Stop** button prevents further
   steps; an already running command may
   still finish.

Messages, answers and actual tool results are stored locally in the existing session
history. Open an AI Studio chat from its row in the ordinary sidebar. It uses the same
composer, timeline, tool cards, file changes and agent plan as ChatGPT. Native transport
JSON is not shown as an assistant answer. Existing ChatGPT chats keep their original path.

## Coding behavior

The model can request the existing `read`, `find`, `exec_command`, `write_stdin`,
`apply_patch` and `update_plan` tools. Only tools enabled by the current settings are
offered. The existing approved-folder sandbox, Read-only switch, command policy and
Block/Trust rules still apply. If strict chat allowlisting is enabled, use the chat's
sidebar menu to trust it before local tool calls can run.

The web chat has no native MCP connector for these local tools. This fork exchanges a
fresh JSON request from the model and returns the actual tool result as the next user
message. This uses the selected AI Studio model and its normal account limits.
The first request tells the model to inspect the project and AGENTS.md, make focused
edits, run suitable checks and continue through tool results until the task is complete
or a real blocker requires the user. Substantial tasks can display `update_plan` in the
shared agent-plan view. Ordinary questions can be answered without running a tool.

## Current bounds and recovery

- Text chat and local coding are supported. File uploads, image tool output, Goal/Loop,
  workers and Compact & Resume are not connected to this provider yet.
- A request stops after 64 tool steps or a browser response exceeding 200,000 characters.
  Long tool results are explicitly truncated; ask for a smaller range to read more.
- Do not type into the app-owned browser chat while an app request is running. Unsent
  drafts and unexpected new user turns stop delivery instead of being overwritten.
- On a login prompt, quota error, browser reload or lost response, inspect the browser
  tab. The app never automatically repeats a claimed send or its local tool side effect.
  Stop the app request, open the chat again, and send a new message after resolving the
  issue. Pending work is not replayed when the app restarts.
- Deleted canonical sessions cannot be used for new tool calls. The provider binding
  index is in `state/ai-studio-chats.json`; do not repair live state by editing that file.
  Stop a busy chat before removing it through the existing sidebar menu.

## Validation

`npm run typecheck`, `npm run build`, and the AI Studio Vitest suites check the source,
DOM fixtures, delivery custody and real local tool execution. A live end-to-end check
also needs this fork running, its updated companion loaded, and your signed-in browser.
No source-only check should be reported as proof of that installed-account workflow.
