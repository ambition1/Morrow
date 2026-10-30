/**
 * 功能：提供免登录的家庭共享笔记库存储和静态 Web 服务。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:01
 */
import http from 'node:http';
import path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';

/** 单次上传最大字节数，与客户端附件上限保持一致。 */
const MAX_BODY = 105 * 1024 * 1024;

/** 原子替换文件，进程退出时不会留下半个文件。 */
async function atomicWrite(target, data) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  /** 同目录临时文件确保重命名原子性。 */
  const temp = `${target}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    await fs.writeFile(temp, data, { mode: 0o600 });
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** 读取文件，文件不存在时返回空值，其他错误继续上报。 */
async function readOrNull(target, encoding) {
  try {
    return await fs.readFile(target, encoding);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

/** 生成附带状态码的业务错误。 */
function failure(status, message) {
  return Object.assign(new Error(message), { status });
}

/** 解析用户提供的相对路径，并拒绝任何符号链接和目录逃逸。 */
async function safePath(root, relative, allowRoot = false) {
  if (
    typeof relative !== 'string' ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    path.isAbsolute(relative) ||
    relative.split('/').some((part) => part === '..' || part === '.')
  )
    throw failure(400, '文件路径无效。');
  if (!relative && !allowRoot) throw failure(400, '不允许操作笔记库根目录。');
  /** 路径按片段逐个检查，阻止符号链接越权读取。 */
  let current = root;
  for (const part of relative.split('/').filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw failure(400, '不允许访问符号链接。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return current;
}

/** 判断文件是否属于可显示的页面。 */
function pageFile(relative) {
  return /\.(md|markdown|canvas)$/i.test(relative);
}
/** 隐藏应用内部目录，但保留页面回收站。 */
function hidden(relative) {
  return relative.split('/').some((part) => part.startsWith('.') && part !== '.trash');
}

/** 扫描家庭共享笔记库，符号链接不进入结果。 */
async function scanVault(root) {
  /** 返回给现有 VaultRepository 的文件结构。 */
  const result = { files: [], folders: [], others: [], registry: null, recent: null };
  /** 递归读取页面和目录信息。 */
  async function walk(relative = '') {
    /** 当前目录中的真实文件条目。 */
    const entries = await fs.readdir(await safePath(root, relative, true), { withFileTypes: true });
    for (const entry of entries) {
      /** 相对路径始终使用正斜线。 */
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink() || hidden(name)) continue;
      /** 文件时间用于页面导入和排序。 */
      const stat = await fs.stat(path.join(root, name));
      if (entry.isDirectory()) {
        result.folders.push({
          path: name,
          mtime: stat.mtimeMs,
          empty: (await fs.readdir(path.join(root, name))).length === 0,
        });
        await walk(name);
      } else if (entry.isFile() && pageFile(name)) {
        result.files.push({
          path: name,
          text: stat.size > 4_000_000 ? '' : await fs.readFile(path.join(root, name), 'utf8'),
          tooLarge: stat.size > 4_000_000,
          mtime: stat.mtimeMs,
          birthtime: stat.birthtimeMs,
        });
      } else if (entry.isFile()) result.others.push(name);
    }
  }
  await walk();
  for (const [key, file] of [
    ['registry', 'workspace.json'],
    ['recent', 'recent.json'],
  ]) {
    /** 注册表仅从共享笔记库的内部目录读取。 */
    const text = await readOrNull(await safePath(root, `.morrow/${file}`), 'utf8');
    if (text) result[key] = JSON.parse(text);
  }
  return result;
}

/** 执行单个文件操作，失败时停止当前批次。 */
async function applyOne(root, op) {
  if (!op || typeof op !== 'object') throw failure(400, '文件操作无效。');
  /** 单个操作的目标路径在写入前检查。 */
  const target = await safePath(root, op.op === 'rename' ? op.from : op.path);
  switch (op.op) {
    case 'write': {
      if (typeof op.text !== 'string') throw failure(400, '文本无效。');
      if (pageFile(op.path) && Buffer.byteLength(op.text) > 4_000_000)
        throw failure(413, '单个页面不能超过 4 MB，请拆分页面。');
      if (op.expect !== undefined) {
        /** 乐观锁检查文件内容，防止外部编辑被覆盖。 */
        const current = await readOrNull(target, 'utf8');
        if (current !== op.expect)
          return { ok: false, code: 'conflict', message: '文件已被其他设备修改。', current };
      }
      await atomicWrite(target, op.text);
      break;
    }
    case 'rename': {
      /** 重命名后的路径也必须位于共享笔记库中。 */
      const destination = await safePath(root, op.to);
      if (await readExists(destination)) return { ok: false, code: 'exists', message: '目标文件已存在。' };
      if (!(await readExists(target)) && op.optional) break;
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rename(target, destination);
      break;
    }
    case 'delete':
      if (!op.path.startsWith('.morrow/')) throw failure(400, '仅允许永久删除 Morrow 内部文件。');
      await fs.rm(target, { force: true });
      break;
    case 'remove':
      if (await readExists(target)) {
        /** 删除的文件保留到笔记库内部删除目录中。 */
        const deleted = await safePath(
          root,
          `.morrow/deleted/${Date.now()}-${randomBytes(6).toString('hex')}-${path.basename(target)}`,
        );
        await fs.mkdir(path.dirname(deleted), { recursive: true });
        await fs.rename(target, deleted);
      }
      break;
    case 'rmdir':
      try {
        await fs.rmdir(target);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
      }
      break;
    default:
      throw failure(400, '未知文件操作。');
  }
  return { ok: true };
}

/** 检查真实路径是否存在。 */
async function readExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/** 读取有限大小的请求体，防止无限上传占满内存。 */
async function body(request, limit = MAX_BODY) {
  /** 分段收集请求内容。 */
  const chunks = [];
  /** 已接收的总字节数。 */
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw failure(413, '请求内容过大。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 创建可测试的共享 HTTP 服务，所有设备访问同一笔记库。 */
export async function createApp({ dataDir, distDir }) {
  /** 规范化的数据根目录，仅由部署环境配置。 */
  const dataRoot = path.resolve(dataDir);
  /** 静态构建目录，不能与数据目录混用。 */
  const publicRoot = path.resolve(distDir);
  /** 继续使用现有服务器笔记库目录，不迁移或重建已有数据。 */
  const root = path.join(dataRoot, 'vaults', 'local');
  await fs.mkdir(root, { recursive: true });
  /** 稳定库身份随笔记库备份，服务重启不能使本机草稿失联。 */
  const identityPath = await safePath(root, '.morrow/vault-id');
  await fs.mkdir(path.dirname(identityPath), { recursive: true });
  try {
    await fs.writeFile(identityPath, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  /** 身份只用于草稿隔离，不包含服务器目录或访问凭证。 */
  const vaultIdentity = (await fs.readFile(identityPath, 'utf8')).trim();
  /** 全库串行队列防止不同设备的文件批次互相穿插。 */
  let queue = Promise.resolve();
  /** 全库共享版本，配合启动世代拒绝陈旧客户端覆盖。 */
  let revision = 0;
  /** 进程重启后版本计数即使归零也不会与旧标签页碰撞。 */
  const epoch = randomBytes(16).toString('hex');

  /** 在唯一共享队列中执行一次读取或写入。 */
  async function serialized(action) {
    /** 前一个请求失败也不能阻塞之后的操作。 */
    const next = queue.catch(() => {}).then(action);
    queue = next;
    return next;
  }
  /** 发送 JSON，禁止缓存敏感内容。 */
  function json(response, status, value) {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify(value));
  }
  /** 按路由处理请求，共享接口保留路径和同源边界检查。 */
  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    /** URL 只使用本地基地址解析，不信任 Host 头。 */
    const url = new URL(request.url, 'http://localhost');
    /** 所有写入必须由同源浏览器或受信任的命令行发起。 */
    const origin = request.headers.origin;
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      ((origin && new URL(origin).host !== request.headers.host) ||
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      throw failure(403, '禁止跨站请求。');
    // 健康检查只返回状态，不暴露文件路径或笔记内容。
    if (url.pathname === '/api/health' && request.method === 'GET') {
      try {
        await fs.access(path.join(publicRoot, 'index.html'), constants.R_OK);
        await fs.access(dataRoot, constants.W_OK);
        return json(response, 200, { ok: true });
      } catch {
        return json(response, 503, { ok: false });
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (!url.pathname.startsWith('/api/vault/')) throw failure(404, '接口不存在。');
      return serialized(async () => {
        response.setHeader('X-Morrow-Revision', `${epoch}:${revision}`);
        if (request.method === 'GET') {
          if (url.pathname === '/api/vault/identity') return json(response, 200, { id: vaultIdentity });
          if (url.pathname === '/api/vault/revision')
            return json(response, 200, { revision: `${epoch}:${revision}` });
          if (url.pathname === '/api/vault/scan') return json(response, 200, await scanVault(root));
          /** 查询的文件路径仍需经过服务端边界校验。 */
          const relative = url.searchParams.get('path') ?? '';
          /** 校验后的绝对路径绝不返回给浏览器。 */
          const target = await safePath(root, relative, url.pathname === '/api/vault/list');
          if (url.pathname === '/api/vault/text')
            return json(response, 200, await readOrNull(target, 'utf8'));
          if (url.pathname === '/api/vault/exists') return json(response, 200, await readExists(target));
          if (url.pathname === '/api/vault/list') {
            /** 列出目录下的文件，保持路径相对于笔记库。 */
            const files = [];
            /** 递归列举附件及内部历史文件。 */
            async function list(dir) {
              for (const entry of await fs.readdir(await safePath(root, dir, true), {
                withFileTypes: true,
              })) {
                /** 子目录项不允许符号链接。 */
                const name = dir ? `${dir}/${entry.name}` : entry.name;
                if (entry.isSymbolicLink()) continue;
                if (entry.isDirectory()) await list(name);
                else if (entry.isFile()) {
                  /** 文件元数据供客户端附件清理使用。 */
                  const stat = await fs.stat(await safePath(root, name));
                  files.push({ path: name, size: stat.size, mtime: stat.mtimeMs });
                }
              }
            }
            if (await readExists(target)) await list(relative);
            return json(response, 200, files);
          }
          if (url.pathname === '/api/vault/bytes') {
            /** 附件作为下载返回，禁止上传的 HTML 在应用来源执行。 */
            const bytes = await readOrNull(target);
            if (bytes === null) return json(response, 404, { error: '文件不存在。' });
            response.writeHead(200, {
              'Content-Type': 'application/octet-stream',
              'Content-Disposition': 'attachment',
              'Cache-Control': 'no-store',
              'Content-Security-Policy': "sandbox; default-src 'none'",
            });
            return response.end(bytes);
          }
        }
        if (request.method === 'POST' && ['/api/vault/apply', '/api/vault/file'].includes(url.pathname)) {
          if (request.headers['x-morrow-revision'] !== `${epoch}:${revision}`)
            throw failure(409, '笔记库已在其他设备更新，请先备份未保存内容并刷新页面。');
          /** 每次写入尝试都使旧客户端失效，部分成功也不能盲目重放。 */
          revision++;
          response.setHeader('X-Morrow-Revision', `${epoch}:${revision}`);
          if (url.pathname === '/api/vault/file') {
            /** 附件目标路径必须由服务端验证。 */
            const target = await safePath(root, url.searchParams.get('path'));
            /** 文件内容以二进制上传，不使用易膨胀的 Base64。 */
            const bytes = await body(request);
            if (pageFile(url.searchParams.get('path')) && bytes.length > 4_000_000)
              throw failure(413, '单个页面不能超过 4 MB。');
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
            return json(response, 200, { ok: true });
          }
          /** 操作列表限制数量，按顺序执行，首个失败后停止。 */
          const ops = JSON.parse((await body(request)).toString());
          if (!Array.isArray(ops) || ops.length > 20_000) throw failure(400, '文件操作列表无效。');
          /** 返回每个已尝试操作的结果。 */
          const results = [];
          for (const op of ops) {
            try {
              results.push(await applyOne(root, op));
            } catch (error) {
              results.push({
                ok: false,
                code: 'error',
                message: error.status ? error.message : '服务器文件操作失败。',
              });
            }
            if (!results.at(-1).ok) break;
          }
          return json(response, 200, results);
        }
        throw failure(404, '接口不存在。');
      });
    }
    if (!['GET', 'HEAD'].includes(request.method)) throw failure(405, '不支持此请求方法。');
    /** 静态路径同样限制在构建目录内。 */
    const relative = decodeURIComponent(url.pathname).replace(/^\//, '') || 'index.html';
    /** 只允许构建文件，数据目录永远不作为静态资源暴露。 */
    const target = await safePath(publicRoot, relative);
    /** 静态资源 MIME 映射。 */
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.webp': 'image/webp',
      '.woff2': 'font/woff2',
      '.txt': 'text/plain',
    };
    /** 文件不存在时返回 404，避免资源错误回退成 HTML。 */
    const content = await readOrNull(target);
    if (!content) throw failure(404, '文件不存在。');
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob:; frame-src blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    );
    response.writeHead(200, {
      'Content-Type': mime[path.extname(target)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : content);
  }
  /** HTTP 服务统一处理错误，不暴露服务器路径和调用栈。 */
  return http.createServer((request, response) => {
    void handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy();
      json(response, error.status ?? 500, {
        error: error.status ? error.message : '服务器处理失败，请检查服务日志。',
      });
      if (!error.status) console.error(error);
    });
  });
}
