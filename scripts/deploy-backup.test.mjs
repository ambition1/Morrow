/**
 * 功能：验证自动备份的保留范围、故障记录及空目录恢复契约。
 * 作者：xuanli
 * 创建时间：2026-10-30 16:42:49
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 模拟 Docker 调用但使用真实 tar 与 gzip，避免单元测试连接用户实例。 */
const dockerStub = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FAKE_LOG"
case " $* " in
  *' config '*) printf 'name: fixture\\n' ;;
  *' ps --status running '*) [[ ! -f "$FAKE_DATA/stopped" ]] && printf 'container\\n'; exit 0 ;;
  *' ps -a '*) printf 'container\\n' ;;
  *' stop morrow '*) touch "$FAKE_DATA/stopped" ;;
  *' start morrow '*) [[ "\${FAKE_FAIL_START:-}" != 1 ]] || exit 8; rm -f "$FAKE_DATA/stopped" ;;
  *' --entrypoint tar '*)
    [[ "\${FAKE_FAIL_TAR:-}" != 1 ]] || exit 7
    if [[ " $* " == *' -czf '* ]]; then tar -C "$FAKE_DATA/source" -cf - . | gzip
    else tar -C "$FAKE_DATA/target" --keep-old-files -xzf -; fi ;;
  *' --entrypoint node '*) [[ -z "$(ls -A "$FAKE_DATA/target")" ]] ;;
  *) printf '未支持的模拟调用\\n' >&2; exit 9 ;;
