import { applyCommand } from '../core/commands';
import type { Command } from '../core/commands';
import { isDocEmpty } from '../core/doc';
import { snapshotDue } from '../core/history';
import { emptyWorkspace } from '../core/model';
import type { DocNode, FileId, FileMeta, PageId, Snapshot, WorkspaceState } from '../core/model';
import { fail, ok } from '../core/result';
import type { Result } from '../core/result';
import { openRepository } from './repository';
import type { ExternalPatch, StoredFile, WorkspaceRepository } from './repository';
import { SaveQueue } from './saveQueue';
import type { SaveQueueOptions, SaveStatus } from './saveQueue';

// the single place where commands run, state lives and changes are queued for disk
export class WorkspaceSession {
  private state: WorkspaceState;
  private readonly listeners = new Set<() => void>();
  private readonly lastSnapshot = new Map<PageId, number>();
  private readonly externalListeners = new Set<(patch: ExternalPatch, accepted: PageId[]) => void>();
  // runs before edits made elsewhere are applied, the app saves open editors here
  beforeExternal: () => void = () => {};
  readonly queue: SaveQueue;

  private constructor(
    private readonly repository: WorkspaceRepository,
    initial: WorkspaceState,
    readonly unreadable: Set<PageId>,
    readonly problems: readonly string[],
    readonly firstRun: boolean,
    options: SaveQueueOptions,
  ) {
    this.state = initial;
    this.queue = new SaveQueue(repository, () => this.state, {
      ...options,
      snapshotsFor: (ids, state) => {
        const now = Date.now();
        return ids
          .filter((id) => {
            const doc = state.docs[id];
            // an empty page has nothing worth going back to, an encrypted one never keeps a plain copy
            return (
              doc &&
              !isDocEmpty(doc) &&
              !state.pages[id]?.encrypted &&
              snapshotDue(this.lastSnapshot.get(id), now)
            );
          })
          .map((id) => this.snapshotOf(id, state, now));
      },
      onSnapshotsWritten: (snapshots) => {
        for (const snapshot of snapshots) this.lastSnapshot.set(snapshot.pageId, snapshot.createdAt);
      },
    });
    repository.onExternalChange?.((patch) => this.applyExternal(patch));
  }

  get location(): string | null {
    return this.repository.location ?? null;
  }

  get supportsEncryption(): boolean {
    return this.repository.unlockPage !== undefined;
  }

