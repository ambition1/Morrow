/**
 * 功能：通过认证 HTTP 会话连接服务器上当前账号的独立笔记库。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:56
 */
import type { VaultBridge } from '../../storage/vaultBridge';
import { t } from '../i18n';
import { toast } from '../ui';

/** 请求认证接口；Cookie 由浏览器保管，不把凭证保存到本地存储。 */
export async function webRequest(path: string, init?: RequestInit): Promise<Response> {
  /** 相同来源的 Cookie 随请求自动发送。 */
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    /** 将服务端中文错误或通用错误交给调用方显示。 */
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(new Error(error.error ?? t('web.requestFailed')), {
      status: response.status,
      revision: response.headers.get('X-Morrow-Revision'),
    });
  }
  return response;
}

/** 创建使用版本检查保护的服务器文件桥接。 */
export function webVaultBridge(username: string): VaultBridge {
  /** 当前客户端已知的服务端版本；只有加载和本客户端写入会推进。 */
  let revision = '0';
  /** 同一个浏览器的请求串行执行，避免自身触发版本冲突。 */
  let pending: Promise<unknown> = Promise.resolve();
  /** 避免重复提示其他设备已修改。 */
  let notified = false;

  /** 文件操作及版本更新在一个队列任务内完成。 */
  function request<T>(route: string, init?: RequestInit): Promise<T> {
    /** 当前排队的请求，失败不会阻塞之后的重试。 */
    const task = pending
      .catch(() => {})
      .then(async () => {
        /** 请求附带加载时的版本，服务端拒绝陈旧客户端覆盖数据。 */
        const response = await webRequest(`/api/vault/${route}`, {
          ...init,
          headers: { ...init?.headers, 'X-Morrow-Revision': revision, 'X-Morrow-User': username },
        });
        if (route === 'scan' || init?.method === 'POST')
          revision = response.headers.get('X-Morrow-Revision') ?? revision;
        return response.json() as Promise<T>;
      });
    // 已通过版本检查但写入失败时，接收本次请求的新版本，允许安全重试。
    const tracked = task.catch((error: unknown) => {
      const detail = error as { status?: number; revision?: string };
      if (init?.method === 'POST' && detail.status !== 409 && detail.revision) revision = detail.revision;
      throw error;
    });
    pending = tracked;
    return tracked;
  }

  /** 文件路径以查询参数编码，不允许构造额外路由。 */
  function query(route: string, path: string): string {
    return `${route}?path=${encodeURIComponent(path)}`;
  }

  return {
    root: `${t('web.storageName')} / ${username}`,
    scan: () => request('scan'),
    apply: (ops) =>
      request('apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ops),
      }),
    readText: (path) => request(query('text', path)),
    readBytes: async (path) => {
      /** 二进制附件通过认证端点读取，不直接暴露存储目录。 */
      const response = await fetch(`/api/vault/${query('bytes', path)}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-Morrow-User': username },
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(t('web.requestFailed'));
      return response.arrayBuffer();
    },
    createFile: async (path, data) => {
      await request(query('file', path), { method: 'POST', body: data });
    },
    exists: (path) => request(query('exists', path)),
    listFiles: (dir) => request(query('list', dir)),
    // 多设备更新提示刷新；不在编辑期间替换用户正在输入的内容。
    onChange: () => {
      /** 定期检测服务端版本变化，失败时不丢弃本地待保存内容。 */
      const timer = window.setInterval(() => {
        if (document.visibilityState === 'hidden' || notified) return;
        void pending
          .catch(() => {})
          .then(async () => {
            /** 版本探测不改变当前工作区的基准版本。 */
            const response = await webRequest('/api/vault/revision', {
              headers: { 'X-Morrow-User': username },
            });
            /** 新版本只能通过刷新并重新加载完整工作区接收。 */
            const value = (await response.json()) as { revision: string };
            if (String(value.revision) !== revision && !notified) {
              notified = true;
              toast(t('web.changed'), { durationMs: 60_000 });
            }
          })
          .catch(() => {});
      }, 5000);
      return () => window.clearInterval(timer);
    },
    // 附件必须先认证读取为 Blob URL，避免直接执行上传内容。
    fileUrl: () => null,
  };
}
