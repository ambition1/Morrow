# Morrow Web 多设备编辑与页面冲突处理实施计划

**目标**：两个无需登录的浏览器可以独立编辑同一笔记库。不同页面互不阻塞，同一页面发生并发修改时保留两边内容，并在对应页面处理。

**方案**：按页面判断正文是否冲突，底层继续用整库版本保护包含共享文件的批次。借助现有草稿基准和保存队列重新生成安全批次。干净会话接收远端更新，编辑中的会话保留本地内容。

**技术栈**：React、TypeScript、IndexedDB、Markdown 文件库、Node.js、Vitest、Node 测试运行器。

## 范围与工作区

- 分支：`codex/web-page-conflicts`，以 `develop` 的 `231b5e3` 为基准。
- 独立 Git 工作区：`/Users/mini/Documents/coding/worktree/web-page-conflicts/Morrow`。开发、构建和测试均从此处运行。
- 验收覆盖同一电脑的 Chrome 和 Safari（或 Chromium 和 WebKit 的独立浏览器环境），以及同一浏览器的两个标签页。浏览器本地草稿彼此独立，服务器提交内容共享。同一标签页刷新后仍可恢复待处理草稿。
- 首版同页并发采用人工恢复。不同块自动合并、多用户身份权限、实时光标、外部 Markdown 文件主动监控另行评估。
- 页面重命名、移动、删除、加密、附件、画布和数据库变更沿用现有保护，普通正文的恢复路径不接管这些操作。

## 任务一：让顶栏恢复入口跟随当前页

**文件**：`src/app/ui.ts`、`src/app/components/TopBar.tsx`、`src/app/components/Dialogs.tsx`、`src/app/components/RecoveryDialog.tsx`、`src/app/i18n/locales/`。

- [ ] 通过顶栏传递当前页面 ID，恢复对话框区分页面范围和整库范围。页面模式先按 `pageId` 筛选，再按现有来源、页面和草稿版本定位记录。无匹配记录时显示当前页无草稿，提供「查看全部草稿」入口。
- [ ] 当前页有待处理记录时显示页名和保存状态。仅其他页面有待恢复内容时提供明确的全局入口。整库版本过旧且没有当前页草稿时使用「笔记库有更新」提示。区分本地已保护、服务器已保存、保存受阻。
- [ ] 复用现有 Dialog、Select、按钮和语义令牌。显示草稿时间，来源只使用客户端可确认的信息。删除草稿仍需现有的精确版本校验，保留下载、另存副本和服务器版本对比。
- [ ] 在 A、B 页各准备草稿，从 A 进入只见 A；进入全局视图能找回 B。从没有草稿的 C 页进入时不展示 B 的对比结果。用 Tab、Escape 检查焦点与关闭行为。

## 任务二：让不同页面并发保存

**文件**：`src/app/platform/webVault.ts`、`src/app/platform/webRecovery.ts`、`src/storage/session.ts`、`src/storage/saveQueue.ts`、`src/storage/vaultRepository.ts`、`server/app.test.mjs`、`src/app/platform/webRecovery.test.ts`。

- [ ] 为已落盘的普通笔记正文编辑记录不可变的基准和草稿代次，保留页面身份、内容、元数据和位置。采集实际命令或队列变更，禁止把混有结构、属性、加密、附件或其他副作用的批次误判为纯正文。已加密页面沿用原路径。
- [ ] 当原保存返回整库 `409` 时，用独立只读仓库载入最新状态，不提前更改活动写入桥接的版本。对每笔正文编辑检查页面存在、可编辑、基准正文和相关元数据及位置仍匹配。通过后将捕获的正文应用到最新状态，重新计算页面文件、共享索引与统计并用最新整库版本提交。禁止直接重发曾生成的旧操作列表。已有文件的 `expect` 校验继续作为落盘保护。
- [ ] 用旧代次提交时保持新输入独立，成功后仅确认服务器已接收的代次。任何候选失败时保持该轮批次及全部待定草稿，显示明确的受阻页面。第二次 `409` 可有一次有界重试，之后停止并提示。同页正文改变、删除、移动、会话切换及部分写入失败须保留草稿，重新读取或提示用户，不按整库冲突路径盲目重放。
- [ ] 在 `server/app.test.mjs` 保留旧整库版本拒绝与文件比较用例。新增跨两个客户端的应用级覆盖：同一基准编辑两页，两份正文及共享索引都保留；同页只允许第一写入直接落盘；移动与删除不让陈旧草稿重新创建页面；保存过程中继续输入时，后一代草稿仍在。
- [ ] 运行 `npm run test:web` 和 `npm test -- src/app/platform/webRecovery.test.ts src/storage`，预期目标用例全部通过。

## 任务三：让干净会话接收远端更新

