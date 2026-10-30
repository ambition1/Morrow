/**
 * 功能：协调共享笔记的本机草稿、服务器确认与恢复入口，保留冲突双方内容。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:43:10
 */
import type { Changes } from '../../core/commands';
import { newPageMeta } from '../../core/model';
import type { WorkspaceState, PageMeta, DocNode } from '../../core/model';
import type { WriteBatch } from '../../storage/repository';
import { createDraftOwner, openWebDraftStore } from '../../storage/webDrafts';
import type { WebDraft, WebDraftStore } from '../../storage/webDrafts';

/** 可订阅的本机保护状态；失败不能伪装为已存本机。 */
export interface RecoveryStatus {
  /** 尚未确认的普通页面草稿。 */
  drafts: WebDraft[];
  /** 本机保护失败的可诊断信息。 */
  error: string | null;
  /** 本机事务尚未完成时不能报告已保护。 */
  pending: boolean;
  /** 尚有未发送的快速记录或附件，启动时提供恢复入口。 */
  capture: boolean;
}

/** 一个页面生命周期拥有独立草稿身份，重复标签页不会覆盖彼此。 */
export class WebRecovery {
  /** 当前标签页唯一身份。 */
  private readonly owner = createDraftOwner();
  /** 同一页面递增的编辑代数。 */
  private sequence = 0;
  /** 尚未完成的本机事务计数，旧事务不能提前报告完成。 */
  private localWrites = 0;
  /** 各页面的失败独立保留，其他页面成功不能掩盖未保护内容。 */
  private readonly failures = new Map<string, string>();
  /** 本标签页最近排队的草稿。 */
  private readonly latest = new Map<string, WebDraft>();
  /** 服务器最后确认的状态，用于共同基准。 */
  private base: {
    pages: Record<string, PageMeta>;
    docs: Record<string, DocNode>;
  };
  /** 本机写入严格串行，关闭前可等待既有任务。 */
  private pending: Promise<void> = Promise.resolve();
  /** 状态通知订阅者。 */
  private readonly listeners = new Set<() => void>();
  /** 已打开的独立草稿存储。 */
  private store: WebDraftStore | null = null;
  /** 当前不可变状态快照。 */
  private status: RecoveryStatus = { drafts: [], error: null, pending: false, capture: false };

  constructor(
    initial: WorkspaceState,
    private readonly revision: () => string,
  ) {
    this.base = structuredClone({ pages: { ...initial.pages }, docs: { ...initial.docs } });
  }

  /** 初始化只读取旧草稿，禁止空初始状态覆盖已有内容。 */
  async open(namespace: string): Promise<void> {
    try {
      this.store = await openWebDraftStore(namespace);
      for (const page of Object.values(this.base.pages)) {
        if (page.encrypted) await this.store.blockPage(page.id);
      }
      await this.refresh();
    } catch (error) {
      this.setFailure('storage', error);
    }
  }

  /** 对比界面只能读取当前桥接版本，不能推进或强制覆盖。 */
  getRevision = (): string => this.revision();

  /** 加密标记与清除明文在同一存储事务内完成。 */
  async setEncrypted(pageId: string, encrypted: boolean): Promise<void> {
    await this.pending;
    if (!this.store) throw new Error('本机草稿存储不可用');
    if (encrypted) await this.store.protectIfClean(pageId);
    else await this.store.setEncrypted(pageId, false);
    this.latest.delete(pageId);
    /** 解除加密时移除旧明文基准，下一次编辑从未保存状态建立保护。 */
    if (!encrypted) {
      delete this.base.pages[pageId];
      delete this.base.docs[pageId];
    }
    await this.refresh();
  }

  /** 提供 React 外部状态订阅所需的稳定函数。 */
  getStatus = (): RecoveryStatus => this.status;
  /** 保存状态与恢复对话框共用同一个来源。 */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** 命令入队即持久化；服务器防抖及网络失败不影响本机写入。 */
  enqueue(changes: Changes, state: WorkspaceState): void {
    /** 当前命令所涉及的页面去重。 */
    const ids = new Set([...changes.pages, ...changes.docs]);
    for (const id of ids) {
      /** 加密页面不写入明文；缺少正文的页面也不能制造空草稿。 */
      const page = state.pages[id];
      /** 正文与共同基准独立复制，不保留可变引用。 */
      const doc = state.docs[id];
      if (!page || !doc || page.encrypted || this.base.pages[id]?.encrypted) continue;
      /** 这一代草稿的稳定值贯穿本机写入与服务器确认。 */
      const draft: WebDraft = structuredClone({
        owner: this.owner,
        pageId: id,
        page,
        doc,
        basePage: this.base.pages[id] ?? null,
        baseDoc: this.base.docs[id] ?? null,
        revision: this.revision(),
        sequence: ++this.sequence,
        updatedAt: Date.now(),
      });
      this.latest.set(id, draft);
      this.localWrites++;
      this.publish({ pending: true });
      this.pending = this.pending.then(async () => {
        try {
          if (!this.store) throw new Error('本机草稿存储不可用');
          await this.store.put(draft);
          await this.refresh();
          this.setFailure(id, null);
        } catch (error) {
          this.setFailure(id, error);
        } finally {
          this.localWrites--;
          this.publish({ pending: this.localWrites > 0 });
        }
      });
    }
  }

