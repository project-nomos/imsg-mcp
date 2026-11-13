/**
 * Remembers when each message the server has returned was sent, so `get_messages` can
 * page backwards from a rowid cursor. (`messages.history` pages by time, not rowid.)
 */
export class CursorIndex {
  private readonly map = new Map<number, { chatId: number; sentAtMs: number }>();

  constructor(private readonly max = 20_000) {}

  remember(rowid: number, chatId: number, sentAtMs: number | undefined): void {
    if (sentAtMs === undefined || !Number.isFinite(sentAtMs)) return;
    this.map.delete(rowid);
    this.map.set(rowid, { chatId, sentAtMs });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  get(rowid: number): { chatId: number; sentAtMs: number } | undefined {
    return this.map.get(rowid);
  }
}
