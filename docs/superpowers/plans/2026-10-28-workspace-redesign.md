# Morrow 全页面视觉重构 Implementation Plan

> **For agentic workers:** 使用 subagent 分区实施，主代理负责共享基础、集成和浏览器验收。

**Goal:** 所有页面采用同一内容优先的中文工作空间设计，并保留笔记、账号、字体与编辑功能。

**Architecture:** 保留 React、原有业务组件和主题变量。将导航框架、集合页面、编辑工作区、设置弹层分别收敛为专用样式文件，统一引用共享令牌，避免多个代理修改同一基础样式。

**Tech Stack:** React、TypeScript、原生 CSS、Lucide、Vite、Vitest、Node Web 服务。

---

### Task 1: 共享设计与导航框架（主代理）

Files: `src/app/styles/tokens.css`, `src/app/styles/shell.css`, `src/main.tsx`, `src/app/components/Sidebar.tsx`, `DESIGN.md`。

- [x] 统一间距、页面标题、数据数字、焦点与移动端触控规则，保留系统字体默认和用户强调色。
- [x] 优化侧栏品牌区、主导航选中态、页面树、页签、顶部工具区、菜单与启动/登录状态。
- [x] 导入各分区样式，检查桌面与手机导航；不改变笔记数据。

### Task 2: 集合页面（collections subagent）

Files: `Home.tsx`, `Views.tsx`, `TagsView.tsx`, `SearchView.tsx`, `ReviewView.tsx`, `styles/collections.css`。

- [x] 检查现有文案、筛选和操作；统一页头、列表、空状态、统计和最近记录布局。
- [x] 移除无封面的随机渐变展示，保留用户主动设置的封面。
- [x] 执行 `npm run typecheck`，主代理实测所有路由与窄屏。

### Task 3: 编辑工作区（workspace_views subagent）

Files: `PageView.tsx`, `PageProperties.tsx`, `database/*`, `CanvasView.tsx`, `EmbeddedCanvas.tsx`, `GraphView.tsx`, `styles/workspace-views.css`。

- [x] 统一笔记标题/属性与数据库视图工具条；优化表格、看板、日历和画廊的边界与层级。
- [x] 优化画布/关系图谱工具区，不改变拖拽、缩放和编辑逻辑。
- [x] 执行 `npm run typecheck`，主代理在用户已有数据上只读验证并用独立测试库验证必要交互。

### Task 4: 设置与弹层（settings_dialogs subagent）

Files: `Settings.tsx`, `SettingsRows.tsx`, `SyncSettings.tsx`, `assistant/AssistantSettings.tsx`, 各 `*Dialog.tsx`, `CommandPalette.tsx`, `VaultChooser.tsx`, `ErrorBoundary.tsx`, `styles/dialogs-settings.css`。

- [x] 统一分组、字段、标题/脚部、选择状态、错误/禁用反馈与窄屏滚动。
- [x] 保留焦点管理、快捷键、字体偏好和可用的所有原功能。
- [x] 执行 `npm run typecheck`，主代理验证设置各页与常用弹窗。

### Task 5: 集成、自查与交付（主代理）

- [x] `npm run check`：类型、lint、186 项现有测试和完整构建。
- [x] `npm run test:web` 和 `npm run build:web`：Web 会话回归与服务页面更新。
- [x] 浏览器逐项覆盖路由、设置、弹层；检查浅/深色、1151/768/375px 与短屏，保存截图。
- [x] 更新 `docs/UI视觉验收.md`，区分代码审查、实际浏览器验收和不可测试的外部服务。
- [x] 代码审查后提交并推送功能分支，核对远端 SHA。

参考：`elayadesign/ai-design-skills` 及其 companion `redesign-skill`。采用扫描、诊断、局部修复、状态完整性原则；营销文案、指定外部字体、替换图标集、滚动宣传动画不适用于本项目。奖项水准作为方向，不作客观认证。
