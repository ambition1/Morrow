/**
 * 功能：将共享 Web API 适配为既有文件仓库，复用页面、数据库、画布和历史的保存逻辑。
 * 作者：xuanli
 * 创建时间：2026-11-07 19:13:35
 */
import { randomUUID } from 'node:crypto';
import { applyCommand, emptyChanges } from '../core/commands';
import type { Command } from '../core/commands';
import type { DocNode, PageMeta, Snapshot, WorkspaceState } from '../core/model';
import type { VaultScan } from '../core/vault/load';
import { makeResolver, parseOptions, resolveFile } from '../core/vault/load';
import { markdownToDoc } from '../core/markdown/parse';
import { readPageText } from '../core/vault/pageFile';
import { basename, isPageFile, stripExtension } from '../core/vault/paths';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import type { VaultBridge, VaultFileInfo } from '../storage/vaultBridge';
import { VaultRepository } from '../storage/vaultRepository';
import { isEffectivelyTrashed } from '../core/tree';

/** 构造携带状态和版本的错误，不在调用失败后自动覆盖或重试。 */
export function vaultError(status: number, message: string, revision?: string): Error {
  return Object.assign(new Error(message), { status, revision });
}

/** 每次工具调用使用独立快照和仓库，内部文件操作仍由 Web API 验证与串行执行。 */
export class WebVault implements VaultBridge {
  /** 仓库定位仅用于说明，不允许工具指定任意远程代理地址。 */
  readonly root = '共享 Web 笔记库';
  /** 禁止仓库在冲突后自动采用磁盘新原文重放写入。 */
  readonly strictConflicts = true;
  /** 当前操作已确认的服务器版本。 */
  revision: string;
  /** 初次读取的完整目录快照。 */
  readonly snapshot: VaultScan;
  /** 本次调用复用项目已有的文件仓库。 */
  readonly repository: VaultRepository;
  /** 当前内存状态，仅在所有命令校验通过后提交。 */
  state: WorkspaceState = { pages: {}, docs: {} };
  /** 不可读取的页面不能经由语义工具覆盖。 */
  private unreadable = new Set<string>();

  /** 由工厂保证快照和版本来自同一 API 响应。 */
  private constructor(
    private readonly baseUrl: string,
    snapshot: VaultScan,
    revision: string,
  ) {
    this.snapshot = snapshot;
    this.revision = revision;
    this.repository = new VaultRepository(this, randomUUID);
  }

  /** 加载当前状态；修改工具必须传入先前读取到的版本。 */
  static async open(baseUrl: string, expected?: string): Promise<WebVault> {
    /** 快照与响应头在服务器同一串行读取中产生。 */
    const response = await fetch(`${baseUrl}/api/vault/scan`, { signal: AbortSignal.timeout(30_000) });
    /** 当前版本用于拒绝陈旧调用。 */
    const revision = response.headers.get('x-morrow-revision');
    if (!response.ok || !revision) throw vaultError(response.status, '无法读取共享笔记库。');
    if (expected !== undefined && expected !== revision)
      throw vaultError(409, '笔记库已更新，请重新读取后合并。', revision);
    /** 加载不会写入注册表；持久化只发生在显式修改时。 */
    const vault = new WebVault(baseUrl, (await response.json()) as VaultScan, revision);
    /** 读取器与 Web 使用同一格式解析、附件解析和数据库行映射。 */
    const loaded = await vault.repository.load();
    if (!loaded.ok) throw vaultError(400, loaded.error, revision);
    vault.state = {
      pages: Object.fromEntries(loaded.value.pages.map((page) => [page.id, page])),
      docs: loaded.value.docs,
    };
    vault.unreadable = new Set(loaded.value.unreadable);
    return vault;
  }

