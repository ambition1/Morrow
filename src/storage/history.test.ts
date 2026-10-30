import { snapshotInfo, snapshotsToPrune } from '../core/history';
import { MemoryVault } from './memoryVault';
import { VaultRepository } from './vaultRepository';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_VERSION } from '../core/model';
import type { DocNode } from '../core/model';
import { openRepository } from './repository';
import { WorkspaceSession } from './session';

const names: string[] = [];
let count = 0;
const freshName = () => {
  const name = `morrow-history-${count++}`;
  names.push(name);
  return name;
};

afterEach(async () => {
  while (names.length) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(names.pop()!);
      request.onsuccess = request.onerror = request.onblocked = () => resolve();
    });
  }
});

const doc = (text: string): DocNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

async function open(name: string): Promise<WorkspaceSession> {
  const session = await WorkspaceSession.open(await openRepository(name));
  if (!session.ok) throw new Error(session.error);
  return session.value;
}

describe('page history', () => {
  it('keeps a version on save and restores without losing the current text', async () => {
    const session = await open(freshName());
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1, title: 'Notes' });
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('first draft'), now: 2 });
    await session.flush();
    let versions = await session.listSnapshots('p');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.doc).toEqual(doc('first draft'));

    // edits inside the ten minute window do not add versions
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('second draft'), now: 3 });
    await session.flush();
    expect(await session.listSnapshots('p')).toHaveLength(1);

    const restored = await session.restoreSnapshot(versions[0]!);
    expect(restored.ok).toBe(true);
    expect(session.getState().docs.p).toEqual(doc('first draft'));
    versions = await session.listSnapshots('p');
    expect(versions.map((version) => version.doc)).toContainEqual(doc('second draft'));
    await session.close();
  });

  it('removes history together with a page deleted forever', async () => {
    const name = freshName();
    const session = await open(name);
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('x'), now: 2 });
    await session.flush();
    session.execute({ type: 'page.trash', id: 'p', now: 3 });
    session.execute({ type: 'page.deleteForever', id: 'p' });
    await session.flush();
    expect(await session.listSnapshots('p')).toEqual([]);
    await session.close();
  });
});

describe('files', () => {
  it('stores, lists, reads and deletes attachments', async () => {
    const session = await open(freshName());
    const meta = { id: 'f1', name: 'note.txt', type: 'text/plain', size: 3, createdAt: 1 };
    const saved = await session.addFiles([
      { meta, data: new TextEncoder().encode('abc').buffer as ArrayBuffer },
    ]);
    expect(saved.ok).toBe(true);
    expect(await session.listFiles()).toEqual([meta]);
    const file = await session.getFile('f1');
    expect(new TextDecoder().decode(file!.data)).toBe('abc');
    await session.deleteFiles(['f1']);
    expect(await session.getFile('f1')).toBeNull();
    await session.close();
  });
});

