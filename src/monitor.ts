import { Snapshot, SyncAction, TreeEntry } from './sync';

function metadata(entry?: TreeEntry): string {
  return entry ? JSON.stringify([entry.directory,entry.size,entry.mtime,Boolean(entry.blocked)]) : 'missing';
}

// Observations are separate from synchronization history and are committed only
// after a successful check. Unstable remote paths are protected from planning.
export class ChangeMonitor {
  private previous?: Snapshot;
  private announced = new Set<string>();

  stableSnapshot(snapshot: Snapshot): Snapshot {
    const remote = new Map(snapshot.remote);
    for (const [relative,entry] of remote) {
      if (metadata(entry) !== metadata(this.previous?.remote.get(relative))) remote.set(relative,{...entry,blocked:true});
    }
    return {local:snapshot.local,remote};
  }

  accept(snapshot: Snapshot, actions: SyncAction[]): { uploads: number; downloads: number; conflicts: number; fresh: boolean; waiting: number } {
    const current = new Set(actions.map(action => JSON.stringify([action.kind,action.relative,action.fingerprint,
      action.directory ? '' : metadata(snapshot.local.get(action.relative)),
      action.directory ? '' : metadata(snapshot.remote.get(action.relative))])));
    const fresh = [...current].some(key => !this.announced.has(key));
    const waiting = [...snapshot.remote].filter(([p,e]) => !e.blocked && metadata(e) !== metadata(this.previous?.remote.get(p))).length;
    // A temporarily unstable ancestor must not make an already announced child
    // look new again when it becomes eligible for comparison after an outage.
    const unstable = new Set([...snapshot.remote].filter(([p,e]) => metadata(e) !== metadata(this.previous?.remote.get(p))).map(([p]) => p));
    for (const key of this.announced) {
      const relative = JSON.parse(key)[1] as string;
      const parts = relative.split('/');
      if (parts.some((_,i) => unstable.has(parts.slice(0,i+1).join('/')))) current.add(key);
    }
    this.previous = {local:new Map(snapshot.local),remote:new Map(snapshot.remote)};
    this.announced = current;
    return {
      uploads:actions.filter(a => a.kind === 'upload' || a.kind === 'mkdir-remote').length,
      downloads:actions.filter(a => a.kind === 'download' || a.kind === 'mkdir-local').length,
      conflicts:actions.filter(a => a.kind === 'conflict').length,
      fresh,waiting
    };
  }

  failed(): void { this.previous = undefined; }
}

// One timeout is armed only after the previous task settles; disposal prevents
// rescheduling even if a network request is still finishing.
export class CheckLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private running = false;
  constructor(private task: () => Promise<void>, private delay: number | (() => number), private schedule = setTimeout, private cancel = clearTimeout) {}
  start(): void {
    if (this.stopped || this.timer || this.running) return;
    this.timer = this.schedule(() => {
      this.timer = undefined;
      this.running = true;
      void this.task().catch(() => {}).finally(() => { this.running = false; this.start(); });
    },typeof this.delay === 'function' ? this.delay() : this.delay);
    this.timer.unref?.();
  }
  dispose(): void { this.stopped = true; if (this.timer) this.cancel(this.timer); }
}
