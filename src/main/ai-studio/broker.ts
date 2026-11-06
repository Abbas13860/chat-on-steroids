import { randomUUID } from 'node:crypto';
import { STUDIO_MAX_TEXT, STUDIO_NEW_CHAT, studioUrl } from '../../shared/ai-studio.js';

export interface StudioOwner { browser: string; tab: number; document: string }
export interface StudioAnswer { text: string; messageId: string; url: string }
interface Job {
  id: string;
  chatId: string;
  url: string;
  text: string;
  owner: StudioOwner | null;
  resolve: (value: StudioAnswer) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
const same = (a: StudioOwner, b: StudioOwner): boolean => a.browser === b.browser && a.tab === b.tab && a.document === b.document;

/** Process-local custody only. Claimed sends are never replayed after reload, timeout or restart. */
export class StudioBroker {
  private jobs = new Map<string, Job>();
  private pages = new Map<string, { owner: StudioOwner; at: number }>();
  constructor(private timeoutMs = 10 * 60_000, private claimTimeoutMs = 60_000) {}
  connected(chatId: string): boolean { return Date.now() - (this.pages.get(chatId)?.at ?? 0) < 15_000; }
  forgetPage(chatId: string): void { this.pages.delete(chatId); }
  request(chatId: string, url: string, text: string): Promise<StudioAnswer> {
    if (this.jobs.has(chatId)) throw new Error('This AI Studio chat is already busy.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.cancel(chatId, 'The AI Studio companion did not claim this send. Reload this fork’s extension, check Google sign-in, then open the chat and send again. The message was not retried.'), this.claimTimeoutMs);
      timer.unref?.();
      this.jobs.set(chatId, { id: randomUUID(), chatId, url, text, owner: null, resolve, reject, timer });
    });
  }
  poll(chatId: string, owner: StudioOwner, url: string, activeId?: string): { job?: { id: string; text: string }; cancelled?: boolean } {
    const job = this.jobs.get(chatId);
    const page = this.pages.get(chatId);
    if (page && !same(page.owner, owner) && this.connected(chatId)) return {};
    // A claimed operation can never transfer to another document, even after its heartbeat expires.
    if (job?.owner && !same(job.owner, owner)) return {};
    const current = studioUrl(url);
    if (!current || (job && job.url !== STUDIO_NEW_CHAT && job.url !== current)) return {};
    this.pages.set(chatId, { owner: { ...owner }, at: Date.now() });
    if (activeId) return { cancelled: !job || job.id !== activeId };
    if (!job || job.owner) return {};
    job.owner = { ...owner };
    clearTimeout(job.timer);
    job.timer = setTimeout(() => this.cancel(chatId, 'AI Studio did not finish. Open its browser tab to check sign-in, quota or an interrupted response. The message was not retried.'), this.timeoutMs);
    job.timer.unref?.();
    return { job: { id: job.id, text: job.text } };
  }
  complete(chatId: string, id: string, owner: StudioOwner, answer: StudioAnswer, error?: string): boolean {
    const job = this.jobs.get(chatId);
    if (!job || job.id !== id || !job.owner || !same(job.owner, owner)) return false;
    const url = studioUrl(answer.url);
    if (!url || (job.url !== STUDIO_NEW_CHAT && job.url !== url) || answer.text.length > STUDIO_MAX_TEXT ||
        (!error && (!answer.text.trim() || !/^turn-[a-zA-Z0-9-]{8,100}$/.test(answer.messageId)))) return false;
    this.jobs.delete(chatId); clearTimeout(job.timer);
    if (error) job.reject(new Error(error.slice(0, 500)));
    else job.resolve({ ...answer, url });
    return true;
  }
  cancel(chatId: string, reason = 'Stopped. A tool already running may still finish.'): void {
    const job = this.jobs.get(chatId);
    if (!job) return;
    this.jobs.delete(chatId); clearTimeout(job.timer); job.reject(new Error(reason));
  }
  stop(): void { for (const id of this.jobs.keys()) this.cancel(id, 'The app is shutting down.'); this.pages.clear(); }
}