describe('upgrading from version 1', () => {
  it('opens a version 1 database without touching its pages', async () => {
    const name = freshName();
    const old = await openDB(name, 1, {
      upgrade(database) {
        database.createObjectStore('pages', { keyPath: 'id' });
        database.createObjectStore('docs', { keyPath: 'id' });
        database.createObjectStore('meta');
      },
    });
    await old.put('pages', {
      id: 'p',
      parentId: null,
      title: 'Old page',
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    await old.put('docs', { id: 'p', doc: doc('kept') });
    await old.put('meta', 1, 'schemaVersion');
    old.close();

    const session = await open(name);
    expect(session.getState().pages.p?.title).toBe('Old page');
    expect(session.getState().docs.p).toEqual(doc('kept'));
    expect(await session.listFiles()).toEqual([]);
    await session.close();

    const upgraded = await openDB(name);
    expect(await upgraded.get('meta', 'schemaVersion')).toBe(SCHEMA_VERSION);
    upgraded.close();
  });
});

// 手动版本沿用真实存储，避免只验证界面状态。
describe('命名与保留版本', () => {
  it('手动保存、重命名和保留标记在重新打开后仍存在', async () => {
    /** 独立数据库与会话用于检查真实持久化。 */
    const name = freshName();
    const session = await open(name);
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1, title: 'Notes' });
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('确认内容'), now: 2 });
    /** 命名版本默认保留，且不改变正文。 */
    const saved = await session.saveVersion('p', '  确认稿  ');
    expect(saved).toMatchObject({ name: '确认稿', pinned: true, source: 'manual' });
    await session.updateVersion('p', saved.id, { name: '正式稿', pinned: false });
    expect((await session.listSnapshots('p')).filter((item) => item.id === saved.id)).toHaveLength(1);
    await session.close();
    /** 重开后通过存储读取元数据，不使用旧组件状态。 */
    const reopened = await open(name);
    expect((await reopened.listSnapshots('p')).find((item) => item.id === saved.id)).toMatchObject({
      name: '正式稿',
      pinned: false,
      source: 'manual',
      doc: doc('确认内容'),
    });
    await reopened.close();
  });

  it('保存失败时不能创建一个看似成功的手动版本', async () => {
    /** 先完成初始保存，失败只作用于手动版本前的确认。 */
    const session = await open(freshName());
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
    await session.flush();
    /** 模拟当前正文仍未保存的情况。 */
    const flush = vi.spyOn(session.queue, 'flush').mockResolvedValueOnce(false);
    await expect(session.saveVersion('p', '不应存在')).rejects.toThrow();
    expect((await session.listSnapshots('p')).some((item) => item.name === '不应存在')).toBe(false);
    flush.mockRestore();
    await session.close();
  });

  it('文件库不会因重命名重复历史，失败写入也不会留幽灵缓存', async () => {
    /** 文件桥接复用真实VaultRepository写入路径。 */
    const vault = new MemoryVault();
    const loaded = await WorkspaceSession.open(new VaultRepository(vault, () => crypto.randomUUID()));
    if (!loaded.ok) throw new Error(loaded.error);
    /** 当前可写文件库会话。 */
    const session = loaded.value;
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1, title: '文件笔记' });
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('正文'), now: 2 });
    const saved = await session.saveVersion('p', '重要');
    await session.updateVersion('p', saved.id, { name: '已确认' });
    expect((await session.listSnapshots('p')).filter((item) => item.id === saved.id)).toHaveLength(1);
    /** 只让下一次历史写入失败，不能污染后续的读取结果。 */
    const failed = vi.spyOn(vault, 'apply').mockRejectedValueOnce(new Error('模拟磁盘错误'));
    await expect(session.saveVersion('p', '失败版本')).rejects.toThrow();
    failed.mockRestore();
    expect((await session.listSnapshots('p')).some((item) => item.name === '失败版本')).toBe(false);
    await session.close();
    /** 文件库重开仍保留名称及重要标记。 */
    const reopened = await WorkspaceSession.open(new VaultRepository(vault, () => crypto.randomUUID()));
    if (!reopened.ok) throw new Error(reopened.error);
    expect((await reopened.value.listSnapshots('p')).find((item) => item.id === saved.id)).toMatchObject({
      name: '已确认',
      pinned: true,
      source: 'manual',
    });
    await reopened.value.close();
  });

  it('恢复前版本被保留，恢复完成后正文已经持久化', async () => {
    /** 手动版本与当前正文必须明确不同。 */
    const name = freshName();
    const session = await open(name);
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('旧内容'), now: 2 });
    const saved = await session.saveVersion('p', '旧稿');
    session.execute({ type: 'page.setDoc', id: 'p', doc: doc('新内容'), now: 3 });
    expect((await session.restoreSnapshot(saved)).ok).toBe(true);
    expect((await session.listSnapshots('p')).find((item) => item.source === 'restore')).toMatchObject({
      pinned: true,
      doc: doc('新内容'),
    });
    await session.close();
    const reopened = await open(name);
    expect(reopened.getState().docs.p).toEqual(doc('旧内容'));
    await reopened.close();
  });

  it('版本清理不计入保留版本，旧快照元数据仍兼容', () => {
    /** 重要旧版本不能占用普通版本配额，也不能被清理。 */
    const versions = Array.from({ length: 55 }, (_, index) => ({
      id: `v${index}`,
      createdAt: index,
      ...(index === 0 ? { pinned: true } : {}),
    }));
    expect(snapshotsToPrune(versions)).toEqual(['v4', 'v3', 'v2', 'v1']);
    expect(snapshotInfo({})).toEqual({});
    expect(snapshotInfo({ name: ' 确认稿 ', pinned: true, source: 'manual' })).toEqual({
      name: '确认稿',
      pinned: true,
      source: 'manual',
    });
  });
});

