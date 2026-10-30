/**
 * 功能：独立保存共享 Web 笔记的本机草稿，隔离笔记库与标签页并保护迟到保存确认。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:42:00
 */
import { openDB } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import type { DocNode, PageId, PageMeta } from '../core/model';
import type { StoredFile } from './repository';

/** 一份尚未获得服务器保存确认的正文及其共同基准。 */
export interface WebDraft {
  /** 当前页面启动时生成的独立所有者，刷新后不复用。 */
  owner: string;
  /** 稳定页面标识，不使用可重命名的文件路径。 */
  pageId: PageId;
  /** 当前待保存的页面元数据。 */
  page: PageMeta;
  /** 当前待保存的完整正文。 */
  doc: DocNode;
  /** 首次编辑时服务器已确认的页面，新页面使用空值。 */
  basePage: PageMeta | null;
  /** 首次编辑时服务器已确认的正文，新页面使用空值。 */
  baseDoc: DocNode | null;
  /** 首次编辑时服务器提供的版本标识。 */
  revision: string;
  /** 所有者内单调递增的草稿序号。 */
  sequence: number;
  /** 最近一次编辑的本机时间。 */
  updatedAt: number;
  /** 尚未上传成功的附件，随草稿事务原样保存。 */
  pendingFiles?: StoredFile[];
}

/** 数据库内部记录增加笔记库命名空间，不泄露到调用方。 */
interface StoredDraft extends WebDraft {
  /** 服务器稳定身份与笔记库标识组成的命名空间。 */
  namespace: string;
}

/** 草稿使用独立数据库，避免升级既有笔记数据库。 */
interface WebDraftDB extends DBSchema {
  /** 复合主键确保不同标签和不同笔记库互不覆盖。 */
  drafts: {
    key: [string, string, string];
    value: StoredDraft;
    indexes: { namespace: string };
  };
  /** 加密保护标记跨标签生效，阻止陈旧标签重新写入明文草稿。 */
  protectedPages: {
    /** 标记以笔记库与页面稳定标识定位。 */
    key: [string, string];
    /** 只保留身份，不存储任何正文信息。 */
    value: { namespace: string; pageId: PageId };
  };
}

/** 仅在事务提交后报告保存成功，任何存储异常交给界面显示。 */
export interface WebDraftStore {
  /** 保存新草稿；已保存的相同或更新序号不会被旧调用覆盖。 */
  put(draft: WebDraft): Promise<void>;
  /** 返回当前笔记库全部标签留下的草稿。 */
  list(): Promise<WebDraft[]>;
  /** 仅清理与服务器确认完全一致的序号，迟到确认不会删除新编辑。 */
  acknowledge(owner: string, pageId: PageId, sequence: number): Promise<boolean>;
  /** 清理当前笔记库该页所有标签留下的明文内容。 */
  purgePage(pageId: PageId): Promise<void>;
  /** 设置跨标签的加密保护；启用时原子清理该页全部明文草稿。 */
  setEncrypted(pageId: PageId, encrypted: boolean): Promise<void>;
  /** 仅在全部标签均无该页草稿时允许新增加密，避免丢弃其他标签未同步内容。 */
  protectIfClean(pageId: PageId): Promise<void>;
  /** 服务器已经加密时只阻止新明文写入，保留旧标签尚未同步的唯一副本。 */
  blockPage(pageId: PageId): Promise<void>;
  /** 释放当前数据库连接。 */
  close(): void;
}

/** 每次页面启动生成新身份，复制标签页也不会共享会话存储身份。 */
export function createDraftOwner(): string {
  return crypto.randomUUID();
}

