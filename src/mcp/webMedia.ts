/**
 * 功能：提供附件上传读取、引用保护和正文图片操作，复用现有附件与 Markdown 元数据格式。
 * 作者：xuanli
 * 创建时间：2026-11-07 19:18:11
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { fileIdsInDoc, walk, validateDoc } from '../core/doc';
import { canvasFromDoc } from '../core/canvas';
import type { DocNode } from '../core/model';
import { basename, dirname, isImagePath } from '../core/vault/paths';
import { resolveFile } from '../core/vault/load';
import { mimeOf } from '../storage/vaultRepository';
import { attachmentPath, entityPath, imageSettings, revisionSchema } from './webSchemas';
import { errorResult, jsonResult, toolCall } from './webResult';
import { withWebVault, vaultError } from './webVault';
import type { WebVault } from './webVault';

/** MCP Base64 请求保留协议开销；更大的文件使用现有二进制 HTTP 上传 API。 */
const MAX_UPLOAD_BYTES = 75 * 1024 * 1024;
/** 显式读取字节时限制响应大小，列表和下载链接不受此限制。 */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** 原生 MCP 图片内容仅使用客户端普遍支持的格式。 */
const MCP_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** 检查图片扩展名与基本文件头一致，避免将普通文本错误发布为图片。 */
function validateImage(name: string, bytes: Buffer): void {
  if (!isImagePath(name)) return;
  /** 文件头检查不加载浏览器预览器或第三方图像引擎。 */
  const ext = name.split('.').pop()!.toLowerCase();
  /** 每种项目已支持图片格式只读取少量文件头。 */
  const matches: Record<string, boolean> = {
    png: bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    jpg: bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    jpeg: bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])),
    gif: /^GIF8[79]a/.test(bytes.subarray(0, 6).toString('ascii')),
    webp: bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
    bmp: bytes.subarray(0, 2).toString() === 'BM',
    ico: bytes.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0])),
    avif: bytes.subarray(4, 8).toString() === 'ftyp' && /avif|avis/.test(bytes.subarray(8, 40).toString()),
    svg: /<svg(?:\s|>)/i.test(bytes.subarray(0, 4096).toString('utf8')),
  };
  if (!matches[ext]) throw vaultError(400, '图片扩展名与文件头不匹配。');
}

/** 定位存在的库内附件；既不接受服务器本机路径，也不抓取远程 URL。 */
async function requireAttachment(vault: WebVault, path: string): Promise<void> {
  attachmentPath.parse(path);
  if (!(await vault.exists(path))) throw vaultError(404, '附件不存在。', vault.revision);
}

/** 按深度优先顺序列出正文中可操作的媒体，索引仅在同一 revision 内有效。 */
function mediaIn(doc: DocNode): DocNode[] {
  /** 同一顺序供列表、属性修改与移除使用。 */
  const media: DocNode[] = [];
  walk(doc, (node) => {
    if (node.type === 'image' || node.type === 'fileAttachment') media.push(node);
  });
  return media;
}

/** 检查普通 Markdown 内联链接和未解析媒体源，防止删除后出现断链。 */
function hasInlineReference(vault: WebVault, pagePath: string, doc: DocNode, target: string): boolean {
  /** 路径索引与解析器使用同一个快照，包含带空格或中文的附件文件名。 */
  const index = new Map(vault.snapshot.others.map((path) => [path.toLowerCase(), path]));
  /** 无目录的文件名遵循项目已有的附件回退解析规则。 */
  const names = new Map<string, string[]>();
  for (const path of vault.snapshot.others)
    names.set(basename(path).toLowerCase(), [...(names.get(basename(path).toLowerCase()) ?? []), path]);
  /** 任何一个有效引用都阻止删除，原文中的远程 URL 不会被主动请求。 */
  let referenced = false;
  /** 解析每页目录下的相对链接，包括编码、父目录、查询和锚点。 */
  const pointsTo = (href: unknown): boolean => {
    if (typeof href !== 'string') return false;
    if (resolveFile(dirname(pagePath), href, index, names)?.fileId === target) return true;
    try {
      /** 下载 API 的地址也视为附件引用，不因 URL 使用方式不同而误删。 */
      const url = new URL(href, 'http://morrow.local');
      return url.pathname === '/api/vault/bytes' && url.searchParams.get('path') === target;
    } catch {
      return false;
    }
  };
  walk(doc, (node) => {
    if (
      (node.marks ?? []).some((mark) => mark.type === 'link' && pointsTo(mark.attrs?.href)) ||
      pointsTo(node.attrs?.src) ||
      pointsTo(node.attrs?.coverSrc)
    )
      referenced = true;
  });
  return referenced;
}

