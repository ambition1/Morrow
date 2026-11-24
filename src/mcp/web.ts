/**
 * 功能：通过共享 Web API 提供 MCP 笔记读写，复用服务器串行保存和并发冲突保护。
 * 作者：xuanli
 * 创建时间：2026-11-07 17:52:30
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { registerStructuredTools } from './webStructured';
import { registerMediaTools } from './webMedia';
import { entityPath } from './webSchemas';
import { readPageText } from '../core/vault/pageFile';

/** 只允许操作普通 Markdown 页面，内部注册表、历史和回收站由 Web 服务管理。 */
const pagePath = z
  .string()
  .min(1)
  .refine(
    (value) => /\.(md|markdown)$/i.test(value) && !value.split(/[\\/]/).some((part) => part.startsWith('.')),
    '只允许访问普通 Markdown 页面路径。',
  );

/** 将结果编码为标准 MCP 文本内容，客户端可解析其中的版本号。 */
function result(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

/** 为每个请求创建独立服务器，避免多个客户端共享协议状态。 */
function createServer(baseUrl: string): McpServer {
  /** API 地址仅由本机监听端口生成，不接受客户端指定的地址。 */
  const server = new McpServer({ name: 'morrow-web', version: '1.2.0' });
  /** 执行本机 Web API，保留 HTTP 状态和请求完成时的笔记库版本。 */
  async function api(route: string, init?: RequestInit) {
    /** 读取和写入均由原有 Web API 验证路径与版本。 */
    const response = await fetch(`${baseUrl}/api/vault/${route}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
    });
    /** 包含原始数据与版本，写入冲突不会自动重试。 */
    const value = {
      status: response.status,
      revision: response.headers.get('x-morrow-revision'),
      data: await response.json(),
    };
    return value;
  }
  server.registerTool(
    'list_pages',
    {
      description: '列出或搜索共享笔记库中的页面、数据库和画布路径与类型，返回当前 revision。',
      inputSchema: { query: z.string().optional(), limit: z.number().int().min(1).max(200).default(100) },
    },
    async ({ query, limit }) => {
      /** 扫描结果与版本在同一次服务器串行读取中取得。 */
      const scan = await api('scan');
      if (scan.status !== 200) return result(scan, true);
      /** 页面正文只用于搜索，列表不返回全部正文。 */
      const data = scan.data as { files: { path: string; text?: string; tooLarge?: boolean }[] };
      /** 返回路径和超限标记，避免大量正文占用 MCP 上下文。 */
      const files = data.files.filter(
        (file) =>
          (pagePath.safeParse(file.path).success ||
            (entityPath.safeParse(file.path).success && /\.canvas$/i.test(file.path))) &&
          (!query || `${file.path}\n${file.text ?? ''}`.toLowerCase().includes(query.toLowerCase())),
      );
      return result({
        revision: scan.revision,
        total: files.length,
        files: files.slice(0, limit).map((file) => ({
          path: file.path,
          kind: /\.canvas$/i.test(file.path) ? 'canvas' : (readPageText(file.text ?? '').kind ?? 'page'),
          tooLarge: file.tooLarge ?? false,
        })),
      });
    },
  );
  server.registerTool(
    'read_page',
    {
      description: '读取完整 Markdown 与同一读取时刻的 revision；不存在时内容为 null，可据此创建。',
      inputSchema: { path: pagePath },
    },
    async ({ path }) => {
      /** 文件原文和版本来自同一次读取，供后续乐观锁检查。 */
      const value = await api(`text?path=${encodeURIComponent(path)}`);
      return result(value, value.status !== 200);
    },
  );
  server.registerTool(
    'write_page',
    {
      description:
        '创建或更新 Markdown。先 read_page，传回其 revision 和原文 expected；创建时 expected=null。冲突后必须重新读取并人工合并，不能盲目重试。',
      inputSchema: {
        path: pagePath,
        text: z.string(),
        revision: z.string().min(1),
        expected: z.string().nullable(),
      },
    },
    async ({ path, text, revision, expected }) => {
      /** 全部写入进入 Web 服务共享队列，同时检查库版本和文件原文。 */
      const value = await api('apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Morrow-Revision': revision },
        body: JSON.stringify([{ op: 'write', path, text, expect: expected }]),
      });
      return result(
        value,
        value.status !== 200 || (value.data as { ok: boolean }[]).some((item) => !item.ok),
      );
    },
  );
  server.registerTool(
    'remove_page',
    {
      description:
        '移除页面文件并由服务器保留到内部 deleted 目录（不出现在界面回收站中）；必须传入 read_page 返回的 revision，冲突后先重新读取。',
      inputSchema: { path: pagePath, revision: z.string().min(1) },
    },
    async ({ path, revision }) => {
      /** 使用服务器可恢复的移除操作，不直接删除宿主机文件。 */
      const value = await api('apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Morrow-Revision': revision },
        body: JSON.stringify([{ op: 'remove', path }]),
      });
      return result(
        value,
        value.status !== 200 || (value.data as { ok: boolean }[]).some((item) => !item.ok),
      );
    },
  );
  registerStructuredTools(server, baseUrl);
  registerMediaTools(server, baseUrl);
  return server;
}

/** 在现有 HTTP 监听端口处理 MCP，不增加容器监听端口或直接访问笔记目录。 */
export async function handleMcp(request: IncomingMessage, response: ServerResponse): Promise<void> {
  /** 无状态 HTTP 只处理 POST，避免建立永不关闭的 SSE 会话。 */
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST' }).end();
    return;
  }
  /** 后端地址固定在本机，不使用请求 Host 或用户配置作为代理目标。 */
  const server = createServer(`http://127.0.0.1:${request.socket.localPort}`);
  /** JSON 响应兼容标准 Streamable HTTP 客户端，工具不保留跨请求状态。 */
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    // 与 Web API 的请求上限一致，容纳新旧两份正文及 JSON 转义。
    maxRequestBodySize: 105 * 1024 * 1024,
  });
  /** 请求结束后释放传输和协议服务器，包括客户端中途断开的情况。 */
  response.on('close', () => {
    void server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}
