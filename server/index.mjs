/**
 * 功能：启动免登录的家庭共享 Web 服务。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:38:01
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.mjs';

/** 服务程序所在目录，用于定位构建文件。 */
const here = path.dirname(fileURLToPath(import.meta.url));
/** 持久数据目录由部署环境指定。 */
const dataDir = process.env.MORROW_DATA_DIR ?? path.join(here, '../data');
/** 默认只监听本机，部署时可通过反向代理或环境变量公开访问。 */
const host = process.env.MORROW_HOST ?? '127.0.0.1';
/** 服务端口，可由容器或部署环境覆盖。 */
const port = Number(process.env.PORT ?? 3000);
/** 服务创建过程先完成共享库初始化和旧数据迁移。 */
const server = await createApp({ dataDir, distDir: path.join(here, '../dist') });
server.listen(port, host, () => console.log(`Morrow Web 已启动：http://${host}:${port}`));
/** 收到终止信号后等待正在保存的请求完成。 */
const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
