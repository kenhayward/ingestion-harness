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

export interface TargetRepo {
  get(id: string): Promise<Target | null>;
  /** Every target, by id. */
  list(): Promise<Target[]>;
  /** Creates or replaces the target with this id. */
  put(t: Target): Promise<void>;
  /** False when there was no such target. */
  remove(id: string): Promise<boolean>;
}

export class MemoryTargetRepo implements TargetRepo {
  private readonly targets = new Map<string, Target>();

  async get(id: string): Promise<Target | null> {
    const t = this.targets.get(id);
    return t ? structuredClone(t) : null;
  }

  async list(): Promise<Target[]> {
    return [...this.targets.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((t) => structuredClone(t));
  }

  async put(t: Target): Promise<void> {
    this.targets.set(t.id, structuredClone(t));
  }

  async remove(id: string): Promise<boolean> {
    return this.targets.delete(id);
  }
}
