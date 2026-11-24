/**
 * 功能：验证真实 MCP HTTP 调用复用 Web API 的落盘、冲突保护与同源边界。
 * 作者：xuanli
 * 创建时间：2026-11-07 17:53:24
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleMcp } from './web';

/** 每项测试使用独立服务器和宿主目录，不访问部署中的笔记库。 */
let server: Server;
/** 当前测试的临时目录。 */
let root: string;
/** 当前测试的 HTTP 地址。 */
let base: string;
/** 已连接的独立 MCP 客户端。 */
let client: Client;

/** 用真实 Web 服务和 MCP 客户端初始化协议。 */
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'morrow-web-mcp-'));
  await mkdir(path.join(root, 'dist'));
  await writeFile(path.join(root, 'dist/index.html'), '<h1>Morrow</h1>');
  /** 原生 Node 服务没有 TypeScript 声明，动态加载测试实际运行代码。 */
  const appModule = '../../server/app.mjs';
  /** 测试通过注入处理器使用与部署相同的请求入口。 */
  const { createApp } = await import(appModule);
  server = await createApp({
    dataDir: path.join(root, 'data'),
    distDir: path.join(root, 'dist'),
    mcpHandler: handleMcp,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  /** 内核分配的端口避免与其他测试和用户服务冲突。 */
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器地址不可用。');
  base = `http://127.0.0.1:${address.port}`;
  client = new Client({ name: 'morrow-mcp-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

/** 无论断言成功与否均释放连接和临时文件。 */
afterEach(async () => {
  await client?.close();
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await rm(root, { recursive: true, force: true });
});

/** 工具结果统一解析，测试保留状态、原文和 revision 的完整契约。 */
async function tool(name: string, args: Record<string, unknown>) {
  /** 协议层响应同时保留 isError，不能仅凭 HTTP 200 判断工具成功。 */
  const response = await client.callTool({ name, arguments: args });
  /** MCP SDK 的通用结果可能包含其他类型，此处只接受文本。 */
  const content = response.content as { type: string; text?: string }[];
  /** SDK 的参数校验错误使用普通文本，业务错误仍返回结构化 JSON。 */
  const text = content[0]?.text ?? '{}';
  return {
    error: response.isError === true,
    value: text.startsWith('{') ? JSON.parse(text) : { message: text },
  };
}

/** 两个 MCP 客户端与 Web 编辑共享同一版本序列，不能覆盖已改变的正文。 */
it('创建、读取、更新和移除均进入 Web API，拒绝旧版本和错误原文', async () => {
  expect((await client.listTools()).tools.map((entry) => entry.name)).toEqual(
    expect.arrayContaining([
      'list_pages',
      'read_page',
      'write_page',
      'remove_page',
      'create_database',
      'read_database',
      'update_database',
      'create_database_row',
      'update_database_row',
      'trash_database_row',
      'trash_database',
      'trash_canvas',
      'create_canvas',
      'read_canvas',
      'update_canvas',
      'upload_attachment',
      'list_attachments',
      'read_attachment',
      'delete_attachment',
      'list_page_media',
      'insert_attachment',
      'update_image',
      'remove_page_media',
      'set_page_cover',
    ]),
  );
  /** 初次读取不存在的页面同时取得合法写入版本。 */
  const empty = await tool('read_page', { path: '共享.md' });
  expect(empty.value.data).toBeNull();
  /** 创建后正文必须落在真实数据目录。 */
  const created = await tool('write_page', {
    path: '共享.md',
    text: '初始正文',
    revision: empty.value.revision,
    expected: null,
  });
  expect(created.error).toBe(false);
  expect(await readFile(path.join(root, 'data/vaults/local/共享.md'), 'utf8')).toBe('初始正文');
  expect((await tool('list_pages', { query: '初始' })).value.files).toEqual([
    { path: '共享.md', kind: 'page', tooLarge: false },
  ]);
  /** 模拟 Web 客户端读取后完成一次更新。 */
  const read = await tool('read_page', { path: '共享.md' });
  const browserWrite = await fetch(`${base}/api/vault/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Morrow-Revision': read.value.revision },
    body: JSON.stringify([{ op: 'write', path: '共享.md', text: 'Web 新正文', expect: '初始正文' }]),
  });
  expect(browserWrite.status).toBe(200);
  /** MCP 不能使用 Web 更新前的旧版本写入。 */
  const stale = await tool('write_page', {
    path: '共享.md',
    text: '覆盖正文',
    revision: read.value.revision,
    expected: '初始正文',
  });
  expect(stale.error).toBe(true);
  expect(stale.value.status).toBe(409);
  /** 即使版本正确，原文不匹配也必须报告工具错误。 */
  const latest = await tool('read_page', { path: '共享.md' });
  expect(
    (
      await tool('write_page', {
        path: '共享.md',
        text: '错误覆盖',
        revision: latest.value.revision,
        expected: '初始正文',
      })
    ).error,
  ).toBe(true);
  /** 重新读取后才能提交新内容。 */
  const current = await tool('read_page', { path: '共享.md' });
  const updated = await tool('write_page', {
    path: '共享.md',
    text: 'MCP 新正文',
    revision: current.value.revision,
    expected: current.value.data,
  });
  expect(updated.error).toBe(false);
  expect((await tool('read_page', { path: '共享.md' })).value.data).toBe('MCP 新正文');
  expect((await tool('remove_page', { path: '共享.md', revision: updated.value.revision })).error).toBe(
    false,
  );
  expect((await tool('read_page', { path: '共享.md' })).value.data).toBeNull();
});

/** MCP 不提供内部元数据写入入口，也不允许跨站页面调用。 */
it('拒绝内部路径、越界路径和跨站调用，不开放旧 SSE 入口', async () => {
  expect((await tool('read_page', { path: '.morrow/workspace.md' })).error).toBe(true);
  expect((await tool('read_page', { path: '../outside.md' })).error).toBe(true);
  expect(
    (await fetch(`${base}/mcp`, { method: 'POST', headers: { Origin: 'https://evil.example' }, body: '{}' }))
      .status,
  ).toBe(403);
  expect((await fetch(`${base}/mcp`)).status).toBe(405);
});

/** 写入协议同时包含新旧正文，不能被 SDK 默认的 4 MiB 请求上限误拒绝。 */
it('允许更新合法的大页面，并保持 Web 的单页大小限制', async () => {
  /** 两份正文的 JSON 总长度超过 4 MiB，但每份都低于 Web 单页上限。 */
  const text = 'a'.repeat(2_200_000);
  /** 新文件读取提供初次创建需要的版本。 */
  const initial = await tool('read_page', { path: '大页面.md' });
  /** 首次写入的返回版本可作为下一次编辑的基准。 */
  const created = await tool('write_page', {
    path: '大页面.md',
    text,
    expected: null,
    revision: initial.value.revision,
  });
  expect(created.error).toBe(false);
  /** 必须携带完整原文进行原子比较。 */
  const updated = await tool('write_page', {
    path: '大页面.md',
    text: text + '更新',
    expected: text,
    revision: created.value.revision,
  });
  expect(updated.error).toBe(false);
  expect((await tool('read_page', { path: '大页面.md' })).value.data).toBe(text + '更新');
  expect(
    (
      await tool('write_page', {
        path: '超限.md',
        text: 'a'.repeat(4_000_001),
        expected: null,
        revision: updated.value.revision,
      })
    ).error,
  ).toBe(true);
});

/** 合法的一像素 PNG，仅用于协议与附件落盘验收。 */
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQaPj/HwAFAgKfdqhGyQAAAABJRU5ErkJggg==';

/** 数据库字段与选项保持稳定ID，更新行元数据不能破坏正文附件和自定义 YAML。 */
it('数据库结构、行属性、视图和回收站与 UI 存储格式一致', async () => {
  /** 空库读取为创建提供版本。 */
  const initial = await tool('read_page', { path: '尚不存在.md' });
  /** 保留字段标识用于验证字段改名。 */
  const definition = {
    properties: [
      {
        id: 'status',
        name: '状态',
        type: 'select',
        options: [
          { id: 'todo', name: '待办', color: 'teal' },
          { id: 'done', name: '完成', color: '#1b946f' },
        ],
      },
      { id: 'count', name: '次数', type: 'number' },
      { id: 'checked', name: '确认', type: 'checkbox' },
      { id: 'due', name: '日期', type: 'date' },
      { id: 'formula', name: '公式', type: 'formula', formula: '1' },
    ],
    views: [
      {
        id: 'table',
        name: '表格',
        type: 'table',
        showBody: true,
        columnOrder: ['$body'],
        widths: { $body: 180 },
      },
      { id: 'board', name: '看板', type: 'board', groupBy: 'status' },
      { id: 'calendar', name: '日历', type: 'calendar', dateProp: 'due' },
    ],
  };
  /** 创建数据库页面，并使用返回的实际路径访问。 */
  const created = await tool('create_database', {
    title: '项目任务',
    definition,
    revision: initial.value.revision,
  });
  expect(created.error).toBe(false);
  expect(created.value.page.kind).toBe('database');
  expect(created.value.page.path).toBe('项目任务.md');
  /** 行值可以使用用户可读的字段与选项名称。 */
  const row = await tool('create_database_row', {
    database_path: created.value.page.path,
    title: '第一项',
    values: { 状态: '待办', 次数: 2, 确认: true, 日期: '2026-11-07' },
    markdown: '保留这段正文。',
    revision: created.value.revision,
  });
  expect(row.error).toBe(false);
  expect(row.value.page.path).toBe('项目任务/第一项.md');
  /** 自定义 YAML 与图片元数据都必须在行属性修改后保留。 */
  const raw = await tool('read_page', { path: row.value.page.path });
  const extra = await tool('write_page', {
    path: row.value.page.path,
    text: raw.value.data.replace('---\n', '---\n自定义: 保留\n# 保留注释\n'),
    expected: raw.value.data,
    revision: raw.value.revision,
  });
  expect(extra.error).toBe(false);
  /** 附件通过单独上传步骤创建，不覆盖其他文件。 */
  const upload = await tool('upload_attachment', {
    name: '测试图片.png',
    data_base64: png,
    revision: extra.value.revision,
  });
  expect(upload.error).toBe(false);
  const inserted = await tool('insert_attachment', {
    page_path: row.value.page.path,
    attachment_path: upload.value.attachment_path,
    caption: '原始图注',
    width: 32,
    align: 'right',
    revision: upload.value.revision,
  });
  expect(inserted.error).toBe(false);
  /** 只改属性，不重新解析或覆盖行正文。 */
  const updated = await tool('update_database_row', {
    path: row.value.page.path,
    values: { 次数: 3, 状态: '完成' },
    revision: inserted.value.revision,
  });
  expect(updated.error).toBe(false);
  const read = await tool('read_database', { path: created.value.page.path });
  expect(read.value.page.database.views[0]).toMatchObject(definition.views[0]!);
  expect(
    read.value.page.database.properties[0].options.map((option: { color: string }) => option.color),
  ).toEqual(['teal', '#1B946F']);
  expect(read.value.rows[0].properties).toMatchObject({
    count: 3,
    status: 'done',
    checked: true,
    due: '2026-11-07',
  });
  const media = await tool('list_page_media', { page_path: row.value.page.path });
  expect(media.value.media[0].attrs).toMatchObject({
    fileId: upload.value.attachment_path,
    caption: '原始图注',
    width: 32,
    align: 'right',
  });
  /** 字段改名沿用原ID，因此原行值与未知 YAML 不会丢失。 */
  const changed = structuredClone(read.value.page.database);
  changed.properties.find((prop: { id: string }) => prop.id === 'count').name = '数量';
  const schemaUpdate = await tool('update_database', {
    path: created.value.page.path,
    definition: changed,
    revision: read.value.revision,
  });
  expect(schemaUpdate.error).toBe(false);
  const after = await tool('read_page', { path: row.value.page.path });
  expect(after.value.data).toContain('数量: 3');
  expect(after.value.data).toContain('自定义: 保留');
  expect(after.value.data).toContain('# 保留注释');
  expect(after.value.data).toContain('保留这段正文。');
  /** 行删除进入界面回收站，而不是直接永久删除。 */
  const trashed = await tool('trash_database_row', {
    path: row.value.page.path,
    revision: after.value.revision,
  });
  expect(trashed.error).toBe(false);
  expect(trashed.value.page.trashedAt).toBeTypeOf('number');
  expect((await tool('read_database', { path: created.value.page.path })).value.rows).toHaveLength(0);
  const trashDatabase = await tool('trash_database', {
    path: created.value.page.path,
    revision: trashed.value.revision,
  });
  expect(trashDatabase.error).toBe(false);
  expect(trashDatabase.value.page.trashedAt).toBeTypeOf('number');
  expect((await tool('read_database', { path: created.value.page.path })).error).toBe(true);
});

/** 画布复用 JSON Canvas 文件格式，并严格拒绝丢失的连线端点与旧版本。 */
it('画布节点、连线和文件引用可创建回读更新，非法结构不写入', async () => {
  /** 先准备一个真实图片文件供画布引用。 */
  const initial = await tool('read_page', { path: '不存在.md' });
  const upload = await tool('upload_attachment', {
    name: '画布图片.png',
    data_base64: png,
    revision: initial.value.revision,
  });
  /** 节点与连线均使用通用 JSON Canvas 形状。 */
  const canvas = {
    nodes: [
      { id: 'text', type: 'text', x: 0, y: 0, width: 250, height: 80, text: '画布文字' },
      {
        id: 'image',
        type: 'file',
        x: 350,
        y: 0,
        width: 200,
        height: 200,
        file: upload.value.attachment_path,
      },
      { id: 'link', type: 'link', x: 0, y: 250, width: 200, height: 80, url: 'https://example.com' },
    ],
    edges: [{ id: 'edge', fromNode: 'text', toNode: 'image', toEnd: 'arrow', label: '图片' }],
  };
  const created = await tool('create_canvas', { title: '测试画布', canvas, revision: upload.value.revision });
  expect(created.error).toBe(false);
  expect(created.value.page.path).toBe('测试画布.canvas');
  const read = await tool('read_canvas', { path: created.value.page.path });
  expect(read.value.canvas).toEqual(canvas);
  /** 被画布引用的图片不能被附件删除工具移除。 */
  const blocked = await tool('delete_attachment', {
    path: upload.value.attachment_path,
    revision: read.value.revision,
  });
  expect(blocked.error).toBe(true);
  expect(blocked.value.status).toBe(409);
  /** 非法引用与重复标识在写入前拒绝。 */
  const invalid = await tool('update_canvas', {
    path: created.value.page.path,
    canvas: { ...canvas, edges: [{ id: 'bad', fromNode: 'missing', toNode: 'image' }] },
    revision: read.value.revision,
  });
  expect(invalid.error).toBe(true);
  expect((await tool('read_canvas', { path: created.value.page.path })).value.revision).toBe(
    read.value.revision,
  );
  /** 移除节点和连线后画布可正常保存。 */
  const updatedCanvas = { nodes: [{ ...canvas.nodes[0], x: 100, text: '移动后的文字' }], edges: [] };
  const updated = await tool('update_canvas', {
    path: created.value.page.path,
    canvas: updatedCanvas,
    revision: read.value.revision,
  });
  expect(updated.error).toBe(false);
  expect((await tool('read_canvas', { path: created.value.page.path })).value.canvas).toEqual(updatedCanvas);
  expect(
    (await tool('update_canvas', { path: created.value.page.path, canvas, revision: read.value.revision }))
      .value.status,
  ).toBe(409);
  const removed = await tool('delete_attachment', {
    path: upload.value.attachment_path,
    revision: updated.value.revision,
  });
  expect(removed.error).toBe(true);
  expect(removed.value.error).toContain('历史');
  const trashCanvas = await tool('trash_canvas', {
    path: created.value.page.path,
    revision: removed.value.revision,
  });
  expect(trashCanvas.error).toBe(false);
  expect(trashCanvas.value.page.path).toContain('.trash/');
  expect((await tool('read_canvas', { path: created.value.page.path })).error).toBe(true);
});

/** 图片与附件支持上传、原生图片读取、插入/替换/属性/移除和封面引用保护。 */
it('附件重名另存，图片属性与其他正文保留，引用保护后才允许删除文件', async () => {
  /** 创建普通正文，后续媒体操作不能损坏原有内容。 */
  const initial = await tool('read_page', { path: '正文.md' });
  const page = await tool('write_page', {
    path: '正文.md',
    text: '# 原有标题\n\n原有正文。',
    expected: null,
    revision: initial.value.revision,
  });
  const first = await tool('upload_attachment', {
    name: '图片.png',
    data_base64: png,
    revision: page.value.revision,
  });
  const second = await tool('upload_attachment', {
    name: '图片.png',
    data_base64: png,
    revision: first.value.revision,
  });
  expect(first.value.attachment_path).toBe('attachments/图片.png');
  expect(second.value.attachment_path).toBe('attachments/图片 2.png');
  expect(await readFile(path.join(root, 'data/vaults/local', first.value.attachment_path))).toEqual(
    Buffer.from(png, 'base64'),
  );
  /** 图片读取返回标准 MCP image 块而非要求调用方手工解码文本。 */
  const native = await client.callTool({
    name: 'read_attachment',
    arguments: { path: first.value.attachment_path, include_data: true },
  });
  expect(native.isError).toBe(false);
  expect(native.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ type: 'image', data: png, mimeType: 'image/png' })]),
  );
  const inserted = await tool('insert_attachment', {
    page_path: '正文.md',
    attachment_path: first.value.attachment_path,
    alt: '替代文字',
    caption: '图注',
    width: 30,
    align: 'left',
    revision: second.value.revision,
  });
  expect(inserted.error).toBe(false);
  const changed = await tool('update_image', {
    page_path: '正文.md',
    media_index: 0,
    attachment_path: second.value.attachment_path,
    caption: '新图注',
    width: 42,
    align: 'right',
    revision: inserted.value.revision,
  });
  expect(changed.error).toBe(false);
  const media = await tool('list_page_media', { page_path: '正文.md' });
  expect(media.value.media[0].attrs).toMatchObject({
    fileId: second.value.attachment_path,
    alt: '替代文字',
    caption: '新图注',
    width: 42,
    align: 'right',
  });
  expect((await tool('read_page', { path: '正文.md' })).value.data).toContain('原有正文。');
  expect(
    (await tool('delete_attachment', { path: second.value.attachment_path, revision: media.value.revision }))
      .error,
  ).toBe(true);
  const cover = await tool('set_page_cover', {
    page_path: '正文.md',
    cover: second.value.attachment_path,
    revision: media.value.revision,
  });
  expect(cover.error).toBe(false);
  const removed = await tool('remove_page_media', {
    page_path: '正文.md',
    media_index: 0,
    revision: cover.value.revision,
  });
  expect(removed.error).toBe(false);
  expect(
    (
      await tool('delete_attachment', {
        path: second.value.attachment_path,
        revision: removed.value.revision,
      })
    ).error,
  ).toBe(true);
  const cleared = await tool('set_page_cover', {
    page_path: '正文.md',
    cover: null,
    revision: removed.value.revision,
  });
  const deleted = await tool('delete_attachment', {
    path: second.value.attachment_path,
    revision: cleared.value.revision,
  });
  expect(deleted.error).toBe(true);
  expect(deleted.value.error).toContain('历史');
  /** 普通附件同样可插入、按字节回读和列举。 */
  const document = await tool('upload_attachment', {
    name: '说明.txt',
    data_base64: Buffer.from('附件内容').toString('base64'),
    revision: deleted.value.revision,
  });
  const attachment = await tool('insert_attachment', {
    page_path: '正文.md',
    attachment_path: document.value.attachment_path,
    revision: document.value.revision,
  });
  expect(attachment.error).toBe(false);
  expect((await tool('list_page_media', { page_path: '正文.md' })).value.media[0].type).toBe(
    'fileAttachment',
  );
  expect(
    (await tool('read_attachment', { path: document.value.attachment_path, include_data: true })).value
      .data_base64,
  ).toBe(Buffer.from('附件内容').toString('base64'));
  expect((await tool('list_attachments', { query: '说明' })).value.total).toBe(1);
  const unused = await tool('upload_attachment', {
    name: '未引用.txt',
    data_base64: 'YQ==',
    revision: attachment.value.revision,
  });
  expect(
    (await tool('delete_attachment', { path: unused.value.attachment_path, revision: unused.value.revision }))
      .error,
  ).toBe(false);
});

/** 输入校验和版本保护覆盖新增工具，失败时不能生成意外文件或推进版本。 */
it('拒绝非法附件、字段、画布文件引用和陈旧的结构化修改', async () => {
  const initial = await tool('read_page', { path: '不存在.md' });
  expect(
    (
      await tool('upload_attachment', {
        name: '../逃逸.txt',
        data_base64: 'YQ==',
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await tool('upload_attachment', {
        name: '错误.png',
        data_base64: 'YQ==',
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await tool('upload_attachment', {
        name: '错误.txt',
        data_base64: 'YQ==invalid',
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await tool('create_database', {
        title: '错误库',
        definition: { properties: [{ name: 'title', type: 'text' }] },
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await tool('create_database', {
        title: '错误库',
        definition: { properties: [{ id: '__proto__', name: '错误', type: 'text' }] },
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect(
    (
      await tool('create_canvas', {
        title: '错误画布',
        canvas: {
          nodes: [
            {
              id: 'file',
              type: 'file',
              x: 0,
              y: 0,
              width: 100,
              height: 100,
              file: 'attachments/missing.png',
            },
          ],
          edges: [],
        },
        revision: initial.value.revision,
      })
    ).error,
  ).toBe(true);
  expect((await tool('read_page', { path: '不存在.md' })).value.revision).toBe(initial.value.revision);
  const upload = await tool('upload_attachment', {
    name: '正常.txt',
    data_base64: 'YQ==',
    revision: initial.value.revision,
  });
  expect(upload.error).toBe(false);
  expect(
    (
      await tool('create_database', {
        title: '过期库',
        definition: { properties: [] },
        revision: initial.value.revision,
      })
    ).value.status,
  ).toBe(409);
  expect((await tool('read_page', { path: '过期库.md' })).value.data).toBeNull();
});

/** 普通内联下载链接也属于引用，包含编码、父目录和 API 下载地址。 */
it('附件引用保护覆盖相对内联链接和下载 API，且数据库字段保留伪属性标识', async () => {
  const initial = await tool('read_page', { path: '链接.md' });
  const upload = await tool('upload_attachment', {
    name: '说明 文档.pdf',
    data_base64: Buffer.from('%PDF-1.4\nfixture').toString('base64'),
    revision: initial.value.revision,
  });
  /** 嵌套页面的内联链接使用父目录，并包含 URL 编码与锚点。 */
  const page = await tool('write_page', {
    path: '目录/链接.md',
    text: '下载 [说明](../attachments/%E8%AF%B4%E6%98%8E%20%E6%96%87%E6%A1%A3.pdf#page=1) 后继续阅读。',
    expected: null,
    revision: upload.value.revision,
  });
  expect(
    (await tool('delete_attachment', { path: upload.value.attachment_path, revision: page.value.revision }))
      .error,
  ).toBe(true);
  /** 下载接口链接也不能被误判为未引用。 */
  const read = await tool('read_page', { path: '目录/链接.md' });
  const changed = await tool('write_page', {
    path: '目录/链接.md',
    text: `查看 [说明](/api/vault/bytes?path=${encodeURIComponent(upload.value.attachment_path)})。`,
    expected: read.value.data,
    revision: read.value.revision,
  });
  expect(
    (
      await tool('delete_attachment', {
        path: upload.value.attachment_path,
        revision: changed.value.revision,
      })
    ).error,
  ).toBe(true);
  for (const id of ['title', 'created', 'updated'])
    expect(
      (
        await tool('create_database', {
          title: '错误字段',
          definition: { properties: [{ id, name: '数量', type: 'number' }] },
          revision: changed.value.revision,
        })
      ).error,
    ).toBe(true);
  expect(
    (
      await tool('upload_attachment', {
        name: '不作为附件.md',
        data_base64: 'YQ==',
        revision: changed.value.revision,
      })
    ).error,
  ).toBe(true);
  expect((await tool('read_page', { path: '目录/链接.md' })).value.revision).toBe(changed.value.revision);
});

/** 新行正文使用同一附件解析器，同名字段省略ID时仍保留已有行值。 */
it('数据库更新保留省略的同名ID，新行 Markdown 可包含已有图片', async () => {
  const initial = await tool('read_page', { path: '尚不存在.md' });
  const upload = await tool('upload_attachment', {
    name: '已有图片.png',
    data_base64: png,
    revision: initial.value.revision,
  });
  const definition = {
    properties: [{ name: '状态', type: 'select', options: [{ name: '待办', color: 'blue' }] }],
  };
  const database = await tool('create_database', {
    title: '新行测试',
    definition,
    revision: upload.value.revision,
  });
  const row = await tool('create_database_row', {
    database_path: database.value.page.path,
    title: '带图记录',
    values: { 状态: '待办' },
    markdown: `正文\n\n![原图片](${upload.value.attachment_path})`,
    revision: database.value.revision,
  });
  expect(row.error).toBe(false);
  const media = await tool('list_page_media', { page_path: row.value.page.path });
  expect(media.value.media[0].attrs.fileId).toBe(upload.value.attachment_path);
  const updated = await tool('update_database', {
    path: database.value.page.path,
    definition,
    revision: media.value.revision,
  });
  expect(updated.error).toBe(false);
  const read = await tool('read_database', { path: database.value.page.path });
  expect(read.value.page.database.properties[0].id).toBe(database.value.page.database.properties[0].id);
  expect(read.value.page.database.properties[0].options[0].id).toBe(
    database.value.page.database.properties[0].options[0].id,
  );
  expect(read.value.rows[0].properties).toEqual(row.value.page.properties);
  expect(
    (await tool('read_database', { path: database.value.page.path, offset: 1, limit: 1 })).value.rows,
  ).toHaveLength(0);
});

/** 行标题改名时，已链接它的画布也应按仓库既有规则更新路径。 */
it('行改名保持画布页面引用，并保留既有历史快照', async () => {
  const initial = await tool('read_page', { path: '不存在.md' });
  const database = await tool('create_database', {
    title: '引用数据库',
    definition: { properties: [] },
    revision: initial.value.revision,
  });
  const row = await tool('create_database_row', {
    database_path: database.value.page.path,
    title: '原名',
    markdown: '版本一',
    revision: database.value.revision,
  });
  const canvas = await tool('create_canvas', {
    title: '引用画布',
    canvas: {
      nodes: [{ id: 'page', type: 'file', x: 0, y: 0, width: 200, height: 100, file: row.value.page.path }],
      edges: [],
    },
    revision: row.value.revision,
  });
  const renamed = await tool('update_database_row', {
    path: row.value.page.path,
    values: {},
    title: '新名',
    revision: canvas.value.revision,
  });
  expect(renamed.error).toBe(false);
  expect((await tool('read_canvas', { path: canvas.value.page.path })).value.canvas.nodes[0].file).toBe(
    renamed.value.page.path,
  );
  const history = JSON.parse(
    await readFile(path.join(root, 'data/vaults/local/.morrow/history', row.value.page.id + '.json'), 'utf8'),
  );
  expect(
    history.snapshots.some((snapshot: { doc: unknown }) => JSON.stringify(snapshot.doc).includes('版本一')),
  ).toBe(true);
});

/** 显式字段ID必须优先于名称，交换字段名不能串用选项或丢失行选择。 */
it('交换单选字段名称时按字段ID保留选项与行值', async () => {
  const initial = await tool('read_page', { path: '不存在.md' });
  const database = await tool('create_database', {
    title: '字段互换',
    definition: {
      properties: [
        { id: 'a', name: '字段A', type: 'select', options: [{ id: 'optionA', name: '共同', color: 'blue' }] },
        {
          id: 'b',
          name: '字段B',
          type: 'select',
          options: [{ id: 'optionB', name: '共同', color: 'green' }],
        },
      ],
    },
    revision: initial.value.revision,
  });
  const row = await tool('create_database_row', {
    database_path: database.value.page.path,
    title: '记录',
    values: { a: 'optionA', b: 'optionB' },
    revision: database.value.revision,
  });
  const changed = await tool('update_database', {
    path: database.value.page.path,
    definition: {
      properties: [
        { id: 'b', name: '字段A', type: 'select', options: [{ name: '共同', color: 'green' }] },
        { id: 'a', name: '字段B', type: 'select', options: [{ name: '共同', color: 'blue' }] },
      ],
    },
    revision: row.value.revision,
  });
  expect(changed.error).toBe(false);
  const read = await tool('read_database', { path: database.value.page.path });
  expect(
    read.value.page.database.properties.find((prop: { id: string }) => prop.id === 'a').options[0].id,
  ).toBe('optionA');
  expect(
    read.value.page.database.properties.find((prop: { id: string }) => prop.id === 'b').options[0].id,
  ).toBe('optionB');
  expect(read.value.rows[0].properties).toMatchObject({ a: 'optionA', b: 'optionB' });
});