  async unlockPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (!this.repository.unlockPage) return fail('Encrypted pages need a vault folder.');
    const opened = await this.repository.unlockPage(id, password, this.state);
    if (!opened.ok) return opened;
    this.unreadable.delete(id);
    this.state = {
      pages: { ...this.state.pages, [id]: opened.value.page },
      docs: { ...this.state.docs, [id]: opened.value.doc },
    };
    for (const listener of this.listeners) listener();
    return ok(this.state);
  }

  // saves the page, then forgets its key and its content until it is unlocked again
  async lockPage(id: PageId): Promise<void> {
    await this.queue.flush();
    this.repository.lockPage?.(id);
    this.unreadable.add(id);
    const docs = { ...this.state.docs };
    delete docs[id];
    this.state = { pages: this.state.pages, docs };
    for (const listener of this.listeners) listener();
  }

  async protectPage(id: PageId, password: string): Promise<Result<WorkspaceState>> {
    if (!this.repository.protectPage) return fail('Encrypted pages need a vault folder.');
    await this.queue.flush();
    await this.repository.protectPage(id, password);
    const result = this.execute({ type: 'page.setEncrypted', id, encrypted: true, now: Date.now() });
    if (result.ok) await this.queue.flush();
    return result;
  }

  async unprotectPage(id: PageId): Promise<Result<WorkspaceState>> {
    const result = this.execute({ type: 'page.setEncrypted', id, encrypted: false, now: Date.now() });
    if (!result.ok) return result;
    await this.queue.flush();
    this.repository.unprotectPage?.(id);
    return result;
  }

  readMeta(name: string): Promise<string | null> {
    return this.repository.readMeta?.(name) ?? Promise.resolve(null);
  }

  async writeMeta(name: string, text: string): Promise<void> {
    await this.repository.writeMeta?.(name, text);
  }

  activity(): Record<string, number> {
    return this.repository.activity?.() ?? {};
  }

  pathOf(id: PageId): string | null {
    return this.repository.pathOf?.(id) ?? null;
  }

  fileUrl(id: FileId): string | null {
    return this.repository.fileUrl?.(id) ?? null;
  }

  onExternal(listener: (patch: ExternalPatch, accepted: PageId[]) => void): () => void {
    this.externalListeners.add(listener);
    return () => this.externalListeners.delete(listener);
  }

  // takes in pages changed by another app, a page with unsaved changes here keeps them
  // and the other version is kept in its history when this one is saved
  applyExternal(patch: ExternalPatch): PageId[] {
    this.beforeExternal();
    const pages = { ...this.state.pages };
    const docs = { ...this.state.docs };
    const accepted: PageId[] = [];
    for (const page of patch.pages) {
      if (this.queue.isDirty(page.id)) continue;
      pages[page.id] = page;
      if (patch.docs[page.id]) docs[page.id] = patch.docs[page.id]!;
      accepted.push(page.id);
    }
    for (const id of patch.removed) {
      if (this.queue.isDirty(id)) continue;
      delete pages[id];
      delete docs[id];
      accepted.push(id);
    }
    const acceptedSet = new Set(accepted);
    for (const id of patch.unreadable) if (acceptedSet.has(id)) this.unreadable.add(id);
    for (const id of patch.readable) if (acceptedSet.has(id)) this.unreadable.delete(id);
    if (accepted.length > 0) {
      this.state = { pages, docs };
      for (const listener of this.listeners) listener();
    }
    for (const listener of this.externalListeners) listener(patch, accepted);
    return accepted;
  }

  static async open(
    repository?: WorkspaceRepository,
    options: SaveQueueOptions = {},
  ): Promise<Result<WorkspaceSession>> {
    const repo = repository ?? (await openRepository());
    const loaded = await repo.load();
    if (!loaded.ok) return loaded;
    const state = emptyWorkspace();
    const pages = Object.fromEntries(loaded.value.pages.map((page) => [page.id, page]));
    const session = new WorkspaceSession(
      repo,
      { ...state, pages, docs: loaded.value.docs },
      new Set(loaded.value.unreadable),
      loaded.value.problems,
      loaded.value.firstRun,
      options,
    );
    repo.attachState?.(session.getState);
    return ok(session);
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  get saveStatus(): SaveStatus {
    return this.queue.status;
  }

  execute(command: Command): Result<WorkspaceState> {
    const id = 'id' in command ? command.id : 'pageId' in command ? command.pageId : null;
    if (
      typeof id === 'string' &&
      this.unreadable.has(id) &&
      (command.type === 'page.setDoc' || command.type === 'task.setChecked')
    ) {
      return fail('This page could not be read, so it is protected from changes.');
    }
    const result = applyCommand(this.state, command);
    if (!result.ok) return result;
    const { state, changes } = result.value;
    if (state === this.state) return ok(state);
    this.state = state;
    this.queue.enqueue(changes);
    for (const listener of this.listeners) listener();
    return ok(state);
  }

  // runs several commands as one unit, nothing is applied if any of them fails
  executeAll(commands: Command[]): Result<WorkspaceState> {
    let draft = this.state;
    const all = { pages: new Set<PageId>(), docs: new Set<PageId>(), removed: new Set<PageId>() };
    for (const command of commands) {
      const result = applyCommand(draft, command);
      if (!result.ok) return result;
      draft = result.value.state;
      for (const id of result.value.changes.pages) all.pages.add(id);
      for (const id of result.value.changes.docs) all.docs.add(id);
      for (const id of result.value.changes.removed) all.removed.add(id);
    }
    this.state = draft;
    this.queue.enqueue(all);
    for (const listener of this.listeners) listener();
    return ok(draft);
  }

  flush(): Promise<boolean> {
    return this.queue.flush();
  }

  markInitialized(): Promise<void> {
    return this.repository.markInitialized();
  }

  // files are written straight away, a page only references them once they are safely stored
  async addFiles(files: StoredFile[]): Promise<Result<FileMeta[]>> {
    try {
      return ok(await this.repository.putFiles(files));
    } catch (error) {
      return fail(`The file could not be saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  getFile(id: FileId): Promise<StoredFile | null> {
    return this.repository.getFile(id);
  }

  listFiles(): Promise<FileMeta[]> {
    return this.repository.listFiles();
  }

  deleteFiles(ids: FileId[]): Promise<void> {
    return this.repository.deleteFiles(ids);
  }

  listSnapshots(pageId: PageId): Promise<Snapshot[]> {
    return this.repository.listSnapshots(pageId);
  }

  allSnapshots(): Promise<Snapshot[]> {
    return this.repository.allSnapshots();
  }

  // earlier versions brought over from another storage, written as they are
  async importSnapshots(snapshots: Snapshot[]): Promise<void> {
    if (snapshots.length === 0) return;
    await this.queue.flush();
    await this.repository.write({ pages: [], docs: [], removed: [], snapshots, state: this.state });
  }

  // the current content is kept as a version first, so restoring can always be undone
  async restoreSnapshot(snapshot: Snapshot): Promise<Result<WorkspaceState>> {
    if (!this.state.pages[snapshot.pageId]) return fail('That page no longer exists.');
    if (this.state.pages[snapshot.pageId]?.encrypted)
      return fail('Encrypted pages cannot keep plain history.');
    if (!(await this.queue.flush())) return fail('Current changes could not be saved.');
    try {
      const current = {
        ...this.snapshotOf(snapshot.pageId, this.state, Date.now()),
        source: 'restore' as const,
        pinned: true,
      };
      await this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] });
      this.lastSnapshot.set(snapshot.pageId, current.createdAt);
    } catch (error) {
      return fail(`The current version could not be kept, so nothing was restored: ${String(error)}`);
    }
    const result = this.execute({
      type: 'page.setDoc',
      id: snapshot.pageId,
      doc: snapshot.doc,
      now: Date.now(),
    });
    if (result.ok && !(await this.queue.flush()))
      return fail('The restored content remains unsaved. Retry saving before closing.');
    return result;
  }

  // the page as it is now is kept in its history, before the assistant changes it for you
  async keepVersion(pageId: PageId): Promise<void> {
    const doc = this.state.docs[pageId];
    if (!doc || isDocEmpty(doc) || this.state.pages[pageId]?.encrypted) return;
    await this.queue.flush();
    const current = this.snapshotOf(pageId, this.state, Date.now());
    await this.repository.write({ pages: [], docs: [], removed: [], snapshots: [current] });
    this.lastSnapshot.set(pageId, current.createdAt);
  }

  /** 手动保存当前正文，默认保留，不会被普通历史数量清理。 */
  async saveVersion(pageId: PageId, name = ''): Promise<Snapshot> {
    if (
      !this.state.docs[pageId] ||
      this.state.pages[pageId]?.trashedAt !== null ||
      this.state.pages[pageId]?.encrypted
    )
      throw new Error('This page cannot keep a manual version.');
    if (!(await this.queue.flush())) throw new Error('Current changes could not be saved.');
    /** 快照只在当前正文确认保存成功之后创建。 */
    const snapshot: Snapshot = {
      ...this.snapshotOf(pageId, this.state, Date.now()),
      source: 'manual',
      pinned: true,
      ...(name.trim() ? { name: name.trim().slice(0, 120) } : {}),
    };
    await this.repository.write({
      pages: [],
      docs: [],
      removed: [],
      snapshots: [snapshot],
      state: this.state,
    });
    this.lastSnapshot.set(pageId, snapshot.createdAt);
    return snapshot;
  }

  /** 修改版本名称或保留标记时复用原ID，不复制正文或附件。 */
  async updateVersion(pageId: PageId, id: string, patch: { name?: string; pinned?: boolean }): Promise<void> {
    if (!this.state.pages[pageId] || this.state.pages[pageId]?.encrypted)
      throw new Error('This page cannot edit history.');
    if (!(await this.queue.flush())) throw new Error('Current changes could not be saved.');
    /** 使用存储中的原始版本，调用者不能替换正文、页面ID或时间。 */
    const snapshot = (await this.repository.listSnapshots(pageId)).find((item) => item.id === id);
    if (!snapshot) throw new Error('This version no longer exists.');
    /** 未指定的字段保持原样；名称为空表示恢复默认时间标题。 */
    const updated: Snapshot = {
      ...snapshot,
      ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 120) || undefined } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    };
    await this.repository.write({
      pages: [],
      docs: [],
      removed: [],
      snapshots: [updated],
      snapshotBases: [snapshot],
      state: this.state,
    });
  }

  private snapshotOf(pageId: PageId, state: WorkspaceState, now: number): Snapshot {
    return {
      id: crypto.randomUUID(),
      pageId,
      title: state.pages[pageId]?.title ?? '',
      doc: state.docs[pageId] as DocNode,
      createdAt: now,
    };
  }

  async close(): Promise<void> {
    await this.queue.flush();
    this.queue.dispose();
    this.repository.close();
  }
}