/** 图片与附件节点从复制的树中删除，保留其他正文和块属性。 */
function removeMedia(doc: DocNode, target: DocNode): DocNode {
  if (doc.content)
    doc.content = doc.content.filter((child) => child !== target).map((child) => removeMedia(child, target));
  return doc;
}

/** 注册媒体工具，所有修改都使用当前共享库版本和已有仓库序列化。 */
export function registerMediaTools(server: McpServer, baseUrl: string): void {
  server.registerTool(
    'upload_attachment',
    {
      description:
        '上传 Base64 附件或图片（最多75MiB）。name 只填文件名，不填本机路径或URL；重名自动另存，永不覆盖。返回 attachment_path 和新 revision，再用 insert_attachment 或画布工具插入。',
      inputSchema: {
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .refine(
            (value) =>
              !/[\\/]/.test(value) &&
              ![...value].some((character) => character.charCodeAt(0) < 32) &&
              !value.startsWith('.'),
            '只能填写普通文件名。',
          ),
        data_base64: z.string().max((MAX_UPLOAD_BYTES / 3) * 4 + 4),
        revision: revisionSchema,
      },
    },
    ({ name, data_base64, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** Buffer 解码默认宽松，因此必须进行规范编码回读校验。 */
          const bytes = Buffer.from(data_base64, 'base64');
          if (bytes.length > MAX_UPLOAD_BYTES || bytes.toString('base64') !== data_base64)
            throw vaultError(400, 'Base64 编码无效或附件超过75MiB。');
          if (/\.(md|markdown|canvas)$/i.test(name))
            throw vaultError(400, 'Markdown 和 Canvas 请使用对应页面工具，不作为普通附件上传。');
          validateImage(name, bytes);
          /** 只截取当前 Buffer 的有效字节，不上传池内其他文件内容。 */
          const data = bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
          /** 使用现有附件重名分配和新建保护。 */
          const [file] = await vault.repository.putFiles([
            {
              meta: { id: randomUUID(), name, type: mimeOf(name), size: bytes.length, createdAt: Date.now() },
              data,
            },
          ]);
          return {
            revision: vault.revision,
            attachment_path: file!.id,
            file,
            api_path: vault.fileUrl(file!.id),
          };
        }),
      ),
  );
  server.registerTool(
    'list_attachments',
    {
      description: '分页列出附件路径、MIME、大小和下载 API 路径；不返回所有文件字节。',
      inputSchema: {
        query: z.string().optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    ({ query, offset, limit }) =>
      toolCall(() =>
        withWebVault(baseUrl, undefined, async (vault) => {
          /** 每次列举仍校验当前快照版本，避免返回过期下载元数据。 */
          const files = (await vault.listFiles('attachments')).filter(
            (file) =>
              attachmentPath.safeParse(file.path).success &&
              (!query || file.path.toLowerCase().includes(query.toLowerCase())),
          );
          return {
            revision: vault.revision,
            total: files.length,
            offset,
            files: files
              .slice(offset, offset + limit)
              .map((file) => ({ ...file, mime_type: mimeOf(file.path), api_path: vault.fileUrl(file.path) })),
          };
        }),
      ),
  );
  server.registerTool(
    'read_attachment',
    {
      description:
        '读取附件元数据与下载地址。include_data=true 时读取最多8MiB的字节；常见图片返回原生 MCP 图片，其余附件返回 Base64。大文件使用 api_path 下载。',
      inputSchema: { path: attachmentPath, include_data: z.boolean().default(false) },
    },
    async ({ path, include_data }) => {
      try {
        /** 字节只在用户显式要求时读取，防止大文件意外填满上下文。 */
        return await withWebVault(baseUrl, undefined, async (vault) => {
          /** 元数据来自共享 API，同一 revision 下再读取字节。 */
          const file = (await vault.listFiles('attachments')).find((file) => file.path === path);
          if (!file) throw vaultError(404, '附件不存在。', vault.revision);
          /** 即使文件较大也能正常取得下载地址。 */
          const metadata = {
            ...file,
            revision: vault.revision,
            mime_type: mimeOf(path),
            api_path: vault.fileUrl(path),
          };
          if (!include_data) return jsonResult(metadata);
          if (file.size > MAX_READ_BYTES)
            throw vaultError(413, 'MCP 字节读取最多8MiB，请使用下载 API。', vault.revision);
          /** 标准 Base64 与原生图片内容使用同一份已校验字节。 */
          const data = Buffer.from((await vault.readBytes(path))!).toString('base64');
          if (MCP_IMAGE_TYPES.has(metadata.mime_type))
            return {
              content: [
                ...jsonResult(metadata).content,
                { type: 'image' as const, data, mimeType: metadata.mime_type },
              ],
              isError: false,
            };
          return jsonResult({ ...metadata, data_base64: data });
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );
  server.registerTool(
    'delete_attachment',
    {
      description:
        '移除未被任何页面、回收站页面、封面或画布引用的附件。存在引用、历史版本引用或不可读/加密页面时拒绝删除；文件保留至内部删除目录。',
      inputSchema: { path: attachmentPath, revision: revisionSchema },
    },
    ({ path, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          await requireAttachment(vault, path);
          vault.assertReferencesReadable();
          for (const page of Object.values(vault.state.pages)) {
            /** 包含回收站页面，避免仍可恢复的页面失去附件。 */
            const doc = vault.state.docs[page.id];
            if (
              page.cover === path ||
              (doc &&
                (fileIdsInDoc(doc).includes(path) ||
                  hasInlineReference(vault, vault.repository.pathOf(page.id) ?? '', doc, path))) ||
              (page.kind === 'canvas' &&
                canvasFromDoc(doc).nodes.some((node) => node.type === 'file' && node.file === path))
            )
              throw vaultError(409, '附件仍被页面、封面或画布引用，请先移除引用。', vault.revision);
          }
          /** 与界面附件清理一致，历史版本也保留对附件的引用。 */
          const histories = await vault.listFiles('.morrow/history');
          for (const file of histories.filter((file) => file.path.endsWith('.json'))) {
            /** 历史文件必须可读且结构完整，不能把读取失败视为没有引用。 */
            const history = JSON.parse((await vault.readText(file.path)) ?? '{}') as {
              snapshots?: { doc?: unknown }[];
            };
            if (!Array.isArray(history.snapshots))
              throw vaultError(400, '历史记录不可读取，无法确认附件引用。', vault.revision);
            /** 当前路径用于解析历史中的相对链接；不明确的旧路径再按文件名保守保护。 */
            const pageId = basename(file.path).replace(/\.json$/, '');
            for (const snapshot of history.snapshots) {
              /** 旧版本正文与当前页面使用同一文档结构校验。 */
              const doc = validateDoc(snapshot.doc);
              if (!doc.ok) throw vaultError(400, '历史正文不可读取，无法确认附件引用。', vault.revision);
              /** 图片、附件和 Canvas 的历史引用都应保护。 */
              let referenced =
                fileIdsInDoc(doc.value).includes(path) ||
                hasInlineReference(vault, vault.repository.pathOf(pageId) ?? '', doc.value, path) ||
                canvasFromDoc(doc.value).nodes.some((node) => node.type === 'file' && node.file === path);
              walk(doc.value, (node) => {
                for (const mark of node.marks ?? []) {
                  /** 页面移动后原相对目录未必可重建，按同名附件保守拒绝删除。 */
                  const href = mark.type === 'link' ? mark.attrs?.href : null;
                  if (typeof href !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
                  try {
                    if (basename(decodeURIComponent(href.split(/[?#]/)[0]!)) === basename(path))
                      referenced = true;
                  } catch {
                    /* 保留未识别链接，不进行 URL 抓取。 */
                  }
                }
              });
              if (referenced)
                throw vaultError(409, '附件仍被历史版本引用，请保留文件或先清理对应历史。', vault.revision);
            }
          }
          /** 删除也进入 API 队列，其他设备新建引用会使当前版本失效。 */
          const results = await vault.apply([{ op: 'remove', path }]);
          if (results.some((item) => !item.ok)) throw vaultError(400, '附件移除失败。', vault.revision);
          return { revision: vault.revision, removed: path };
        }),
      ),
  );
  server.registerTool(
    'list_page_media',
    {
      description:
        '列出正文图片和附件节点，返回 media_index、属性和 revision。索引在页面内容改变后必须重新读取。',
      inputSchema: { page_path: entityPath },
    },
    ({ page_path }) =>
      toolCall(() =>
        withWebVault(baseUrl, undefined, async (vault) => {
          /** 画布媒体使用 read_canvas，其节点和连线有独立标识。 */
          const page = vault.page(page_path);
          if (page.kind === 'canvas') throw vaultError(400, '画布请使用 read_canvas。');
          return {
            revision: vault.revision,
            page: vault.describe(page),
            media: mediaIn(vault.state.docs[page.id]!).map((node, media_index) => ({
              media_index,
              type: node.type,
              attrs: node.attrs ?? {},
            })),
          };
        }),
      ),
  );
  server.registerTool(
    'insert_attachment',
    {
      description:
        '将已上传附件插入页面正文。图片默认以图片节点插入，其余以附件节点插入；block_index 为顶层块位置，省略则追加。保留其他正文和元数据。',
      inputSchema: {
        page_path: entityPath,
        attachment_path: attachmentPath,
        as_image: z.boolean().optional(),
        block_index: z.number().int().min(0).optional(),
        ...imageSettings,
        revision: revisionSchema,
      },
    },
    ({ page_path, attachment_path, as_image, block_index, alt, caption, width, align, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 校验两端均存在，不创建悬空引用。 */
          const page = vault.page(page_path);
          if (page.kind === 'canvas') throw vaultError(400, '画布请使用 update_canvas 的 file 节点。');
          await requireAttachment(vault, attachment_path);
          /** 媒体直接操作文档树，不把整页重新解析成 Markdown。 */
          const doc = structuredClone(vault.state.docs[page.id]!);
          /** 图片类型由附件扩展名与用户的明确选择共同决定。 */
          const image = as_image ?? isImagePath(attachment_path);
          if (image && !isImagePath(attachment_path)) throw vaultError(400, '该附件不是支持的图片格式。');
          /** 使用项目原有图片/附件节点结构，尺寸等属性由原序列化器保留。 */
          const node: DocNode = image
            ? {
                type: 'image',
                attrs: {
                  fileId: attachment_path,
                  alt: alt ?? '',
                  caption: caption ?? '',
                  width: width ?? null,
                  align: align ?? 'center',
                },
              }
            : { type: 'fileAttachment', attrs: { fileId: attachment_path, name: basename(attachment_path) } };
          doc.content ??= [];
          if (block_index !== undefined && block_index > doc.content.length)
            throw vaultError(400, '插入位置超出正文块数量。');
          doc.content.splice(block_index ?? doc.content.length, 0, node);
          await vault.execute([{ type: 'page.setDoc', id: page.id, doc, now: Date.now() }]);
          return {
            revision: vault.revision,
            page: vault.describe(vault.state.pages[page.id]!),
            media: mediaIn(doc).map((node, media_index) => ({
              media_index,
              type: node.type,
              attrs: node.attrs,
            })),
          };
        }),
      ),
  );
  server.registerTool(
    'update_image',
    {
      description:
        '按 list_page_media 的 media_index 修改图片替代文字、图注、宽度、对齐或替换已上传图片；省略的属性保持原样，不删除旧文件。',
      inputSchema: {
        page_path: entityPath,
        media_index: z.number().int().min(0),
        attachment_path: attachmentPath.optional(),
        ...imageSettings,
        revision: revisionSchema,
      },
    },
    ({ page_path, media_index, attachment_path, alt, caption, width, align, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 复制整个文档，修改目标节点后仍保留相邻内容块与样式。 */
          const page = vault.page(page_path);
          /** 图像节点可位于图册或其他容器内。 */
          const doc = structuredClone(vault.state.docs[page.id]!);
          /** 索引与列表使用同一深度优先顺序。 */
          const node = mediaIn(doc)[media_index];
          if (!node || node.type !== 'image') throw vaultError(400, '指定索引不是图片，请重新读取媒体列表。');
          if (attachment_path) {
            await requireAttachment(vault, attachment_path);
            if (!isImagePath(attachment_path)) throw vaultError(400, '替换文件不是支持的图片。');
          }
          node.attrs = {
            ...node.attrs,
            ...(attachment_path ? { fileId: attachment_path, src: null } : {}),
            ...(alt !== undefined ? { alt } : {}),
            ...(caption !== undefined ? { caption } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(align !== undefined ? { align } : {}),
          };
          await vault.execute([{ type: 'page.setDoc', id: page.id, doc, now: Date.now() }]);
          return {
            revision: vault.revision,
            page: vault.describe(vault.state.pages[page.id]!),
            media_index,
            attrs: node.attrs,
          };
        }),
      ),
  );
  server.registerTool(
    'remove_page_media',
    {
      description:
        '移除正文中的指定图片或附件节点，保留附件文件和其他引用；删除文件需另用 delete_attachment。',
      inputSchema: { page_path: entityPath, media_index: z.number().int().min(0), revision: revisionSchema },
    },
    ({ page_path, media_index, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 只删除本次快照中指定的节点。 */
          const page = vault.page(page_path);
          /** 操作副本避免失败时改变已加载的原始正文。 */
          const doc = structuredClone(vault.state.docs[page.id]!);
          /** 版本检查防止旧索引移除另一张图片。 */
          const target = mediaIn(doc)[media_index];
          if (!target) throw vaultError(404, '媒体索引不存在。');
          await vault.execute([
            { type: 'page.setDoc', id: page.id, doc: removeMedia(doc, target), now: Date.now() },
          ]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
        }),
      ),
  );
  server.registerTool(
    'set_page_cover',
    {
      description:
        '设置或清除页面封面。cover 为已上传图片路径、gradient-1 至 gradient-12，或 null；不改变正文图片。',
      inputSchema: {
        page_path: entityPath,
        cover: z.union([attachmentPath, z.string().regex(/^gradient-([1-9]|1[0-2])$/), z.null()]),
        revision: revisionSchema,
      },
    },
    ({ page_path, cover, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 画布没有页面封面，不伪装成保存成功。 */
          const page = vault.page(page_path);
          if (page.kind === 'canvas') throw vaultError(400, '画布不支持页面封面。');
          if (cover?.startsWith('attachments/')) {
            await requireAttachment(vault, cover);
            if (!isImagePath(cover)) throw vaultError(400, '封面必须是图片。');
          }
          await vault.execute([{ type: 'page.setCover', id: page.id, cover, now: Date.now() }]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
        }),
      ),
  );
}