  /** 返回与待发送正文完全匹配的令牌；迟到响应不能删除新编辑。 */
  async beforeWrite(batch: WriteBatch): Promise<WebDraft[]> {
    await this.pending;
    /** 快速记录检查点失败时禁止先确认服务器正文，否则刷新可能重复追加。 */
    if (this.failures.has('capture')) throw new Error(this.failures.get('capture'));
    return [...new Set([...batch.pages.map((page) => page.id), ...batch.docs.map((record) => record.id)])]
      .map((id) => this.latest.get(id))
      .filter((draft): draft is WebDraft => Boolean(draft))
      .filter(
        (draft) =>
          JSON.stringify(batch.state?.docs[draft.pageId]) === JSON.stringify(draft.doc) &&
          JSON.stringify(batch.state?.pages[draft.pageId]) === JSON.stringify(draft.page),
      );
  }

  /** 只有服务器确认之后推进共同基准和清理相同代数的草稿。 */
  async afterWrite(batch: WriteBatch, token: unknown): Promise<void> {
    /** 回执只包含本次请求开始时的草稿，不读取最新编辑代替它。 */
    const drafts = token as WebDraft[];
    for (const draft of drafts) {
      if (!this.latest.has(draft.pageId) || this.latest.get(draft.pageId)?.sequence === draft.sequence)
        this.setFailure(draft.pageId, null);
      this.base.pages[draft.pageId] = structuredClone(draft.page);
      this.base.docs[draft.pageId] = structuredClone(draft.doc);
      if (this.latest.get(draft.pageId)?.sequence === draft.sequence) this.latest.delete(draft.pageId);
      try {
        await this.store?.acknowledge(draft.owner, draft.pageId, draft.sequence);
      } catch (error) {
        this.publish({ error: String(error) });
      }
    }
    for (const id of batch.removed) {
      delete this.base.pages[id];
      delete this.base.docs[id];
    }
    try {
      await this.refresh();
    } catch (error) {
      this.publish({ error: String(error) });
    }
  }

  /** 快速记录清空输入前必须确认追加后的整页草稿已保护，而非只等待事务结束。 */
  async ensurePageProtected(pageId: string): Promise<void> {
    await this.flushLocal();
    /** 服务器已确认并移除 latest 时，原文已经安全落盘。 */
    const draft = this.latest.get(pageId);
    if (!draft) return;
    try {
      if (!this.store) throw new Error('本机草稿存储不可用');
      await this.store.put(draft);
      this.setFailure(pageId, null);
      await this.refresh();
    } catch (error) {
      this.setFailure(pageId, error);
      this.setFailure('capture', error);
      throw error;
    }
  }

  /** 用户明确处理旧草稿后才移除，恢复保存失败时继续保留。 */
  async dismiss(draft: WebDraft): Promise<void> {
    if (!this.store) throw new Error('本机草稿存储不可用');
    await this.store.acknowledge(draft.owner, draft.pageId, draft.sequence);
    await this.refresh();
  }

  /** 最近一次写入的快速记录，服务器回执只能清理这个精确代数。 */
  private currentCapture: WebDraft | null = null;

