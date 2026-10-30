import { Worker } from "node:worker_threads";
import type { MatchView } from "../../shared/types.ts";
export class BotPool {
  workers: { worker: Worker; busy: boolean }[] = [];
  queue: {
    id: string;
    view: MatchView;
    done: (optionId: string | null) => void;
  }[] = [];
  pending = new Map<
    string,
    {
      done: (optionId: string | null) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    for (let i = 0; i < 2; i++) this.add();
  }
  add() {
    const slot = {
      worker: new Worker(
        new URL(
          import.meta.url.endsWith(".js")
            ? "./bot-worker.js"
            : "./bot-worker.ts",
          import.meta.url,
        ),
      ),
      busy: false,
    };
    this.workers.push(slot);
    slot.worker.on("message", ({ id, optionId }) => {
      const task = this.pending.get(id);
      if (task) {
        clearTimeout(task.timer);
        this.pending.delete(id);
        task.done(optionId ?? null);
      }
      slot.busy = false;
      this.drain();
    });
    slot.worker.on("error", (e) =>
      console.error(
        JSON.stringify({ event: "BOT_WORKER_ERROR", message: e.message }),
      ),
    );
    slot.worker.on("exit", () => {
      this.workers = this.workers.filter((w) => w !== slot);
      if (!this.closed) this.add();
    });
  }
  closed = false;
  choose(view: MatchView): Promise<string | null> {
    return new Promise((done) => {
      this.queue.push({ id: view.self.decision!.decisionId, view, done });
      this.drain();
    });
  }
  drain() {
    for (const w of this.workers) {
      if (w.busy) continue;
      const t = this.queue.shift();
      if (!t) return;
      w.busy = true;
      const timer = setTimeout(() => {
        if (this.pending.delete(t.id)) t.done(null);
        w.worker.terminate();
      }, 3000);
      this.pending.set(t.id, { done: t.done, timer });
      w.worker.postMessage({ id: t.id, view: t.view });
    }
  }
  async close() {
    this.closed = true;
    for (const t of this.pending.values()) {
      clearTimeout(t.timer);
      t.done(null);
    }
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
