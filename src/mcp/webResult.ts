/**
 * 功能：统一结构化 MCP 工具的结果和冲突错误，避免业务失败被误判为成功。
 * 作者：xuanli
 * 创建时间：2026-11-07 19:13:35
 */
/** 将普通对象转成 MCP 文本结果。 */
export function jsonResult(value: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], isError };
}

/** 保留 HTTP 状态与最新版本，客户端据此重新读取而非盲目覆盖。 */
export function errorResult(error: unknown) {
  /** 错误可能来自 API、结构校验或已有仓库。 */
  const detail = error as { status?: number; revision?: string; message?: string };
  return jsonResult(
    { status: detail?.status ?? 400, revision: detail?.revision, error: detail?.message ?? String(error) },
    true,
  );
}

/** 将工具执行异常转换成明确的 MCP 业务错误。 */
export async function toolCall(action: () => Promise<unknown>) {
  try {
    return jsonResult(await action());
  } catch (error) {
    return errorResult(error);
  }
}
