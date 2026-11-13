import { runCommand } from "./status";

/** Checks and (re)launches Messages.app. Abstracted so tests can fake it. */
export interface MessagesApp {
  isRunning(): Promise<boolean>;
  /** Opens Messages in the background (`open -g -a Messages`). */
  launch(): Promise<void>;
}

export const systemMessagesApp: MessagesApp = {
  async isRunning() {
    const uid = typeof process.getuid === "function" ? String(process.getuid()) : undefined;
    const args = ["/usr/bin/pgrep", "-x", ...(uid ? ["-u", uid] : []), "Messages"];
    try {
      const res = await runCommand(args, 5_000);
      return res.code === 0;
    } catch {
      return false;
    }
  },
  async launch() {
    await runCommand(["/usr/bin/open", "-g", "-a", "Messages"], 15_000);
  },
};

/** For platforms without Messages (CI) and for tests. */
export function fakeMessagesApp(
  running = true,
): MessagesApp & { launches: number; running: boolean } {
  const app = {
    running,
    launches: 0,
    async isRunning() {
      return app.running;
    },
    async launch() {
      app.launches += 1;
      app.running = true;
    },
  };
  return app;
}
