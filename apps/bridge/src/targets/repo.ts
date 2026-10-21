/** A named recipient: which sink, which instance, and where in it. */
export interface Target {
  id: string;
  label: string;
  sinkId: string;
  instanceId: string | null;
  /** The connection a shared sink delivers with; null for none (delivery then fails visibly). */
  connectionId: string | null;
  destination: Record<string, string>;
}

/**
 * Targets by id. A removed target is gone for every read, but its id stays taken: its finished
 * deliveries still name it, and a new target under that id would inherit their history.
 */
export interface TargetRepo {
  get(id: string): Promise<Target | null>;
  /** Every target, by id. */
  list(): Promise<Target[]>;
  /** Creates or replaces the target with this id; false (nothing written) when it was removed. */
  put(t: Target): Promise<boolean>;
  /** Removes the target (and drops its connection); false when there was no such target. */
  remove(id: string): Promise<boolean>;
}

export class MemoryTargetRepo implements TargetRepo {
  private readonly targets = new Map<string, Target>();
  private readonly removed = new Set<string>();

  async get(id: string): Promise<Target | null> {
    const t = this.targets.get(id);
    return t ? structuredClone(t) : null;
  }

  async list(): Promise<Target[]> {
    return [...this.targets.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => structuredClone(t));
  }

  async put(t: Target): Promise<boolean> {
    if (this.removed.has(t.id)) return false;
    this.targets.set(t.id, structuredClone(t));
    return true;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.targets.delete(id)) return false;
    this.removed.add(id);
    return true;
  }
}