  /** 快速记录包含尚未上传的文件，使用独立记录而非伪装成已保存笔记。 */
  async saveCapture(text: string, target: string, files: File[]): Promise<void> {
    /** 调用立即加入本机队列，附件读取期间刷新也必须等待。 */
    const sequence = ++this.sequence;
    this.localWrites++;
    this.publish({ pending: true });
    /** 捕获任务向调用者传播失败，内部队列仍允许下一次重试。 */
    const task = this.pending
      .then(async () => {
        if (!this.store) throw new Error('本机草稿存储不可用');
        /** 本机附件元数据与二进制内容在同一事务里保存。 */
        const pendingFiles = await Promise.all(
          files.map(async (file, index) => ({
            meta: {
              id: `capture-${index}`,
              name: file.name,
              type: file.type,
              size: file.size,
              createdAt: file.lastModified,
            },
            data: await file.arrayBuffer(),
          })),
        );
        /** 合成页只在草稿数据库存在，不会写入服务器或笔记索引。 */
        const page = newPageMeta({
          id: 'quick-capture',
          parentId: null,
          createdAt: Date.now(),
          title: 'Quick capture',
        });
        const captured: WebDraft = {
          owner: this.owner,
          pageId: page.id,
          page,
          doc: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: JSON.stringify({ text, target }) }] },
            ],
          },
          basePage: null,
          baseDoc: null,
          revision: this.revision(),
          sequence,
          updatedAt: Date.now(),
          pendingFiles,
        };
        await this.store.put(captured);
        this.currentCapture = captured;
        /** 新检查点已持久化后才清除被读取的旧来源，失败仍保留两份。 */
        if (this.captureSource) {
          await this.store.acknowledge(
            this.captureSource.owner,
            this.captureSource.pageId,
            this.captureSource.sequence,
          );
          this.captureSource = null;
        }
        this.setFailure('capture', null);
        await this.refresh();
      })
      .catch((error: unknown) => {
        this.setFailure('capture', error);
        throw error;
      })
      .finally(() => {
        this.localWrites--;
        this.publish({ pending: this.localWrites > 0 });
      });
    this.pending = task.catch(() => {});
    await task;
  }

  /** 启动快速记录时读取旧标签或刷新留下的最新一份记录。 */
  async readCapture(): Promise<{ text: string; target: string; files: File[] } | null> {
    if (!this.store) throw new Error('本机草稿存储不可用');
    /** 最近一份未确认记录优先，多标签记录仍单独保留。 */
    const draft = (await this.store.list())
      .filter((item) => {
        if (item.pageId !== 'quick-capture') return false;
        try {
          return Boolean(
            JSON.parse(item.doc.content?.[0]?.content?.[0]?.text ?? '{}').text?.trim() ||
            item.pendingFiles?.length,
          );
        } catch {
          return true;
        }
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!draft) return null;
    /** 本应用保存的结构化文本不执行 HTML 或脚本。 */
    const value = JSON.parse(draft.doc.content?.[0]?.content?.[0]?.text ?? '{}') as {
      text: string;
      target: string;
    };
    this.captureSource = draft;
    return {
      ...value,
      files: (draft.pendingFiles ?? []).map(
        (file) =>
          new File([file.data], file.meta.name, { type: file.meta.type, lastModified: file.meta.createdAt }),
      ),
    };
  }

  /** 被加载的快速记录只在成功发送后清理，其他标签的记录不受影响。 */
  private captureSource: WebDraft | null = null;
  /** 快速记录服务端确认后清理本次标签及其实际读取的来源。 */
  captureToken(): WebDraft[] {
    return [this.currentCapture, this.captureSource].filter((draft): draft is WebDraft => Boolean(draft));
  }

  /** 服务器确认后只清理发送时的确切代数，较新的快速记录不会丢失。 */
  async clearCapture(tokens: WebDraft[] = this.captureToken()): Promise<void> {
    if (!this.store) return;
    for (const draft of tokens) await this.store.acknowledge(draft.owner, draft.pageId, draft.sequence);
    if (
      tokens.some(
        (draft) =>
          draft.owner === this.currentCapture?.owner && draft.sequence === this.currentCapture.sequence,
      )
    )
      this.currentCapture = null;
    this.captureSource = null;
    await this.refresh();
  }

  /** 刷新草稿列表也读取其他标签页留下的独立副本。 */
  async refresh(): Promise<void> {
    if (!this.store) return;
    /** 一次读取同时刷新正文草稿与待上传的快速记录。 */
    const all = await this.store.list();
    this.publish({
      drafts: all.filter((draft) => draft.pageId !== 'quick-capture'),
      capture: all.some((draft) => {
        if (draft.pageId !== 'quick-capture') return false;
        try {
          return Boolean(
            JSON.parse(draft.doc.content?.[0]?.content?.[0]?.text ?? '{}').text?.trim() ||
            draft.pendingFiles?.length,
          );
        } catch {
          return true;
        }
      }),
    });
  }

  /** 只有明确完成本机保护的刷新才跳过退出提醒。 */
  safeToReload = false;
  /** 恢复窗口的刷新必须确认所有页面的本机失败均已解除。 */
  async prepareReload(): Promise<void> {
    await this.flushLocal();
    if (this.status.error || this.status.pending) throw new Error('本机草稿尚未保护，不能刷新');
    this.safeToReload = true;
  }

  /** 允许刷新前确认本机事务已完成。 */
  async flushLocal(): Promise<void> {
    /** 等待期间新增的任务也属于刷新前必须确认的内容。 */
    let waiting: Promise<void>;
    do {
      waiting = this.pending;
      await waiting;
    } while (waiting !== this.pending);
  }

  /** 按失败来源清理，避免跨页成功覆盖未落盘草稿的错误。 */
  private setFailure(key: string, error: unknown): void {
    if (error === null) this.failures.delete(key);
    else this.failures.set(key, String(error));
    this.publish({ error: this.failures.values().next().value ?? null });
  }

  /** 不可变快照保证外部订阅不会无限重复渲染。 */
  private publish(patch: Partial<RecoveryStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const listener of this.listeners) listener();
  }
}

/** Web 工作区唯一恢复协调器；桌面无需启动该能力。 */
export let webRecovery: WebRecovery | null = null;
/** 在工作区开放编辑之前发布协调器。 */
export function setWebRecovery(recovery: WebRecovery): void {
  webRecovery = recovery;
}
