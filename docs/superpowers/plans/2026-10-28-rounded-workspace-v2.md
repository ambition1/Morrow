# 第二版圆角工作空间 Implementation Plan

> **For agentic workers:** 使用subagent分区实施，主代理负责共享层、整合、逐项审查与实际浏览器验收。

**Goal:** 将用户确认的第二版笔记、数据库表格及深色看板设计落地到现有应用。

**Architecture:** 保留React/Tiptap与现有文件存储、数据库模型和操作链。组件负责语义和必要编辑状态，分区CSS负责布局，主代理维护共享外壳和翻译；不改账号、存储或协作逻辑。

**Tech Stack:** React、TypeScript、Tiptap、原生CSS、Lucide、Vite、Vitest、Node。

### Task 1: 设计资产与共享外壳（主代理）

Files: `docs/design/v2-rounded/*`, `DESIGN.md`, `src/app/styles/{tokens,shell,glass}.css`, `src/main.tsx`。

- [x] 保存三张第二版PNG，记录截图来源、边界、不可直接照抄的功能。
- [x] 统一外沿间距和主面板24px圆角，保留内层控件密度与主题。
- [x] 接入分区样式并审查选择器边界，避免覆盖其他工作区。

### Task 2: 笔记与页面框架（notes subagent）

Files: `src/app/components/PageView.tsx`, 可新建 `src/app/components/DocumentOutline.tsx`、`src/app/styles/document-v2.css`。

- [x] 笔记改为稳定的阅读版心、标题与元数据层级；独立数据库标记单独宽布局，不能影响内嵌数据库。
- [x] 从既有文档标题生成只读大纲，使用现有编辑器定位方式跳转，窄屏隐藏。
- [x] 保留标题编辑、封面、属性、每日笔记、嵌入、历史与分栏行为；执行类型检查和组件lint。

### Task 3: 数据库工具与单元格（database subagent）

Files: `src/app/components/database/{DatabaseView,PropertyValue}.tsx`, 可新建局部组件和 `src/app/styles/database-v2.css`。

- [x] 视图切换与数据工具分层，使用现有新建记录能力呈现主操作；字段表头显示类型图标。
- [x] 增加行序号与干净的只读单元格呈现，激活后使用现有编辑器；不要实现虚假的查找/行高/聚合。
- [x] 保留列宽、过滤、排序、所有属性编辑与保存；键盘可进入/退出，焦点离开或提交不丢值；执行类型检查和组件lint。

### Task 4: 看板与其他视图（views subagent）

Files: `src/app/styles/database-views-v2.css`，可以只读审查 `DatabaseView.tsx` 但不修改该文件，避免并行冲突。

- [x] 对齐深色看板的列头、计数、卡片属性和新建入口；状态颜色沿用原数据，不强改成概念色。
- [x] 调整日历、画廊、列表视图间距与边界；保持内部横向滚动、拖拽位置与可用操作。
- [x] 检查两种主题和窄分栏，必要JSX改动建议交给主代理整合。

### Task 5: 集成、审查与交付（主代理与review subagent）

- [x] 同步新增翻译键到en/es/pt/zh-CN，补中文注释及新代码文件头。
- [x] `npm run check`：类型、lint、现有184项测试与完整构建；对新增大纲解析等逻辑补有意义的边界测试。
- [x] `npm run test:web` 和 `npm run build:web`：免登录原路径读写回归和最新前端构建。
- [x] 用实际笔记、表格、看板、日历与设置验证桌面/768/375/短屏，检查真实截图；不写入设计示例数据。
- [x] 独立代码审查后修正具体问题，保存验收记录，提交推送并核对远端SHA。