/** 打开命名空间内的持久化草稿；不可用或容量不足时直接拒绝。 */
export async function openWebDraftStore(
  /** 由服务器稳定身份和笔记库稳定标识组成，不使用进程修订号。 */
  namespace: string,
  /** 测试可使用独立库名，实际运行始终复用默认数据库。 */
  databaseName = 'morrow-web-drafts',
): Promise<WebDraftStore> {
  if (!namespace.trim()) throw new Error('Draft namespace must not be empty.');
  /** 数据库连接只属于本次调用，关闭不影响其他标签。 */
  const database = await openDB<WebDraftDB>(databaseName, 2, {
    /** 首次打开只创建草稿表与笔记库索引。 */
    upgrade(db, oldVersion) {
      if (oldVersion < 1)
        db.createObjectStore('drafts', { keyPath: ['namespace', 'owner', 'pageId'] }).createIndex(
          'namespace',
          'namespace',
        );
      if (oldVersion < 2) db.createObjectStore('protectedPages', { keyPath: ['namespace', 'pageId'] });
    },
    /** 新版本需要升级时释放连接，避免阻塞其他页面。 */
    blocking() {
      database.close();
    },
  });
  return new IndexedWebDraftStore(database, namespace);
}

/** 将序号比较与修改放进同一事务，避免多个连接间的检查写入竞争。 */
class IndexedWebDraftStore implements WebDraftStore {
  /** 保留独立连接和固定命名空间。 */
  constructor(
    /** 当前调用拥有的数据库连接。 */
    private readonly database: IDBPDatabase<WebDraftDB>,
    /** 当前服务器笔记库命名空间。 */
    private readonly namespace: string,
  ) {}

  /** 加密笔记及其明文基准均禁止进入本机草稿。 */
  async put(draft: WebDraft): Promise<void> {
    if (draft.page.encrypted || draft.basePage?.encrypted)
      throw new Error('Encrypted pages cannot keep plain drafts.');
    if (
      !draft.owner ||
      !draft.pageId ||
      draft.page.id !== draft.pageId ||
      (draft.basePage !== null && draft.basePage.id !== draft.pageId) ||
      !Number.isSafeInteger(draft.sequence) ||
      draft.sequence < 1 ||
      !Number.isFinite(draft.updatedAt)
    )
      throw new Error('Invalid draft identity or sequence.');
    /** 读写事务串行化同一个标签页同一笔记的更新。 */
    const transaction = this.database.transaction(['drafts', 'protectedPages'], 'readwrite');
    try {
      /** 先检查跨标签保护标记，陈旧页面不能重新写入已加密正文。 */
      const protectedPage = await transaction
        .objectStore('protectedPages')
        .get([this.namespace, draft.pageId]);
      if (protectedPage) throw new Error('Encrypted pages cannot keep plain drafts.');
      /** 完整复合键避免其他笔记库或标签页的同名页面碰撞。 */
      const key: [string, string, string] = [this.namespace, draft.owner, draft.pageId];
      /** 已存在的新序号不能被较早开始但较迟完成的调用取代。 */
      const previous = await transaction.objectStore('drafts').get(key);
      if (!previous || previous.sequence < draft.sequence)
        await transaction.objectStore('drafts').put({ ...draft, namespace: this.namespace });
      await transaction.done;
    } catch (error) {
      // 同时消费事务错误，避免请求与事务各自产生未处理拒绝。
      await transaction.done.catch(() => {});
      throw error;
    }
  }

  /** 通过索引只读取当前笔记库，不根据当前标签过滤遗留草稿。 */
  async list(): Promise<WebDraft[]> {
    /** 数据库返回结构化克隆，调用方修改不会改变已落盘数据。 */
    const records = await this.database.getAllFromIndex('drafts', 'namespace', this.namespace);
    return records.map((record) => {
      /** 去除内部命名空间后保留正文、基准与附件。 */
      const { namespace: storedNamespace, ...draft } = record;
      void storedNamespace;
      return draft;
    });
  }

