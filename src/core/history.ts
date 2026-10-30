import type { Snapshot } from './model';

export const SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
export const MAX_SNAPSHOTS_PER_PAGE = 50;

// a page gets a new version at most every ten minutes while it is being edited
export function snapshotDue(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= SNAPSHOT_INTERVAL_MS;
}

// ids of the oldest versions beyond the per page limit
export function snapshotsToPrune(snapshots: Array<Pick<Snapshot, 'id' | 'createdAt' | 'pinned'>>): string[] {
  return snapshots
    .filter((snapshot) => !snapshot.pinned)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(MAX_SNAPSHOTS_PER_PAGE)
    .map((snapshot) => snapshot.id);
}

/** 历史元数据只接受有限来源、短名称和布尔保留标记，旧格式可直接读取。 */
export function snapshotInfo(value: Partial<Snapshot>): Pick<Snapshot, 'name' | 'pinned' | 'source'> {
  /** 名称截断避免损坏文件向界面注入超长内容。 */
  const name = typeof value.name === 'string' ? value.name.trim().slice(0, 120) : '';
  return {
    ...(name ? { name } : {}),
    ...(typeof value.pinned === 'boolean' ? { pinned: value.pinned } : {}),
    ...(['auto', 'manual', 'restore', 'assistant'].includes(String(value.source))
      ? { source: value.source }
      : {}),
  };
}