esac
`;

/** 为每项测试创建独立代码目录、源库、恢复目录与外部备份目录。 */
async function fixture(t) {
  /** 临时根与各独立目录均在测试结束后删除。 */
  const root = await mkdtemp(path.join(tmpdir(), 'morrow-backup-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  /** 模拟部署与二进制目录。 */
  const project = path.join(root, 'project');
  /** 模拟数据目录。 */
  const data = path.join(root, 'data');
  /** 目标归档目录不属于代码目录。 */
  const backups = path.join(root, 'archives');
  for (const directory of [
    path.join(project, 'scripts'),
    path.join(root, 'bin'),
    path.join(data, 'source'),
    path.join(data, 'target'),
    backups,
  ])
    await mkdir(directory, { recursive: true });
  await copyFile(new URL('./deploy.sh', import.meta.url), path.join(project, 'scripts/deploy.sh'));
  await writeFile(path.join(root, 'bin/docker'), dockerStub);
  await chmod(path.join(root, 'bin/docker'), 0o755);
  await writeFile(path.join(data, 'source/note.md'), '家庭笔记');
  /** 子进程仅继承测试所需的路径，并用临时 Docker 替身隔离真实服务。 */
  const env = {
    ...process.env,
    PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
    FAKE_DATA: data,
    FAKE_LOG: path.join(root, 'docker.log'),
    MORROW_BACKUP_DIR: backups,
    MORROW_BACKUP_KEEP: '2',
  };
  /** 以真实部署脚本执行目标操作。 */
  const run = (action, extra = [], changes = {}) =>
    spawnSync('bash', [path.join(project, 'scripts/deploy.sh'), 'local', action, ...extra], {
      env: { ...env, ...changes },
      encoding: 'utf8',
    });
  return { root, project, data, backups, run };
}

test('自动备份只清理本项目自动归档，并在服务恢复后记录成功', async (t) => {
  /** 独立测试实例。 */
  const f = await fixture(t);
  for (const name of [
    'fixture-auto-20200101T000000Z-1.tar.gz',
    'fixture-auto-20210101T000000Z-2.tar.gz',
    'other-auto-20200101T000000Z-1.tar.gz',
    'fixture-manual.tar.gz',
    'fixture-auto-custom.tar.gz',
  ])
    await writeFile(path.join(f.backups, name), '保留范围样本');
  /** 完整备份结果。 */
  const result = f.run('auto-backup');
  assert.equal(result.status, 0, result.stderr);
  /** 保留列表不包含过旧的本项目归档。 */
  const files = await readdir(f.backups);
  assert.equal(files.includes('fixture-auto-20200101T000000Z-1.tar.gz'), false);
  assert.equal(files.includes('fixture-auto-20210101T000000Z-2.tar.gz'), true);
  assert.equal(files.includes('other-auto-20200101T000000Z-1.tar.gz'), true);
  assert.equal(files.includes('fixture-manual.tar.gz'), true);
  assert.equal(files.includes('fixture-auto-custom.tar.gz'), true);
  assert.match(
    await readFile(path.join(f.backups, 'fixture-backup.status'), 'utf8'),
    /last_result=0\nlast_success=\d{4}-/,
  );
  assert.equal(f.run('backup-status').status, 0);
  assert.equal((await readdir(f.data)).includes('stopped'), false);
  assert.deepEqual(await readdir(path.join(f.project, '.deploy-locks')), []);
});

test('失败保留最近成功时间、不清理旧备份，并恢复原服务', async (t) => {
  /** 先生成一次成功备份作为恢复点。 */
  const f = await fixture(t);
  assert.equal(f.run('auto-backup').status, 0);
  /** 失败前的成功记录。 */
  const before = await readFile(path.join(f.backups, 'fixture-backup.status'), 'utf8');
  /** 注入真实打包子进程失败。 */
  const failed = f.run('auto-backup', [], { FAKE_FAIL_TAR: '1' });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /自动备份失败/);
  /** 失败状态保留之前的成功时间与文件。 */
  const after = await readFile(path.join(f.backups, 'fixture-backup.status'), 'utf8');
  assert.equal(after.match(/^last_success=.*$/m)?.[0], before.match(/^last_success=.*$/m)?.[0]);
  assert.equal(after.match(/^last_archive=.*$/m)?.[0], before.match(/^last_archive=.*$/m)?.[0]);
  assert.notEqual(f.run('backup-status').status, 0);
  assert.equal(
    (await readdir(f.backups)).some((name) => name.includes('.tmp.')),
    false,
  );
  assert.equal((await readdir(f.data)).includes('stopped'), false);
});

test('服务重启失败不能报告备份成功', async (t) => {
  /** 注入服务启动失败。 */
  const f = await fixture(t);
  assert.notEqual(f.run('auto-backup', [], { FAKE_FAIL_START: '1' }).status, 0);
  assert.match(await readFile(path.join(f.backups, 'fixture-backup.status'), 'utf8'), /last_success=\n/);
});

test('真实归档恢复至空目标，非空目标拒绝覆盖', async (t) => {
  /** 使用真实目录包含笔记、附件、历史和回收站。 */
  const f = await fixture(t);
  for (const relative of [
    'vaults/local/页面.md',
    'vaults/local/attachments/image.bin',
    'vaults/local/.morrow/history/page.json',
    'vaults/local/.trash/deleted.md',
  ]) {
    await mkdir(path.dirname(path.join(f.data, 'source', relative)), { recursive: true });
    await writeFile(path.join(f.data, 'source', relative), relative);
  }
  assert.equal(f.run('auto-backup').status, 0);
  /** 成功归档路径由脚本状态提供。 */
  const archive = (await readFile(path.join(f.backups, 'fixture-backup.status'), 'utf8')).match(
    /^last_archive=(.*)$/m,
  )?.[1];
  await writeFile(path.join(f.data, 'stopped'), '');
  assert.equal(f.run('restore', [archive]).status, 0);
  for (const relative of [
    'vaults/local/页面.md',
    'vaults/local/attachments/image.bin',
    'vaults/local/.morrow/history/page.json',
    'vaults/local/.trash/deleted.md',
  ])
    assert.equal(await readFile(path.join(f.data, 'target', relative), 'utf8'), relative);
  assert.notEqual(f.run('restore', [archive]).status, 0);
});

test('自动备份拒绝项目内部目标、非法保留数量与已有部署锁', async (t) => {
  /** 无效输入不能触发停止服务。 */
  const f = await fixture(t);
  assert.notEqual(f.run('auto-backup', [], { MORROW_BACKUP_DIR: path.join(f.project, 'backups') }).status, 0);
  assert.notEqual(f.run('auto-backup', [], { MORROW_BACKUP_KEEP: '0' }).status, 0);
  await mkdir(path.join(f.project, '.deploy-locks/fixture'), { recursive: true });
  assert.notEqual(f.run('auto-backup').status, 0);
  assert.equal((await readdir(f.data)).includes('stopped'), false);
});
