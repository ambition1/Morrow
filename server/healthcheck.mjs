/**
 * 功能：探测 HTTP 服务、构建资源和数据目录是否可用。
 * 作者：xuanli
 * 创建时间：2026-10-27 01:21:20
 */
/** 端口与服务启动配置保持一致，探针不需要账号或会话。 */
const port = Number(process.env.PORT ?? 3000);
try {
  /** 单次探活必须及时结束，避免健康检查堆积。 */
  const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
    signal: AbortSignal.timeout(3000),
  });
  /** 只有完整的成功响应才认为实例健康。 */
  const health = await response.json();
  if (!response.ok || health.ok !== true) process.exitCode = 1;
} catch {
  process.exitCode = 1;
}
