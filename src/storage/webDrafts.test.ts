/**
 * 功能：验证本机草稿跨重开恢复、笔记库与标签隔离、迟到确认和存储失败保护。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:42:40
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDB } from 'idb';
import { applyCommand } from '../core/commands';
import { emptyWorkspace } from '../core/model';
import type { DocNode, PageMeta } from '../core/model';
import { createDraftOwner, openWebDraftStore } from './webDrafts';
import type { WebDraft, WebDraftStore } from './webDrafts';

/** 每项测试保留自己的数据库名称，避免并行污染。 */
const databaseNames: string[] = [];
/** 测试结束前关闭所有连接，确保删除数据库不会阻塞。 */
const connections: WebDraftStore[] = [];

/** 打开独立连接，可指定相同库名模拟多个标签。 */
async function open(namespace = 'server-a:vault-a', databaseName = `draft-test-${crypto.randomUUID()}`) {
  if (!databaseNames.includes(databaseName)) databaseNames.push(databaseName);
  /** 连接在测试清理阶段统一关闭。 */
  const store = await openWebDraftStore(namespace, databaseName);
  connections.push(store);
  return { store, databaseName };
}

/** 构造可读正文，避免测试依赖编辑器。 */
function doc(text: string): DocNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/** 通过正式页面创建命令获取完整页面元数据。 */
function page(): PageMeta {
  /** 创建命令提供与实际应用一致的缺省字段。 */
  const result = applyCommand(emptyWorkspace(), {
    type: 'page.create',
    id: 'page-a',
    parentId: null,
    title: '草稿笔记',
    now: 1,
  });
  if (!result.ok) throw new Error(result.error);
  return result.value.state.pages['page-a']!;
}

/** 每个草稿都包含正文、基准与可独立恢复的页面信息。 */
function draft(patch: Partial<WebDraft> = {}): WebDraft {
  return {
    owner: 'tab-a',
    pageId: 'page-a',
    page: page(),
    doc: doc('尚未同步的修改'),
    basePage: page(),
    baseDoc: doc('服务器原文'),
    revision: 'server-epoch:4',
    sequence: 1,
    updatedAt: 20,
    ...patch,
  };
}

/** 清理连接和测试数据库，异常模拟不会影响下一项测试。 */
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const connection of connections.splice(0)) connection.close();
  for (const databaseName of databaseNames.splice(0)) {
    await new Promise<void>((resolve, reject) => {
      /** 删除只发生在测试创建的随机库名。 */
      const request = indexedDB.deleteDatabase(databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Test database remained open.'));
    });
  }
});

