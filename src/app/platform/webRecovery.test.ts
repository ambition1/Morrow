/**
 * 功能：验证本机恢复协调器与服务器保存队列之间的确认、失败和重开保护。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:47:14
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyCommand } from '../../core/commands';
import type { Changes } from '../../core/commands';
import { emptyWorkspace } from '../../core/model';
import type { DocNode, PageMeta, WorkspaceState } from '../../core/model';
import { SaveQueue } from '../../storage/saveQueue';
import type { WriteBatch } from '../../storage/repository';
import type { WebDraftStore } from '../../storage/webDrafts';
import type * as WebDraftModule from '../../storage/webDrafts';
import { WebRecovery } from './webRecovery';

/** 模块替身只替换数据库名称，所有草稿操作仍使用真实 IndexedDB 实现。 */
const storage = vi.hoisted(() => ({
  /** 每项测试独立数据库，避免旧连接阻塞或跨测试串扰。 */
  databaseName: '',
  /** 记录打开的连接以便结束时释放。 */
  connections: [] as WebDraftStore[],
}));

vi.mock('../../storage/webDrafts', async (importOriginal) => {
  /** 除测试库名外完整复用实际存储实现。 */
  const actual = await importOriginal<typeof WebDraftModule>();
  return {
    ...actual,
    /** 连接仍按调用方笔记库身份隔离。 */
    openWebDraftStore: async (namespace: string) => {
      /** 该连接由本测试显式清理。 */
      const store = await actual.openWebDraftStore(namespace, storage.databaseName);
      storage.connections.push(store);
      return store;
    },
  };
});

/** 获取完整正式页面元数据，避免伪造与实际页面不一致的缺省值。 */
function page(): PageMeta {
  /** 创建结果包含历史、加密及数据库字段。 */
  const created = applyCommand(emptyWorkspace(), {
    type: 'page.create',
    id: 'page-a',
    parentId: null,
    title: '服务器标题',
    now: 1,
  });
  if (!created.ok) throw new Error(created.error);
  return created.value.state.pages['page-a']!;
}

/** 构造完整正文以便验证序号对应的实际内容。 */
function doc(text: string): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** 以不可变页面和正文模拟应用命令产生的新状态。 */
function state(text = '服务器原文', title = '服务器标题'): WorkspaceState {
  return {
    pages: { 'page-a': { ...page(), title } },
    docs: { 'page-a': doc(text) },
  };
}

/** 每次编辑同时写入页面更新时间与正文。 */
function changes(): Changes {
  return { pages: new Set(['page-a']), docs: new Set(['page-a']), removed: new Set() };
}

/** 将指定状态转为与保存队列相同结构的批次。 */
function batch(value: WorkspaceState): WriteBatch {
  return {
    pages: Object.values(value.pages),
    docs: [{ id: 'page-a', doc: value.docs['page-a']! }],
    removed: [],
    state: value,
  };
}