  /** 所有后续读取必须仍处于当前快照版本，避免混合不同设备的内容。 */
  async request(route: string, init?: RequestInit): Promise<Response> {
    /** 请求目标固定为本机共享 API。 */
    const response = await fetch(`${this.baseUrl}/api/vault/${route}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    /** 即使写入失败也保留服务端返回的新版本，便于重新读取。 */
    const revision = response.headers.get('x-morrow-revision');
    if (!init?.method && revision !== this.revision)
      throw vaultError(409, '读取期间笔记库已更新，请重新读取。', revision ?? undefined);
    if (init?.method && revision) this.revision = revision;
    if (!response.ok) {
      /** 错误响应只包含服务端公开的中文说明。 */
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw vaultError(response.status, body.error ?? '共享 API 请求失败。', revision ?? undefined);
    }
    return response;
  }

  /** 复用初次扫描，避免重复加载时切换到另一个版本。 */
  async scan(): Promise<VaultScan> {
    return this.snapshot;
  }
  /** 同一批次进入服务器串行队列，保留原文比较和库版本校验。 */
  async apply(ops: VaultOp[]): Promise<VaultOpResult[]> {
    /** 序列化前保留调用基准，后续响应会推进当前版本。 */
    const response = await this.request('apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Morrow-Revision': this.revision },
      body: JSON.stringify(ops),
    });
    return response.json() as Promise<VaultOpResult[]>;
  }
  /** 页面和历史都通过受保护的 API 读取。 */
  async readText(path: string): Promise<string | null> {
    return (await this.request(`text?path=${encodeURIComponent(path)}`)).json() as Promise<string | null>;
  }
  /** 附件字节仅通过共享 API 读取，不访问服务器本机任意路径。 */
  async readBytes(path: string): Promise<ArrayBuffer | null> {
    return (await this.request(`bytes?path=${encodeURIComponent(path)}`)).arrayBuffer();
  }
  /** 附件创建永不覆盖，原有文件使用项目自带的重名分配逻辑。 */
  async createFile(path: string, data: ArrayBuffer): Promise<void> {
    await this.request(`file?path=${encodeURIComponent(path)}`, {
      method: 'POST',
      headers: { 'X-Morrow-Revision': this.revision },
      body: data,
    });
  }
  /** 重名检查仍需验证目录状态没有被其他设备改变。 */
  async exists(path: string): Promise<boolean> {
    return (await this.request(`exists?path=${encodeURIComponent(path)}`)).json() as Promise<boolean>;
  }
  /** 列举附件元数据，不把整个文件内容塞入 MCP 列表。 */
  async listFiles(dir: string): Promise<VaultFileInfo[]> {
    return (await this.request(`list?path=${encodeURIComponent(dir)}`)).json() as Promise<VaultFileInfo[]>;
  }
  /** 工具调用不持有后台文件监听，结束后不保留跨请求状态。 */
  onChange(): () => void {
    return () => {};
  }
  /** 返回可供客户端在其 Morrow 地址下解析的相对 API 路径。 */
  fileUrl(path: string): string {
    return `/api/vault/bytes?path=${encodeURIComponent(path)}`;
  }

  /** 使用文件路径定位页面，也接受已有注册表中的稳定 ID。 */
  page(path: string, kind?: PageMeta['kind']): PageMeta {
    /** 路径是对外主要标识，不依赖新导入页面的临时 ID。 */
    const page = Object.values(this.state.pages).find(
      (page) => this.repository.pathOf(page.id) === path || page.id === path,
    );
    if (!page || isEffectivelyTrashed(this.state.pages, page.id))
      throw vaultError(404, '页面不存在或已在回收站。', this.revision);
    if (page.encrypted || this.unreadable.has(page.id))
      throw vaultError(400, '页面已加密或不可读，不能通过此工具修改。', this.revision);
    if (kind && page.kind !== kind) throw vaultError(400, `页面类型应为 ${kind}。`, this.revision);
    return page;
  }

  /** 新建正文按库根相对路径解析已有页面和附件，保留图片、附件和内部链接结构。 */
  markdown(text: string): DocNode {
    /** 布局由当前已加载仓库提供，避免第二次解析生成不同的临时页面ID。 */
    const layout = new Map(
      Object.values(this.state.pages).map((page) => {
        /** 文件路径与文件夹页面使用既有布局约定。 */
        const path = this.repository.pathOf(page.id)!;
        return [page.id, { file: isPageFile(path) ? path : null, folder: stripExtension(path) }] as const;
      }),
    );
    /** 当前页面原始 frontmatter 为解析别名提供信息。 */
    const sources = new Map(
      Object.values(this.state.pages).flatMap((page) => {
        /** 扫描与布局属于同一个版本。 */
        const file = this.snapshot.files.find((file) => file.path === this.repository.pathOf(page.id));
        return file && /\.md$/i.test(file.path) ? [[page.id, readPageText(file.text).source] as const] : [];
      }),
    );
    /** 附件按路径与文件名建立索引，与 Web 导入规则一致。 */
    const index = new Map(this.snapshot.others.map((path) => [path.toLowerCase(), path]));
    /** 同名附件遵循核心解析器的路径优先规则。 */
    const names = new Map<string, string[]>();
    for (const path of this.snapshot.others)
      names.set(basename(path).toLowerCase(), [...(names.get(basename(path).toLowerCase()) ?? []), path]);
    return markdownToDoc(
      text,
      parseOptions('', makeResolver(this.state, layout, sources), (href) =>
        resolveFile('', href, index, names),
      ),
    );
  }

  /** 数据删除需要能检查所有页面引用，未知或加密内容保留原文件。 */
  assertReferencesReadable(): void {
    if (this.unreadable.size || Object.values(this.state.pages).some((page) => page.encrypted))
      throw vaultError(400, '存在不可读或加密页面，无法确认附件引用，拒绝删除。', this.revision);
  }

  /** 原子校验命令集合，使用已有仓库一次保存正文、元数据、布局和历史。 */
  async execute(commands: Command[]): Promise<void> {
    /** 保存前的状态用于保留被替换正文的历史版本。 */
    const before = this.state;
    /** 所有命令先应用到草稿，任何错误都不会提交文件操作。 */
    let draft = before;
    /** 汇总仓库需要写入的页面、正文和删除标识。 */
    const changes = emptyChanges();
    for (const command of commands) {
      /** 复用 UI 核心校验，包括父子关系、文档结构和数据库结构。 */
      const applied = applyCommand(draft, command);
      if (!applied.ok) throw vaultError(400, applied.error, this.revision);
      draft = applied.value.state;
      for (const id of applied.value.changes.pages) changes.pages.add(id);
      for (const id of applied.value.changes.docs) changes.docs.add(id);
      for (const id of applied.value.changes.removed) changes.removed.add(id);
    }
    /** 原正文和新正文都保留版本，不覆盖已有的命名或保留历史。 */
    const snapshots: Snapshot[] = [];
    for (const id of changes.docs) {
      /** 仅为仍存在且可读取的页面记录正文历史。 */
      const page = draft.pages[id];
      if (!page || page.encrypted) continue;
      for (const state of [before, draft]) {
        /** 快照绑定当前页面稳定标识，复用同一历史文件。 */
        const doc: DocNode | undefined = state.docs[id];
        if (doc)
          snapshots.push({
            id: randomUUID(),
            pageId: id,
            title: state.pages[id]?.title ?? '',
            createdAt: state === before ? state.pages[id]!.updatedAt : Date.now(),
            doc,
          });
      }
    }
    await this.repository.write({
      pages: [...changes.pages].flatMap((id) => (draft.pages[id] ? [draft.pages[id]!] : [])),
      docs: [...changes.docs].flatMap((id) => (draft.docs[id] ? [{ id, doc: draft.docs[id]! }] : [])),
      removed: [...changes.removed],
      state: draft,
      snapshots,
    });
    this.state = draft;
  }

  /** 返回语义工具统一使用的页面元数据与物理相对路径。 */
  describe(page: PageMeta) {
    return { ...page, path: this.repository.pathOf(page.id) };
  }
  /** 释放仓库监听与内存状态。 */
  close(): void {
    this.repository.close();
  }
}

/** 保证工具无论成功或失败都释放独立仓库。 */
export async function withWebVault<T>(
  baseUrl: string,
  revision: string | undefined,
  action: (vault: WebVault) => Promise<T>,
): Promise<T> {
  /** 调用结束后不复用旧快照或注册表。 */
  const vault = await WebVault.open(baseUrl, revision);
  try {
    return await action(vault);
  } finally {
    vault.close();
  }
}
