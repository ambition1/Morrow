/**
 * 功能：启动多用户 Web 服务或通过管理员命令创建账号。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:01
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, createUser } from './app.mjs';

/** 服务程序所在目录，用于定位构建文件。 */
const here = path.dirname(fileURLToPath(import.meta.url));
/** 持久数据目录由部署环境指定。 */
const dataDir = process.env.MORROW_DATA_DIR ?? path.join(here, '../data');
if (process.argv[2] === 'create-user') {
  /** 密码通过环境传入，避免出现在进程命令行参数中。 */
  const password = process.env.MORROW_USER_PASSWORD;
  await createUser(dataDir, process.argv[3], password);
  console.log('账号已创建。');
} else {
  /** 默认只监听本机，通过反向代理提供 HTTPS。 */
  const host = process.env.MORROW_HOST ?? '127.0.0.1';
  /** 服务端口，可由容器或部署环境覆盖。 */
  const port = Number(process.env.PORT ?? 3000);
  /** 显式启用 HTTP 本地测试时才关闭安全 Cookie。 */
  const server = await createApp({
    dataDir,
    distDir: path.join(here, '../dist'),
    secureCookie: process.env.MORROW_INSECURE_HTTP !== '1',
  });
  server.listen(port, host, () => console.log(`Morrow Web 已启动：http://${host}:${port}`));
  /** 收到终止信号后停止接受新请求，等待正在保存的请求完成。 */
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