describe('共享版本的并发与失败保护', () => {
  it('两个仓库交替新增和修改版本，不覆盖其他设备记录', async () => {
    /** 两个独立仓库共享磁盘，模拟两台设备的缓存生命周期。 */
    const vault = new MemoryVault();
    const repoA = new VaultRepository(vault, () => crypto.randomUUID());
    const loadedA = await WorkspaceSession.open(repoA);
    if (!loadedA.ok) throw new Error(loadedA.error);
    const a = loadedA.value;
    a.execute({ type: 'page.create', id: 'p', parentId: null, now: 1, title: '共享笔记' });
    const first = await a.saveVersion('p', '第一版');
    /** 第二个仓库先读取旧列表，然后第一台继续修改。 */
    const repoB = new VaultRepository(vault, () => crypto.randomUUID());
    const loadedB = await WorkspaceSession.open(repoB);
    if (!loadedB.ok) throw new Error(loadedB.error);
    const b = loadedB.value;
    const stale = (await b.listSnapshots('p')).find((item) => item.id === first.id)!;
    await a.updateVersion('p', first.id, { name: '第一台已确认' });
    await b.saveVersion('p', '第二台新增');
    expect((await a.listSnapshots('p')).map((item) => item.name)).toEqual(
      expect.arrayContaining(['第一台已确认', '第二台新增']),
    );
    /** 陈旧的元数据修改必须失败，不能覆盖别人的名称。 */
    await expect(
      repoB.write({
        pages: [],
        docs: [],
        removed: [],
        snapshots: [{ ...stale, name: '陈旧名称' }],
        snapshotBases: [stale],
      }),
    ).rejects.toThrow();
    expect((await b.listSnapshots('p')).find((item) => item.id === first.id)?.name).toBe('第一台已确认');
    await a.close();
    await b.close();
  });

  it('批量历史组装中途失败，前一个页面不会出现未落盘版本', async () => {
    /** 先建立两页已保存的历史。 */
    const vault = new MemoryVault();
    const repo = new VaultRepository(vault, () => crypto.randomUUID());
    const loaded = await WorkspaceSession.open(repo);
    if (!loaded.ok) throw new Error(loaded.error);
    const session = loaded.value;
    for (const id of ['p', 'q']) session.execute({ type: 'page.create', id, parentId: null, now: 1 });
    await session.flush();
    /** 第二个页面读取失败，第一页的拟保存版本也不能发布到缓存。 */
    const originalRead = vault.readText.bind(vault);
    const failedRead = vi.spyOn(vault, 'readText').mockImplementation(async (path) => {
      if (path.endsWith('/q.json')) throw new Error('模拟历史读取失败');
      return originalRead(path);
    });
    await expect(
      repo.write({
        pages: [],
        docs: [],
        removed: [],
        snapshots: [
          { id: 'ghost-p', pageId: 'p', title: '', doc: doc('甲'), createdAt: 10 },
          { id: 'ghost-q', pageId: 'q', title: '', doc: doc('乙'), createdAt: 10 },
        ],
      }),
    ).rejects.toThrow();
    failedRead.mockRestore();
    expect(await session.listSnapshots('p')).toEqual([]);
    await session.close();
  });

  it('组装后磁盘再次变化时，CAS拒绝覆盖整份历史', async () => {
    /** 先写入一个已确认版本。 */
    const vault = new MemoryVault();
    const repo = new VaultRepository(vault, () => crypto.randomUUID());
    const loaded = await WorkspaceSession.open(repo);
    if (!loaded.ok) throw new Error(loaded.error);
    const session = loaded.value;
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
    await session.saveVersion('p', '原始');
    /** 读取基准后模拟另一设备抢先落盘。 */
    const apply = vault.apply.bind(vault);
    const race = vi.spyOn(vault, 'apply').mockImplementationOnce(async (ops) => {
      for (const op of ops)
        if (op.op === 'write' && op.path.includes('/history/')) {
          const data = JSON.parse(vault.text(op.path)!);
          data.snapshots.push({ id: 'remote', title: '', doc: doc('另一设备'), createdAt: 99, pinned: true });
          vault.files.set(op.path, JSON.stringify(data));
        }
      return apply(ops);
    });
    await expect(session.saveVersion('p', '不应覆盖')).rejects.toThrow();
    race.mockRestore();
    expect((await session.listSnapshots('p')).some((item) => item.id === 'remote')).toBe(true);
    expect((await session.listSnapshots('p')).some((item) => item.name === '不应覆盖')).toBe(false);
    await session.close();
  });

  it('加密后不新增明文手动或恢复前版本', async () => {
    /** 加密使用真实文件库，不模拟加密标记。 */
    const vault = new MemoryVault();
    const loaded = await WorkspaceSession.open(new VaultRepository(vault, () => crypto.randomUUID()));
    if (!loaded.ok) throw new Error(loaded.error);
    const session = loaded.value;
    session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
    const saved = await session.saveVersion('p', '加密前');
    expect((await session.protectPage('p', 'test-password')).ok).toBe(true);
    await expect(session.saveVersion('p', '不能明文保存')).rejects.toThrow();
    expect((await session.restoreSnapshot(saved)).ok).toBe(false);
    expect(await session.listSnapshots('p')).toEqual([]);
    await session.close();
  });
});

it('损坏的历史文件不能被当作空列表覆盖', async () => {
  /** 先生成一份正常历史，以获得实际文件位置。 */
  const vault = new MemoryVault();
  const loaded = await WorkspaceSession.open(new VaultRepository(vault, () => crypto.randomUUID()));
  if (!loaded.ok) throw new Error(loaded.error);
  const session = loaded.value;
  session.execute({ type: 'page.create', id: 'p', parentId: null, now: 1 });
  await session.saveVersion('p', '正常版本');
  /** 模拟格式损坏，读取和写入都必须报错且保留原文件。 */
  const path = [...vault.files.keys()].find((key) => key.endsWith('/history/p.json'))!;
  const damaged = '{"version":1,"snapshots":"不可丢弃的原文"}';
  vault.files.set(path, damaged);
  await expect(session.listSnapshots('p')).rejects.toThrow();
  await expect(session.saveVersion('p', '不能覆盖')).rejects.toThrow();
  expect(vault.text(path)).toBe(damaged);
  await session.close();
});