/** 可控服务器延迟，不使用定时等待制造偶发竞争。 */
function deferred() {
  /** 完成操作由测试显式触发。 */
  let resolve!: () => void;
  /** 请求仅在 resolve 调用后完成。 */
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  storage.databaseName = `recovery-test-${crypto.randomUUID()}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const connection of storage.connections.splice(0)) connection.close();
  await new Promise<void>((resolve, reject) => {
    /** 只删除当前测试的内存数据库。 */
    const request = indexedDB.deleteDatabase(storage.databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Recovery test database remained open.'));
  });
});

describe('Web 本机恢复协调器', () => {
  it('首次启动只读取既有草稿，刷新后仍保留原正文及基准', async () => {
    /** 旧页面记录一份尚未同步的草稿。 */
    const first = new WebRecovery(state(), () => 'epoch:1');
    await first.open('server:vault');
    first.enqueue(changes(), state('未同步正文'));
    await first.flushLocal();
    /** 新页面没有输入，不能用初始服务器正文覆盖已有草稿。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    expect(reopened.getStatus().drafts).toHaveLength(1);
    expect(reopened.getStatus().drafts[0]).toMatchObject({
      doc: doc('未同步正文'),
      baseDoc: doc('服务器原文'),
      revision: 'epoch:1',
    });
    expect(reopened.getStatus().error).toBeNull();
  });

  it('两个标签独立编辑后重开能够发现两份草稿', async () => {
    /** 两个实例模拟同时打开同一笔记的两个标签。 */
    const first = new WebRecovery(state(), () => 'epoch:1');
    /** 第二标签的所有者必须与第一标签不同。 */
    const second = new WebRecovery(state(), () => 'epoch:1');
    await first.open('server:vault');
    await second.open('server:vault');
    first.enqueue(changes(), state('甲标签'));
    second.enqueue(changes(), state('乙标签'));
    await Promise.all([first.flushLocal(), second.flushLocal()]);
    await first.refresh();
    expect(first.getStatus().drafts).toHaveLength(2);
    expect(new Set(first.getStatus().drafts.map((draft) => draft.owner)).size).toBe(2);
  });

  it('服务器请求期间的新正文不被迟到回执删除，再次保存才清理', async () => {
    /** 当前应用状态在保存请求期间会继续产生新对象。 */
    let current = state();
    /** 延迟第一份服务器确认以制造真实交错。 */
    const sent = deferred();
    /** 第一份服务器回执由测试控制。 */
    const confirmed = deferred();
    /** 协调器保存与队列共同使用的基准。 */
    const recovery = new WebRecovery(current, () => 'epoch:1');
    await recovery.open('server:vault');
    /** 第一次写入停留在服务器端，第二次直接成功。 */
    const writer = vi.fn(async () => {
      if (writer.mock.calls.length === 1) {
        sent.resolve();
        await confirmed.promise;
      }
    });
    /** 使用实际保存队列，而非直接模拟回执逻辑。 */
    const queue = new SaveQueue({ write: writer }, () => current, {
      delayMs: 60_000,
      onEnqueue: (changed, value) => recovery.enqueue(changed, value),
      beforeWrite: (value) => recovery.beforeWrite(value),
      afterWrite: (value, token) => recovery.afterWrite(value, token),
    });
    try {
      current = state('第一次修改');
      queue.enqueue(changes());
      /** 保存操作尚未返回时继续输入。 */
      const saving = queue.flush();
      await sent.promise;
      current = state('第二次修改');
      queue.enqueue(changes());
      await recovery.flushLocal();
      confirmed.resolve();
      expect(await saving).toBe(false);
      expect(recovery.getStatus().drafts).toHaveLength(1);
      expect(recovery.getStatus().drafts[0]!.doc).toEqual(doc('第二次修改'));
      expect(await queue.flush()).toBe(true);
      expect(recovery.getStatus().drafts).toEqual([]);
    } finally {
      confirmed.resolve();
      queue.dispose();
    }
  });

  it('正文相同但页面属性更新时不能确认旧批次未包含的新草稿', async () => {
    /** 本文未变，只修改标题也必须作为独立草稿代数。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    recovery.enqueue(changes(), state('相同正文', '旧标题'));
    await recovery.flushLocal();
    /** 服务器准备保存旧标题，此时出现了新标题。 */
    const oldBatch = batch(state('相同正文', '旧标题'));
    recovery.enqueue(changes(), state('相同正文', '新标题'));
    /** 新草稿正文相同，仍不能被旧标题批次误判为已保存。 */
    const token = await recovery.beforeWrite(oldBatch);
    await recovery.afterWrite(oldBatch, token);
    expect(recovery.getStatus().drafts).toHaveLength(1);
    expect(recovery.getStatus().drafts[0]!.page.title).toBe('新标题');
  });

  it('恢复草稿再次遇到服务器失败时，旧草稿与新编辑均保留', async () => {
    /** 先留下页面刷新前未同步的版本。 */
    const previous = new WebRecovery(state(), () => 'epoch:1');
    await previous.open('server:vault');
    previous.enqueue(changes(), state('恢复正文'));
    await previous.flushLocal();
    /** 页面刷新后重新编辑恢复内容，网络仍然不可用。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    /** 恢复操作使用新的页面所有者，不能提前清掉旧草稿。 */
    const current = state('恢复正文再次编辑');
    /** 真实写入失败不会执行 afterWrite。 */
    const queue = new SaveQueue(
      {
        write: async () => {
          throw new Error('offline');
        },
      },
      () => current,
      {
        delayMs: 60_000,
        onEnqueue: (changed, value) => reopened.enqueue(changed, value),
        beforeWrite: (value) => reopened.beforeWrite(value),
        afterWrite: (value, token) => reopened.afterWrite(value, token),
      },
    );
    try {
      queue.enqueue(changes());
      expect(await queue.flush()).toBe(false);
      expect(queue.status.state).toBe('error');
      expect(reopened.getStatus().drafts.map((draft) => draft.doc)).toEqual(
        expect.arrayContaining([doc('恢复正文'), doc('恢复正文再次编辑')]),
      );
      /** 又一次重开仍能找到这两份未确认内容。 */
      const third = new WebRecovery(state(), () => 'epoch:2');
      await third.open('server:vault');
      expect(third.getStatus().drafts).toHaveLength(2);
    } finally {
      queue.dispose();
    }
  });

  it('本机存储不可用时展示真实错误且不报告存在持久草稿', async () => {
    vi.stubGlobal('indexedDB', undefined);
    /** 页面仍可编辑，但本机保护不能假装成功。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    recovery.enqueue(changes(), state('内存中的修改'));
    await recovery.flushLocal();
    expect(recovery.getStatus().error).not.toBeNull();
    expect(recovery.getStatus().drafts).toEqual([]);
    expect(recovery.getStatus().pending).toBe(false);
  });

  it('本机额度错误后重新成功保存会清除错误并保留最新正文', async () => {
    /** 存储最初可用，只有一次写入失败。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    /** 直接在实际存储边界模拟浏览器容量错误。 */
    const store = storage.connections[0]!;
    vi.spyOn(store, 'put').mockRejectedValueOnce(new DOMException('空间不足', 'QuotaExceededError'));
    recovery.enqueue(changes(), state('第一次失败'));
    await recovery.flushLocal();
    expect(recovery.getStatus().error).toContain('空间不足');
    expect(recovery.getStatus().drafts).toEqual([]);
    recovery.enqueue(changes(), state('第二次成功'));
    await recovery.flushLocal();
    expect(recovery.getStatus().error).toBeNull();
    expect(recovery.getStatus().drafts[0]!.doc).toEqual(doc('第二次成功'));
  });

  it('旧本机写入完成时仍有新事务在排队，不能提前报告保护完成', async () => {
    /** 两个本机事务完成时间都由测试控制。 */
    const firstRelease = deferred();
    /** 第二次写入停留在持久化边界。 */
    const secondRelease = deferred();
    /** 记录第一次写入已经开始。 */
    const firstStarted = deferred();
    /** 记录第二次写入已经开始。 */
    const secondStarted = deferred();
    /** 协调器订阅状态用于验证并发阶段。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    /** 保存原始方法，延迟后仍调用真实 IndexedDB 事务。 */
    const store = storage.connections[0]!;
    /** 防止替身递归调用自身。 */
    const originalPut = store.put.bind(store);
    /** 写入次数区分两个异步屏障。 */
    let writes = 0;
    vi.spyOn(store, 'put').mockImplementation(async (draft) => {
      if (++writes === 1) {
        firstStarted.resolve();
        await firstRelease.promise;
      } else {
        secondStarted.resolve();
        await secondRelease.promise;
      }
      await originalPut(draft);
    });
    try {
      recovery.enqueue(changes(), state('第一代'));
      await firstStarted.promise;
      recovery.enqueue(changes(), state('第二代'));
      firstRelease.resolve();
      await secondStarted.promise;
      expect(recovery.getStatus().pending).toBe(true);
      secondRelease.resolve();
      await recovery.flushLocal();
      expect(recovery.getStatus().pending).toBe(false);
      expect(recovery.getStatus().drafts[0]!.doc).toEqual(doc('第二代'));
    } finally {
      firstRelease.resolve();
      secondRelease.resolve();
    }
  });

  it('已加密页面在启动时保留旧未同步副本且拒绝陈旧标签新写入', async () => {
    /** 陈旧标签先留下未加密正文。 */
    const stale = new WebRecovery(state(), () => 'epoch:1');
    await stale.open('server:vault');
    stale.enqueue(changes(), state('旧明文'));
    await stale.flushLocal();
    /** 新标签已从服务器读到加密状态。 */
    const encrypted = state();
    /** 此处仅在测试对象内模拟服务端已经完成加密。 */
    const protectedState: WorkspaceState = {
      ...encrypted,
      pages: { 'page-a': { ...encrypted.pages['page-a']!, encrypted: true } },
    };
    /** 新增写入被禁止，但旧草稿可能是唯一副本，必须保留供用户处理。 */
    const fresh = new WebRecovery(protectedState, () => 'epoch:2');
    await fresh.open('server:vault');
    expect(fresh.getStatus().drafts[0]!.doc).toEqual(doc('旧明文'));
    stale.enqueue(changes(), state('陈旧标签新输入'));
    await stale.flushLocal();
    expect(stale.getStatus().error).toContain('Encrypted');
    await stale.refresh();
    expect(stale.getStatus().drafts[0]!.doc).toEqual(doc('旧明文'));
  });

  it('甲页本机失败不会被乙页成功掩盖，甲页服务器确认后才允许刷新', async () => {
    /** 两页分别产生独立草稿状态。 */
    const initial: WorkspaceState = {
      pages: { ...state().pages, 'page-b': { ...page(), id: 'page-b' } },
      docs: { ...state().docs, 'page-b': doc('乙页原文') },
    };
    /** 协调器必须按页面保留失败，而非单个全局开关。 */
    const recovery = new WebRecovery(initial, () => 'epoch:1');
    await recovery.open('server:vault');
    /** 第一次失败只属于甲页。 */
    const store = storage.connections[0]!;
    vi.spyOn(store, 'put').mockRejectedValueOnce(new DOMException('甲页空间不足', 'QuotaExceededError'));
    /** 甲页修改的批次稍后由服务器确认。 */
    const changedA: WorkspaceState = { ...initial, docs: { ...initial.docs, 'page-a': doc('甲页修改') } };
    recovery.enqueue(changes(), changedA);
    await recovery.flushLocal();
    recovery.enqueue(
      { pages: new Set(['page-b']), docs: new Set(['page-b']), removed: new Set() },
      {
        ...changedA,
        docs: { ...changedA.docs, 'page-b': doc('乙页修改') },
      },
    );
    await recovery.flushLocal();
    expect(recovery.getStatus().error).toContain('甲页空间不足');
    await expect(recovery.prepareReload()).rejects.toThrow('不能刷新');
    expect(recovery.safeToReload).toBe(false);
    /** 甲页的服务器成功回执消除其数据丢失风险。 */
    const sent = batch(changedA);
    await recovery.afterWrite(sent, await recovery.beforeWrite(sent));
    expect(recovery.getStatus().error).toBeNull();
    await recovery.prepareReload();
    expect(recovery.safeToReload).toBe(true);
  });

  it('旧服务器回执不能清除同页新编辑的本机失败', async () => {
    /** 第一代正文已在本机存储，并且请求已发送。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    recovery.enqueue(changes(), state('第一代正文'));
    /** 服务器回执必须携带第一代令牌。 */
    const firstBatch = batch(state('第一代正文'));
    /** 此时尚未产生第二代编辑。 */
    const firstToken = await recovery.beforeWrite(firstBatch);
    /** 第二代正文写本机失败，但第一代服务器请求仍可成功。 */
    const store = storage.connections[0]!;
    vi.spyOn(store, 'put').mockRejectedValueOnce(new DOMException('第二代无法保护', 'QuotaExceededError'));
    recovery.enqueue(changes(), state('第二代正文'));
    await recovery.flushLocal();
    await recovery.afterWrite(firstBatch, firstToken);
    expect(recovery.getStatus().error).toContain('第二代无法保护');
    await expect(recovery.prepareReload()).rejects.toThrow('不能刷新');
  });

  it('取消加密后下一次普通编辑可以重新持久化明文草稿', async () => {
    /** 初始基准来自已经加密的服务器页面。 */
    const initial = state();
    /** 页面在本标签解锁后虽然有正文，仍禁止明文草稿。 */
    const encrypted: WorkspaceState = {
      ...initial,
      pages: { 'page-a': { ...initial.pages['page-a']!, encrypted: true } },
    };
    /** 协调器初始化建立跨标签保护标记。 */
    const recovery = new WebRecovery(encrypted, () => 'epoch:1');
    await recovery.open('server:vault');
    await recovery.setEncrypted('page-a', false);
    recovery.enqueue(changes(), state('取消加密后的新正文'));
    await recovery.flushLocal();
    expect(recovery.getStatus().error).toBeNull();
    expect(recovery.getStatus().drafts[0]!.doc).toEqual(doc('取消加密后的新正文'));
  });

  it('快速记录的迟到回执不能删除发送后产生的新记录', async () => {
    /** 同一个快速记录窗口继续输入时仍使用同一所有者。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    await recovery.saveCapture('第一份快速记录', 'page-a', []);
    /** 发送前获取精确序号，不能在收到确认后再读取最新序号。 */
    const sent = recovery.captureToken();
    await recovery.saveCapture('后来输入的快速记录', 'page-a', []);
    await recovery.clearCapture(sent);
    /** 页面刷新后依然能够恢复第二份记录。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    expect(await reopened.readCapture()).toMatchObject({ text: '后来输入的快速记录', target: 'page-a' });
    expect(reopened.getStatus().drafts).toEqual([]);
  });

  it('快速记录附件在重开后保持文件名、类型、时间与字节', async () => {
    /** 原始文件尚未上传，必须独立存入本机恢复记录。 */
    const file = new File([new Uint8Array([0, 10, 255])], '测试图片.png', {
      type: 'image/png',
      lastModified: 1234,
    });
    /** 首次页面只保存本机，不触发服务器笔记修改。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    await recovery.saveCapture('带附件的快速记录', 'page-a', [file]);
    /** 新页面模拟刷新与关闭后重新进入快速记录。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    /** 恢复后仍然是真实 File，可供现有上传链使用。 */
    const restored = await reopened.readCapture();
    expect(restored).toMatchObject({ text: '带附件的快速记录', target: 'page-a' });
    expect(restored!.files).toHaveLength(1);
    expect(restored!.files[0]).toMatchObject({ name: file.name, type: file.type, lastModified: 1234 });
    expect(new Uint8Array(await restored!.files[0]!.arrayBuffer())).toEqual(new Uint8Array([0, 10, 255]));
  });

  it('保存队列的多个持有者都释放前不能启动服务器写入', async () => {
    /** 保存器记录是否提前请求服务器。 */
    const writer = vi.fn(async () => {});
    /** 无需计时等待，flush 直接验证持有状态。 */
    const queue = new SaveQueue({ write: writer }, () => state('等待本机检查点'), { delayMs: 60_000 });
    /** 第一个持有者模拟附件持久化。 */
    const releaseFirst = queue.hold();
    /** 第二个持有者模拟正文检查点。 */
    const releaseSecond = queue.hold();
    try {
      queue.enqueue(changes());
      expect(await queue.flush()).toBe(false);
      releaseFirst();
      releaseFirst();
      expect(await queue.flush()).toBe(false);
      expect(writer).not.toHaveBeenCalled();
      releaseSecond();
      expect(await queue.flush()).toBe(true);
      expect(writer).toHaveBeenCalledTimes(1);
    } finally {
      releaseFirst();
      releaseSecond();
      queue.dispose();
    }
  });

  it('已经等待旧请求的 flush 也必须遵守后来建立的持有状态', async () => {
    /** 第一份服务器请求允许在持有前开始。 */
    const sent = deferred();
    /** 第一份服务器请求的返回时间由测试决定。 */
    const confirmed = deferred();
    /** 请求期间产生新的不可变状态。 */
    let current = state('第一代');
    /** 只延迟第一次写入，以便发现错误启动的第二份请求。 */
    const writer = vi.fn(async () => {
      if (writer.mock.calls.length === 1) {
        sent.resolve();
        await confirmed.promise;
      }
    });
    /** 当前队列包含在途请求和稍后出现的未发送编辑。 */
    const queue = new SaveQueue({ write: writer }, () => current, { delayMs: 60_000 });
    /** 清理时即使断言失败也释放持有者。 */
    let release = () => {};
    try {
      queue.enqueue(changes());
      /** 第一份 flush 等待当前服务器请求。 */
      const first = queue.flush();
      await sent.promise;
      /** 第二份 flush 已开始等待旧请求，此后才出现持有者。 */
      const waiting = queue.flush();
      release = queue.hold();
      current = state('第二代');
      queue.enqueue(changes());
      confirmed.resolve();
      await first;
      expect(await waiting).toBe(false);
      expect(writer).toHaveBeenCalledTimes(1);
      release();
      expect(await queue.flush()).toBe(true);
      expect(writer).toHaveBeenCalledTimes(2);
    } finally {
      confirmed.resolve();
      release();
      queue.dispose();
    }
  });

  it('整页保护失败时保留原快速记录并阻止服务器越过保护检查点', async () => {
    /** 原快速记录已在本机独立落盘。 */
    const recovery = new WebRecovery(state(), () => 'epoch:1');
    await recovery.open('server:vault');
    await recovery.saveCapture('尚未安全追加的快速记录', 'page-a', []);
    /** 追加整页的写入与显式保护重试均失败。 */
    const store = storage.connections[0]!;
    vi.spyOn(store, 'put').mockRejectedValue(new DOMException('整页空间不足', 'QuotaExceededError'));
    recovery.enqueue(changes(), state('追加后的整页正文'));
    await expect(recovery.ensurePageProtected('page-a')).rejects.toThrow('整页空间不足');
    expect(recovery.getStatus().error).toContain('整页空间不足');
    await expect(recovery.beforeWrite(batch(state('追加后的整页正文')))).rejects.toThrow('整页空间不足');
    await expect(recovery.prepareReload()).rejects.toThrow('不能刷新');
    // 失败不能清空最初快速记录；新页面依旧有可恢复原文。
    vi.restoreAllMocks();
    /** 刷新读取时不会依赖失效的内存输入。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    expect(await reopened.readCapture()).toMatchObject({ text: '尚未安全追加的快速记录' });
  });

  it('新标签空白快速记录不会遮蔽其他标签较早的未完成记录', async () => {
    /** 旧标签留下非空内容，此后用户仅打开另一个空白窗口。 */
    const previous = new WebRecovery(state(), () => 'epoch:1');
    await previous.open('server:vault');
    /** 显式控制时间保证新空记录确实比旧记录更新。 */
    const time = vi.spyOn(Date, 'now').mockReturnValue(100);
    await previous.saveCapture('旧标签尚未提交的内容', 'page-a', []);
    /** 新标签没有先读取旧记录，模拟另一个页面的空初始检查点。 */
    const blank = new WebRecovery(state(), () => 'epoch:1');
    await blank.open('server:vault');
    time.mockReturnValue(200);
    await blank.saveCapture('', 'page-a', []);
    /** 再次打开应选取非空恢复内容，而非最新空白值。 */
    const reopened = new WebRecovery(state(), () => 'epoch:2');
    await reopened.open('server:vault');
    expect(await reopened.readCapture()).toMatchObject({ text: '旧标签尚未提交的内容' });
    expect(reopened.getStatus().capture).toBe(true);
  });
});
