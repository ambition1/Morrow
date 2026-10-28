/**
 * 功能：验证免登录家庭共享、版本冲突、附件边界及重启恢复。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:40:34
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './app.mjs';

/** 两个无凭证客户端共享内容，同时保留路径与陈旧写入保护。 */
test('家庭共享无需登录、冲突保护、附件边界与重启恢复', async () => {
  /** 所有验证数据保存在一次性目录中。 */
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'morrow-family-'));
  /** 静态资源与真实数据始终隔离。 */
  const distDir = path.join(temp, 'public');
  /** 共享数据根目录。 */
  const dataDir = path.join(temp, 'private');
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, 'index.html'), '<h1>Morrow</h1>');
  /** 当前服务实例，重启时替换。 */
  let app;
  /** 本次服务的回环地址。 */
  let base;
  /** 启动不使用账号或 Cookie 配置的实例。 */
  async function start() {
    app = await createApp({ dataDir, distDir });
    await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${app.address().port}`;
  }
  /** 等待所有连接关闭，确保重启测试不复用旧服务。 */
  async function stop() {
    app.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
  }
  /** 所有接口调用均不携带 Cookie 或用户标识。 */
  async function api(route, method = 'GET', value, revision) {
    return fetch(`${base}/api/${route}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(revision === undefined ? {} : { 'X-Morrow-Revision': revision }),
      },
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  }
  /** 读取当前共享版本，不隐式推进行为基准。 */
  async function currentRevision() {
    return (await (await api('vault/revision')).json()).revision;
  }
  try {
    await start();
    assert.deepEqual(await (await api('health')).json(), { ok: true });
    await fs.rename(path.join(distDir, 'index.html'), path.join(distDir, 'index.saved'));
    assert.equal((await api('health')).status, 503);
    await fs.rename(path.join(distDir, 'index.saved'), path.join(distDir, 'index.html'));
    assert.equal((await api('session')).status, 404);
    assert.equal((await api('login', 'POST', {})).status, 404);
    assert.equal((await api('logout', 'POST')).status, 404);
    /** 设备一、设备二在同一版本读取。 */
    const first = await api('vault/scan');
    const second = await api('vault/scan');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('set-cookie'), null);
    assert.deepEqual((await first.json()).files, []);
    /** 不携带身份信息仍可写入共享库。 */
    const baseline = second.headers.get('x-morrow-revision');
    const ops = [{ op: 'write', path: '中文笔记.md', text: '# 你好\n家庭共享内容', expect: null }];
    const saved = await api('vault/apply', 'POST', ops, baseline);
    assert.deepEqual(await saved.json(), [{ ok: true }]);
    assert.equal((await (await api('vault/scan')).json()).files[0].text, ops[0].text);
    assert.equal((await api('vault/apply', 'POST', ops, baseline)).status, 409);
    assert.equal((await api('vault/apply', 'POST', ops)).status, 409);
    assert.equal(await fs.readFile(path.join(dataDir, 'vaults/local/中文笔记.md'), 'utf8'), ops[0].text);
    /** 服务端拒绝越界和符号链接，但不需要登录。 */
    for (const escape of ['../accounts/secret.json', '/etc/passwd', '..\\other\\secret', './中文笔记.md']) {
      assert.equal((await api(`vault/text?path=${encodeURIComponent(escape)}`)).status, 400);
    }
    await fs.writeFile(path.join(temp, 'secret.txt'), 'private');
    await fs.symlink(path.join(temp, 'secret.txt'), path.join(dataDir, 'vaults/local/link'));
    assert.equal((await api('vault/text?path=link')).status, 400);
    /** 跨站页面不能借免登录接口提交修改。 */
    const crossSite = await fetch(`${base}/api/vault/apply`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
      body: '[]',
    });
    assert.equal(crossSite.status, 403);
    /** 附件所有设备共享，但 HTML 仍只能按二进制下载。 */
    const upload = await fetch(`${base}/api/vault/file?path=attachments/test.html`, {
      method: 'POST',
      headers: { 'X-Morrow-Revision': await currentRevision() },
      body: '<script>alert(1)</script>',
    });
    assert.equal(upload.status, 200);
    const attachment = await api('vault/bytes?path=attachments/test.html');
    assert.equal(attachment.headers.get('content-type'), 'application/octet-stream');
    assert.match(attachment.headers.get('content-disposition'), /attachment/);
    assert.equal(await attachment.text(), '<script>alert(1)</script>');
    assert.equal((await fetch(`${base}/private/accounts/secret.json`)).status, 404);
    assert.equal((await fetch(base)).status, 200);
    /** 超限旧页面不妨碍其他笔记加载，超限写入不创建文件。 */
    await fs.writeFile(path.join(dataDir, 'vaults/local/大页面.md'), 'x'.repeat(4_000_001));
    const scan = await (await api('vault/scan')).json();
    assert.equal(scan.files.find((file) => file.path === '大页面.md').tooLarge, true);
    const oversized = await api(
      'vault/apply',
      'POST',
      [{ op: 'write', path: 'too-big.md', text: 'x'.repeat(4_000_001) }],
      await currentRevision(),
    );
    assert.equal((await oversized.json())[0].ok, false);
    assert.equal(await fs.stat(path.join(dataDir, 'vaults/local/too-big.md')).catch(() => null), null);
    /** 并发客户端只有一个能基于相同版本提交。 */
    const concurrentBase = await currentRevision();
    const attempts = await Promise.all(
      ['a', 'b'].map((name) =>
        api('vault/apply', 'POST', [{ op: 'write', path: `${name}.md`, text: name }], concurrentBase),
      ),
    );
    assert.deepEqual(attempts.map((response) => response.status).sort(), [200, 409]);
    /** 重启无需重新登录，旧进程世代的版本仍然无效。 */
    const oldRevision = await currentRevision();
    await stop();
    await start();
    assert.equal((await api('vault/scan')).status, 200);
    assert.equal((await api('vault/apply', 'POST', ops, oldRevision)).status, 409);
    assert.equal(
      await (await api('vault/text?path=' + encodeURIComponent('中文笔记.md'))).json(),
      ops[0].text,
    );
  } finally {
    if (app?.listening) await stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
});
