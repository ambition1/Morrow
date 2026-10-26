/**
 * 功能：验证多用户认证、文件隔离、冲突保护和重启持久化。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:40:34
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, createUser } from './app.mjs';

/** 启动临时服务器并执行完整 HTTP 验收。 */
test('多账号隔离、认证、版本冲突、附件、路径边界及重启恢复', async () => {
  /** 测试数据不会进入真实用户目录。 */
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-web-'));
  /** 单独的静态目录用于检查数据文件不会被发布。 */
  const distDir = path.join(temp, 'public');
  /** 独立账号和笔记库的根目录。 */
  const dataDir = path.join(temp, 'private');
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>Morrow</h1>');
  await createUser(dataDir, 'alice', 'alice-test-password');
  await createUser(dataDir, 'bob', 'bob-test-password');
  await assert.rejects(createUser(dataDir, '../escape', 'test-password-long'));
  await assert.rejects(createUser(dataDir, 'short', 'short'));
  /** 测试服务器使用非安全 Cookie，仅限回环地址。 */
  let app;
  /** 当前启动实例的基础地址。 */
  let base;
  /** 当前测试进程世代由登录响应返回。 */
  let epoch;
  /** 启动新的服务器进程状态。 */
  async function start() {
    app = await createApp({ dataDir, distDir, secureCookie: false });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  }
  /** 确保 HTTP 服务完全关闭。 */
  async function stop() {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
  /** 发送带认证与可选版本头的接口请求。 */
  /** 测试会话绑定的用户名，与真实标签页的工作区绑定相同。 */
  const accounts = new Map();
  async function api(route, cookie = '', method = 'GET', value, revision) {
    return fetch(`${base}/api/${route}`, {
      method,
      headers: {
        Cookie: cookie,
        'X-Morrow-User': accounts.get(cookie) ?? '',
        ...(revision === undefined ? {} : { 'X-Morrow-Revision': `${epoch}:${revision}` }),
        'Content-Type': 'application/json',
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  /** 登录账号并提取浏览器将使用的会话 Cookie。 */
  async function login(username, password) {
    /** 登录响应必须使用不可被脚本读取的 Cookie。 */
    const response = await api('login', '', 'POST', { username, password });
    assert.equal(response.status, 200);
    epoch = (await response.json()).epoch;
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    const cookie = response.headers.get('set-cookie').split(';')[0];
    accounts.set(cookie, username);
    return cookie;
  }
  try {
    await start();
    // 探活不需要认证，也不返回目录和账号信息。
    assert.deepEqual(await (await api('health')).json(), { ok: true });
    // 缺少构建入口时不能将只启动了进程的实例报告为健康。
    await fs.rename(path.join(distDir, 'index.html'), path.join(distDir, 'index.saved'));
    assert.equal((await api('health')).status, 503);
    await fs.rename(path.join(distDir, 'index.saved'), path.join(distDir, 'index.html'));
    assert.equal((await api('vault/scan')).status, 401);
    assert.equal((await api('login', '', 'POST', { username: 'alice', password: 'wrong' })).status, 401);
    /** 两个独立账号和同账号的第二个设备会话。 */
    const alice = await login('alice', 'alice-test-password');
    /** Bob 的会话只能访问自己的目录。 */
    const bob = await login('bob', 'bob-test-password');
    /** Alice 的其他设备与主设备共享同一笔记库。 */
    const device = await login('alice', 'alice-test-password');
    /** 页面创建操作由服务端原子写入。 */
    const ops = [{ op: 'write', path: '中文笔记.md', text: '# 你好\n服务器持久内容', expect: null }];
    /** 首次保存的返回版本号。 */
    const saved = await api('vault/apply', alice, 'POST', ops, 0);
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), [{ ok: true }]);
    assert.equal(saved.headers.get('x-morrow-revision'), `${epoch}:1`);
    assert.equal((await (await api('vault/scan', bob)).json()).files.length, 0);
    assert.equal((await (await api('vault/scan', device)).json()).files[0].text, ops[0].text);
    assert.equal(
      (await api('vault/apply', device, 'POST', [{ op: 'write', path: '中文笔记.md', text: '旧内容' }], 0))
        .status,
      409,
    );
    assert.equal(await fs.readFile(path.join(dataDir, 'vaults/alice/中文笔记.md'), 'utf8'), ops[0].text);
    /** 越权路径及符号链接必须被拒绝。 */
    for (const escape of ['../bob/秘密.md', '/etc/passwd', '..\\bob\\secret', '../accounts/alice.json']) {
      assert.equal((await api(`vault/text?path=${encodeURIComponent(escape)}`, alice)).status, 400);
    }
    await fs.symlink(path.join(dataDir, 'accounts'), path.join(dataDir, 'vaults/alice/link'));
    assert.equal((await api('vault/text?path=link/alice.json', alice)).status, 400);
    /** 跨站提交不能依赖 Cookie 授权成功。 */
    const crossSite = await fetch(`${base}/api/vault/apply`, {
      method: 'POST',
      headers: { Cookie: alice, Origin: 'https://evil.example' },
      body: '[]',
    });
    assert.equal(crossSite.status, 403);
    /** 上传的 HTML 附件作为二进制返回，禁止在应用来源执行。 */
    const upload = await fetch(`${base}/api/vault/file?path=attachments/test.html`, {
      method: 'POST',
      headers: { Cookie: alice, 'X-Morrow-Revision': `${epoch}:1`, 'X-Morrow-User': 'alice' },
      body: '<script>alert(1)</script>',
    });
    assert.equal(upload.status, 200);
    /** 附件读取必须带当前账号的认证。 */
    const attachment = await api('vault/bytes?path=attachments/test.html', alice);
    assert.equal(attachment.headers.get('content-type'), 'application/octet-stream');
    assert.match(attachment.headers.get('content-disposition'), /attachment/);
    assert.equal((await api('vault/bytes?path=attachments/test.html', bob)).status, 404);
    assert.equal((await fetch(`${base}/private/accounts/alice.json`)).status, 404);
    assert.equal((await fetch(base)).status, 200);
    // 模拟旧 Alice 标签页在 Cookie 已切换为 Bob 后继续读写。
    const switched = await fetch(`${base}/api/vault/scan`, {
      headers: { Cookie: bob, 'X-Morrow-User': 'alice' },
    });
    assert.equal(switched.status, 409);
    const overwrite = await fetch(`${base}/api/vault/apply`, {
      method: 'POST',
      headers: { Cookie: bob, 'X-Morrow-User': 'alice', 'X-Morrow-Revision': `${epoch}:0` },
      body: JSON.stringify(ops),
    });
    assert.equal(overwrite.status, 409);
    // 已有超限页面不应阻止其余页面打开，写入超限页面应失败。
    await fs.writeFile(path.join(dataDir, 'vaults/alice/大页面.md'), 'x'.repeat(4_000_001));
    const scan = await (await api('vault/scan', alice)).json();
    assert.equal(scan.files.find((file) => file.path === '大页面.md').tooLarge, true);
    assert.equal(scan.files.find((file) => file.path === '中文笔记.md').text, ops[0].text);
    const oversized = await api(
      'vault/apply',
      alice,
      'POST',
      [{ op: 'write', path: 'too-big.md', text: 'x'.repeat(4_000_001) }],
      2,
    );
    assert.equal((await oversized.json())[0].ok, false);
    assert.equal(await fs.stat(path.join(dataDir, 'vaults/alice/too-big.md')).catch(() => null), null);
    // 并发错误密码请求必须包含限流响应。
    const failures = await Promise.all(
      Array.from({ length: 14 }, () => api('login', '', 'POST', { username: 'alice', password: 'wrong' })),
    );
    assert.ok(failures.some((response) => response.status === 429));
    /** 服务重启保留笔记，但旧会话失效。 */
    // 保留旧进程世代的零版本，重启后新计数同样为零仍必须拒绝。
    const oldRevision = `${epoch}:0`;
    await stop();
    await start();
    assert.equal((await api('session', alice)).status, 401);
    /** 新会话仍可读到磁盘上的页面。 */
    const fresh = await login('alice', 'alice-test-password');
    const stale = await fetch(`${base}/api/vault/apply`, {
      method: 'POST',
      headers: { Cookie: fresh, 'X-Morrow-User': 'alice', 'X-Morrow-Revision': oldRevision },
      body: JSON.stringify(ops),
    });
    assert.equal(stale.status, 409);
    assert.equal(
      (await (await api('vault/scan', fresh)).json()).files.find((file) => file.path === '中文笔记.md').text,
      ops[0].text,
    );
    assert.equal((await api('logout', fresh, 'POST')).status, 200);
    assert.equal((await api('vault/scan', fresh)).status, 401);
  } finally {
    if (app?.listening) await stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