describe('共享 Web 本机草稿', () => {
  it('事务提交后跨连接重开保留正文、共同基准和待上传附件', async () => {
    /** 首次连接模拟编辑标签页。 */
    const first = await open();
    /** 附件与正文一起保留，刷新后不会只恢复失效引用。 */
    const record = draft({
      pendingFiles: [
        {
          meta: { id: 'file-a', name: '附件.txt', type: 'text/plain', size: 3, createdAt: 1 },
          data: new TextEncoder().encode('abc').buffer as ArrayBuffer,
        },
      ],
    });
    await first.store.put(record);
    first.store.close();
    /** 新连接模拟页面刷新，能够找到旧所有者的草稿。 */
    const second = await open('server-a:vault-a', first.databaseName);
    expect(await second.store.list()).toEqual([record]);
  });

  it('同一页面在两个标签和两个笔记库中互不覆盖', async () => {
    /** 两个连接访问同一数据库但命名空间不同。 */
    const first = await open();
    /** 服务器或笔记库身份改变时不应混入另一份草稿。 */
    const otherVault = await open('server-b:vault-a', first.databaseName);
    await Promise.all([
      first.store.put(draft()),
      first.store.put(draft({ owner: 'tab-b', doc: doc('另一标签的修改') })),
      otherVault.store.put(draft({ doc: doc('另一服务器的修改') })),
    ]);
    expect((await first.store.list()).map((record) => record.owner)).toEqual(['tab-a', 'tab-b']);
    expect(await otherVault.store.list()).toEqual([draft({ doc: doc('另一服务器的修改') })]);
    expect(await first.store.acknowledge('tab-a', 'page-a', 1)).toBe(true);
    expect((await first.store.list()).map((record) => record.owner)).toEqual(['tab-b']);
    expect(await otherVault.store.list()).toHaveLength(1);
  });

  it('迟到写入与旧保存确认都不能覆盖或删除更新的草稿', async () => {
    /** 共享数据库模拟同一标签的两个异步保存回调。 */
    const first = await open();
    /** 新连接验证检查与删除在数据库事务内完成。 */
    const second = await open('server-a:vault-a', first.databaseName);
    await first.store.put(draft({ sequence: 2, doc: doc('更新的修改') }));
    await second.store.put(draft());
    expect(await second.store.acknowledge('tab-a', 'page-a', 1)).toBe(false);
    expect(await first.store.list()).toEqual([draft({ sequence: 2, doc: doc('更新的修改') })]);
    expect(await first.store.acknowledge('tab-a', 'page-a', 2)).toBe(true);
    expect(await second.store.list()).toEqual([]);
  });

  it('相同序号的重试不会改写已提交正文', async () => {
    /** 同序号回调必须保持幂等，不能携带另一个正文覆盖。 */
    const { store } = await open();
    await store.put(draft());
    await store.put(draft({ doc: doc('错误的重复回调') }));
    expect(await store.list()).toEqual([draft()]);
  });

  it('容量不足如实拒绝，之前提交的草稿仍可恢复', async () => {
    /** 先保存一份已确认落盘的草稿。 */
    const { store } = await open();
    await store.put(draft());
    /** 模拟浏览器在写入时报告额度不足。 */
    const quota = new DOMException('本机空间不足', 'QuotaExceededError');
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw quota;
    });
    await expect(store.put(draft({ sequence: 2 }))).rejects.toBe(quota);
    expect(await store.list()).toEqual([draft()]);
  });

  it('浏览器禁用 IndexedDB 时不返回虚假的可保存存储', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(openWebDraftStore('server-a:vault-a')).rejects.toThrow();
  });

  it('加密笔记及加密基准都不能留下明文草稿或附件', async () => {
    /** 当前笔记已加密和基准曾经加密都必须拒绝。 */
    const { store } = await open();
    await expect(store.put(draft({ page: { ...page(), encrypted: true } }))).rejects.toThrow('Encrypted');
    await expect(store.put(draft({ basePage: { ...page(), encrypted: true } }))).rejects.toThrow('Encrypted');
    expect(await store.list()).toEqual([]);
  });

  it('拒绝不一致页面身份及非法序号，不污染已有草稿', async () => {
    /** 非法主键不能写到其他页面的恢复位置。 */
    const { store } = await open();
    await expect(store.put(draft({ pageId: 'other-page' }))).rejects.toThrow('Invalid');
    await expect(store.put(draft({ sequence: 0 }))).rejects.toThrow('Invalid');
    await expect(store.put(draft({ sequence: Number.NaN }))).rejects.toThrow('Invalid');
    expect(await store.list()).toEqual([]);
  });

  it('每次启动生成不同的所有者并拒绝空命名空间', async () => {
    expect(createDraftOwner()).not.toBe(createDraftOwner());
    await expect(openWebDraftStore(' ')).rejects.toThrow('namespace');
  });

  it('加密时清理所有标签旧草稿，并阻止其他标签重新写入明文', async () => {
    /** 两个连接模拟同时编辑同一页面的标签。 */
    const first = await open();
    /** 陈旧连接仍保留未加密的页面元数据。 */
    const stale = await open('server-a:vault-a', first.databaseName);
    await first.store.put(draft());
    await stale.store.put(draft({ owner: 'tab-b' }));
    await first.store.setEncrypted('page-a', true);
    expect(await stale.store.list()).toEqual([]);
    await expect(stale.store.put(draft({ owner: 'tab-b', sequence: 2 }))).rejects.toThrow('Encrypted');
    first.store.close();
    /** 刷新后仍保留加密标记，不能重新产生明文。 */
    const reopened = await open('server-a:vault-a', first.databaseName);
    await expect(reopened.store.put(draft({ sequence: 3 }))).rejects.toThrow('Encrypted');
    await reopened.store.setEncrypted('page-a', false);
    await reopened.store.put(draft({ sequence: 4 }));
    expect((await reopened.store.list())[0]!.sequence).toBe(4);
  });

  it('清理页面仅删除该页全部标签，不影响其他页面或笔记库', async () => {
    /** 主笔记库中同时存在两页草稿。 */
    const first = await open();
    /** 另一个库具有相同页面标识，必须保留。 */
    const other = await open('server-b:vault-a', first.databaseName);
    await first.store.put(draft());
    await first.store.put(draft({ owner: 'tab-b' }));
    await first.store.put(draft({ pageId: 'page-b', page: { ...page(), id: 'page-b' }, basePage: null }));
    await other.store.put(draft());
    await first.store.purgePage('page-a');
    expect((await first.store.list()).map((record) => record.pageId)).toEqual(['page-b']);
    expect(await other.store.list()).toHaveLength(1);
    // 清理不表示加密，后续普通编辑仍可继续保存。
    await first.store.put(draft({ sequence: 2 }));
    expect(await first.store.list()).toHaveLength(2);
  });

  it('写入加密标记后清理失败会回滚标记与删除，重试仍可保护', async () => {
    /** 已有两个标签明文，清理必须全成或全败。 */
    const { store } = await open();
    await store.put(draft());
    await store.put(draft({ owner: 'tab-b' }));
    /** 模拟第二个删除在请求创建前遇到浏览器异常。 */
    const actualDelete = IDBObjectStore.prototype.delete;
    /** 计数仅针对草稿删除请求。 */
    let deletions = 0;
    vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
      if (++deletions === 2) throw new DOMException('写入失败', 'UnknownError');
      return actualDelete.call(this, key);
    });
    await expect(store.setEncrypted('page-a', true)).rejects.toThrow('写入失败');
    vi.restoreAllMocks();
    expect(await store.list()).toHaveLength(2);
    await store.put(draft({ sequence: 2 }));
    await store.setEncrypted('page-a', true);
    expect(await store.list()).toEqual([]);
  });

  it('旧版草稿数据库升级后保留正文并增加加密保护', async () => {
    /** 创建真实第一版数据库，以验证升级不会覆盖已有记录。 */
    const databaseName = `draft-upgrade-${crypto.randomUUID()}`;
    databaseNames.push(databaseName);
    /** 第一版仅有草稿表。 */
    const old = await openDB(databaseName, 1, {
      upgrade(database) {
        database
          .createObjectStore('drafts', { keyPath: ['namespace', 'owner', 'pageId'] })
          .createIndex('namespace', 'namespace');
      },
    });
    await old.put('drafts', { ...draft(), namespace: 'server-a:vault-a' });
    old.close();
    /** 新版连接使用升级后的保护表。 */
    const upgraded = await open('server-a:vault-a', databaseName);
    expect(await upgraded.store.list()).toEqual([draft()]);
    await upgraded.store.setEncrypted('page-a', true);
    expect(await upgraded.store.list()).toEqual([]);
  });

  it('开始加密时若其他标签仍有未同步草稿，拒绝保护并保留全部内容', async () => {
    /** 新加密操作不能销毁另一个标签唯一的未同步版本。 */
    const first = await open();
    /** 草稿来自另一个独立标签。 */
    const second = await open('server-a:vault-a', first.databaseName);
    await second.store.put(draft({ owner: 'other-tab', doc: doc('唯一的未同步内容') }));
    await expect(first.store.protectIfClean('page-a')).rejects.toThrow('unsynced drafts');
    expect(await first.store.list()).toEqual([draft({ owner: 'other-tab', doc: doc('唯一的未同步内容') })]);
    // 拒绝操作不会留下保护标记，原标签仍可继续保护新输入。
    await second.store.put(draft({ owner: 'other-tab', sequence: 2 }));
    expect((await first.store.list())[0]!.sequence).toBe(2);
    await second.store.acknowledge('other-tab', 'page-a', 2);
    await first.store.protectIfClean('page-a');
    await expect(second.store.put(draft({ sequence: 3 }))).rejects.toThrow('Encrypted');
  });

  it('启动时发现服务器已加密只阻止新写入，保留此前唯一的未同步草稿', async () => {
    /** 旧标签留下断网修改，服务器随后由其他设备加密。 */
    const first = await open();
    /** 第二个连接模拟新加载的已加密页面。 */
    const second = await open('server-a:vault-a', first.databaseName);
    await first.store.put(draft({ doc: doc('加密前尚未同步的内容') }));
    await second.store.blockPage('page-a');
    expect(await second.store.list()).toEqual([draft({ doc: doc('加密前尚未同步的内容') })]);
    await expect(first.store.put(draft({ sequence: 2 }))).rejects.toThrow('Encrypted');
    // 保护标记跨连接重开保持，但旧草稿绝不自动清理。
    first.store.close();
    /** 第三个连接模拟刷新，旧草稿仍存在。 */
    const reopened = await open('server-a:vault-a', first.databaseName);
    expect((await reopened.store.list())[0]!.doc).toEqual(doc('加密前尚未同步的内容'));
    await expect(reopened.store.put(draft({ sequence: 3 }))).rejects.toThrow('Encrypted');
  });

  it('检查加密保护与并发草稿写入保持原子顺序', async () => {
    /** 两个连接竞争同一页面写入与保护。 */
    const first = await open();
    /** 另一连接开始加密。 */
    const second = await open('server-a:vault-a', first.databaseName);
    /** 先发出的草稿事务被观察到，加密必须拒绝。 */
    const written = first.store.put(draft());
    /** 后发出的保护不能在检查后删除草稿。 */
    const protection = second.store.protectIfClean('page-a');
    await written;
    await expect(protection).rejects.toThrow('unsynced drafts');
    expect(await first.store.list()).toHaveLength(1);
    await first.store.acknowledge('tab-a', 'page-a', 1);
    /** 先发出的保护事务使后续陈旧草稿失败。 */
    const protectedPage = second.store.protectIfClean('page-a');
    /** 后发出的草稿必须检查保护标记。 */
    const stale = first.store.put(draft({ sequence: 2 }));
    await protectedPage;
    await expect(stale).rejects.toThrow('Encrypted');
    expect(await first.store.list()).toEqual([]);
  });
});
