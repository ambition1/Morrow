# 附件预览实施与验收

2026-11-03。本文中的图片均为本次代码在隔离测试笔记库中的实际截图，不是生成效果图；测试没有修改用户笔记库。

## 已实现

- 正文附件统一“预览”入口，默认侧边显示，可继续编辑笔记。宽度支持拖动及键盘左右键调整。
- 显示方式菜单提供侧边、内嵌、大窗；本次运行内沿用最后选择。内嵌可拖动改变高度；大窗复用现有 Dialog。三种方式使用同一个引擎实例，并恢复引擎支持的阅读状态。
- 白板文件卡片提供预览入口，支持侧边和大窗；离开白板自动关闭所属预览。
- Office、PDF/OFD、文本代码、压缩包、邮件、思维导图和流程图按需装载。音视频保留原生浏览器播放器；现有图片块仍使用原图片查看器。
- 未支持的附件保留保存副本；明显损坏的 PDF/Office 容器、读取与解析错误提供失败提示、下载与重试。
- 本地发布 Worker、WASM、字体；同步 Web 与 Electron 的 CSP，补齐生产静态资源 MIME。MCP 构建不复制界面资源。
- 中、英、西、葡四种语言补齐操作文案；浅深主题复用现有令牌。

## 验证结果

| 项目 | 实际验证 |
| --- | --- |
| 自动检查 | `npm run check` 通过：类型、lint、29 个测试文件/276 项测试、桌面与 MCP 构建 |
| Web 构建与服务 | `npm run build:web`、`npm run test:web` 通过，2 项服务测试包含 Worker/WASM/字体 MIME |
| 浏览器文件样本 | DOCX、XLSX（两个工作表）、CSV、两页 PDF、PPTX、OFD、EML、ZIP、JSON、Draw.io、XMind、HTML 源码、WAV |
| 样本来源 | python-docx、openpyxl、python-pptx、reportlab 生成有效容器；OFD/导图/邮件/压缩包使用独立构造的最小有效样本 |
| 桌面运行 | 使用独立 `MORROW_USER_DATA` 启动真实 Electron，从 `morrow://app` 打开 DOCX/PDF/XLSX/ZIP，无控制台错误 |
| 边看边记 | 侧边预览时正文可输入；切换内嵌、大窗及关闭后正文仍保留；预览 DOM 不进入 Markdown |
| 阅读状态 | PDF 从第 2 页切换大窗后仍为第 2 页 |
| 键盘 | 大窗 Tab 能进入 Shadow DOM 内搜索、缩放及 PDF 分页；Escape 关闭大窗 |
| 生命周期 | 白板打开 PDF、菜单不显示无容器的内嵌方式；离开白板清理预览 |
| 响应式 | 1151px 桌面、768px 平板、375px 手机与 375×500 短屏，页面无横向溢出；窄屏上下布局 |
| 主题 | 浅色、深色实际截图；文件内部文档颜色由对应渲染器处理 |
| 错误恢复 | 拦截首次 Viewer chunk 网络请求使其失败，点击重试后成功渲染；损坏 PDF/Office 在启动解析器前显示回退 |
| 按需加载 | 首屏网络请求没有预览引擎 chunk、Worker 或 WASM |
| HTML 邮件 | 正文可见；iframe 使用空 sandbox；注入脚本未执行、外部跟踪图片未请求 |

## 截图

- [侧边与笔记](actual-side-light.png)
- [正文内嵌](actual-inline-light.png)
- [大窗](actual-window-light.png)
- [电子表格](actual-spreadsheet-light.png)
- [邮件](actual-email-light.png)
- [错误回退](actual-error-light.png)
- [白板文件](actual-canvas-light.png)
- [深色](actual-dark.png)
- [375px 手机](actual-mobile.png)
- [短屏大窗](actual-window-short.png)
- [Electron PDF](actual-electron-pdf.png)

## 支持边界

扩展名路由以 `src/app/preview/formats.ts` 为准。样本验证不代表每个扩展名、复杂排版、字体、加密文件和生产大文件都已验证；旧版 DOC/XLS/PPT 与其他压缩格式已注册，但本轮未逐一取得样本验收。音视频能否解码仍依赖浏览器。PlantUML 默认保持离线源码预览，不连接公共转换服务。CAD、3D、设计源文件及 Apple 文档未纳入本轮。

分页、搜索、缩放、工作表切换等控件按引擎实际能力显示。图片效果稿中的所有格式不共享相同分页或缩略图功能。文件预览保持只读；CSV/Excel 预览不会转为 Morrow 数据库。