  /** 清理检查和删除是一个原子操作，无法清除别的标签或更新序号。 */
  async acknowledge(owner: string, pageId: PageId, sequence: number): Promise<boolean> {
    /** 当前事务同时验证版本和删除记录。 */
    const transaction = this.database.transaction('drafts', 'readwrite');
    try {
      /** 确认只能针对一个明确的草稿所有者。 */
      const key: [string, string, string] = [this.namespace, owner, pageId];
      /** 缺失或已更新的草稿均不执行删除。 */
      const record = await transaction.store.get(key);
      /** 返回值表示本次服务器确认实际清理了一份草稿。 */
      const matched = record?.sequence === sequence;
      if (matched) await transaction.store.delete(key);
      await transaction.done;
      return matched;
    } catch (error) {
      await transaction.done.catch(() => {});
      throw error;
    }
  }

  /** 清理全部标签的该页草稿，不触及同库其他页面或其他笔记库。 */
  async purgePage(pageId: PageId): Promise<void> {
    /** 清理同一页面所有所有者，整个过程保持单一读写事务。 */
    const transaction = this.database.transaction('drafts', 'readwrite');
    try {
      /** 命名空间索引限定扫描范围，不能误删其他服务器草稿。 */
      const records = await transaction.store.index('namespace').getAll(this.namespace);
      for (const record of records)
        if (record.pageId === pageId) await transaction.store.delete([this.namespace, record.owner, pageId]);
      await transaction.done;
    } catch (error) {
      // 同步创建删除请求失败时也必须回滚之前已经排队的删除。
      try {
        transaction.abort();
      } catch {
        /* 已终止事务无需再次中止。 */
      }
      await transaction.done.catch(() => {});
      throw error;
    }
  }

  /** 启用保护时标记与清理原子提交，其他标签无法趁中间状态写入。 */
  async setEncrypted(pageId: PageId, encrypted: boolean): Promise<void> {
    if (!pageId) throw new Error('Invalid encrypted page identity.');
    /** 同时锁住草稿和保护表，序列化其他连接的草稿写入。 */
    const transaction = this.database.transaction(['drafts', 'protectedPages'], 'readwrite');
    try {
      if (encrypted) {
        await transaction.objectStore('protectedPages').put({ namespace: this.namespace, pageId });
        /** 保护生效时连同其他标签的旧草稿一并清除。 */
        const records = await transaction.objectStore('drafts').index('namespace').getAll(this.namespace);
        for (const record of records)
          if (record.pageId === pageId)
            await transaction.objectStore('drafts').delete([this.namespace, record.owner, pageId]);
      } else {
        await transaction.objectStore('protectedPages').delete([this.namespace, pageId]);
      }
      await transaction.done;
    } catch (error) {
      // 清理或写标记任一步失败都回滚，调用方不能报告加密保护完成。
      try {
        transaction.abort();
      } catch {
        /* 已终止事务无需再次中止。 */
      }
      await transaction.done.catch(() => {});
      throw error;
    }
  }

  /** 检查所有标签草稿和加密标记写入使用同一事务，防止检查后出现新草稿。 */
  async protectIfClean(pageId: PageId): Promise<void> {
    if (!pageId) throw new Error('Invalid encrypted page identity.');
    /** 与普通草稿写入锁定相同存储，确保跨连接串行化。 */
    const transaction = this.database.transaction(['drafts', 'protectedPages'], 'readwrite');
    try {
      /** 任一标签仍有本机草稿都不能自动删除或开始加密。 */
      const records = await transaction.objectStore('drafts').index('namespace').getAll(this.namespace);
      if (records.some((record) => record.pageId === pageId))
        throw new Error('This page has unsynced drafts. Resolve them before encrypting.');
      await transaction.objectStore('protectedPages').put({ namespace: this.namespace, pageId });
      await transaction.done;
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* 已终止事务无需再次中止。 */
      }
      await transaction.done.catch(() => {});
      throw error;
    }
  }

  /** 已有明文草稿可能是旧设备唯一副本，发现服务端加密时不能静默销毁。 */
  async blockPage(pageId: PageId): Promise<void> {
    if (!pageId) throw new Error('Invalid encrypted page identity.');
    await this.database.put('protectedPages', { namespace: this.namespace, pageId });
  }

  /** 关闭连接后继续操作会如实返回数据库异常。 */
  close(): void {
    this.database.close();
  }
}