**文件**：`src/app/platform/webVault.ts`、`src/app/platform/webRecovery.ts`、`src/app/workspace.ts`、`src/storage/session.ts`、编辑器提交入口 `src/app/editor/commits.ts`。

- [ ] 复用现有版本轮询，并在浏览器恢复可见时探测。若没有内存编辑、在途写入、待保存或未应用的本机草稿，读取一致的远端快照并接收到当前工作区。请求完成后再次检查本地活动代次和会话身份；加载途中开始编辑就放弃这次替换。
- [ ] 接收新快照时同步活动仓库缓存和保存基准，保留当前页面、布局和有效焦点。页面已删除时给出正常导航回退。编辑中的页面继续使用自己的基准，显示必要的远端更新提示。
- [ ] 覆盖干净会话自动更新、后台浏览器恢复可见、加载途中输入、网络断开重连、草稿恢复后再接收以及服务重启。记录从轮询发现更新到页面可见的结果。

## 任务四：独立目录验收

- [ ] 在新分支安装锁定依赖，执行 `npm run check` 和 `npm run test:web`。后端测试用例通过 `fs.mkdtemp` 创建独立目录。
- [ ] 真机验收用新建的 `/tmp/morrow-web-conflicts.7UwgZbXF` 子目录启动独立实例。每次复测可换新的 `mktemp` 目录。使用回环地址和独立端口，直接由 Node 服务同源提供构建，不使用 Vite 当前指向 3000 的代理。

```sh
npm run build:web
morrow_test_root="$(mktemp -d /tmp/morrow-web-conflicts.7UwgZbXF/run.XXXXXXXX)"
MORROW_DATA_DIR="$morrow_test_root" MORROW_HOST=127.0.0.1 PORT=34183 node server/index.mjs
```

- [ ] 先查端口，已占用则换一个空闲端口。用第二个终端请求 `curl --fail http://127.0.0.1:34183/api/health`，预期返回 `{"ok":true}`。通过这一个测试地址创建合成笔记。测试期间不启动现有 Compose 服务、不使用现有 Docker 的 `morrow-data` 卷或 `/app/data`。完成后只停止本次启动的 Node 进程。
- [ ] 用独立浏览器上下文依次验证不同页并发、同页冲突与副本、断网草稿与重连、同浏览器多标签、另一浏览器自动接收以及刷新后两页仍存在。保留可检查的截图和测试记录。
- [ ] 按 `DESIGN.md` 和 `ui-ux-pro-max` 检查浅色、深色、焦点、桌面、约 768px、375px 和短屏。重点检查长页名、状态区分、无本页草稿时的下一步以及对话框键盘行为。交付说明实际检查环境和未覆盖的范围。

## 执行记录

- 类型检查、lint、281 项 Vitest 测试、Web 服务端测试以及 Web 和 Electron 构建通过。
- 使用 Google Chrome 和 Playwright WebKit 独立浏览器验证。分别编辑两页时两份正文均落盘。同页编辑时服务器保留先提交的正文，后提交的浏览器可比较、下载并在刷新后另存副本。另一个标签页产生的离线草稿只在全局视图中可见。已打开的干净页面能收到另一浏览器保存的正文。
- 界面覆盖浅色、深色、1280px 和 768px 窗口，以及 375×620px 短屏。验证 Escape 关闭并返回顶栏入口、窄屏无横向溢出、草稿下载按钮可滚动到达。
- 最终双浏览器验收使用 `/tmp/morrow-web-conflicts.7UwgZbXF/run.qF07mf0o` 和 `/tmp/morrow-web-conflicts.7UwgZbXF/run.qkmNdV6m`。截图均来自运行页面。 [浅色](../../design/web-page-conflicts/01-page-conflict-light.png) · [深色](../../design/web-page-conflicts/02-page-conflict-dark.png) · [窄屏](../../design/web-page-conflicts/03-page-conflict-mobile.png) · [全部草稿](../../design/web-page-conflicts/04-all-drafts.png)

## 正文差异与合并

对比按 Markdown 行分组，服务器侧标记 `−`，本机侧标记 `+`。保留共同行，逐段选择服务器、本机或两侧之后才能提交逐段合并结果。也可以进入手工模式编辑合并预览，或直接采用任一整页正文。整页选择保留来源的结构化正文。手工与逐段合并仍使用原有附件引用保护和服务器写入校验。

使用 Chrome 与 WebKit 在两份独立临时库中验证整页采用两侧、跨段混选、手动补写后保存以及窄屏显示。288 项应用测试与 Web 服务端测试通过。 [桌面浅色](../../design/web-page-conflicts/diff-light.png) · [桌面深色](../../design/web-page-conflicts/diff-dark.png) · [手机窄屏](../../design/web-page-conflicts/diff-mobile.png)
