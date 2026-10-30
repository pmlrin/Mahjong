import { parentPort } from "node:worker_threads";
import { chooseBot } from "./bot.ts";
parentPort!.on("message", ({ id, view }) => {
  try {
    parentPort!.postMessage({ id, optionId: chooseBot(view) });
  } catch {
    parentPort!.postMessage({ id, error: true });
  }
});
