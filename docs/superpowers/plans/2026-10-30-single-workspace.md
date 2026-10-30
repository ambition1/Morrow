# 单工作区导航 Implementation Plan

**Goal:** 移除应用多标签页，顶部仅保留工具栏，增加正文可用高度。

**Architecture:** 将 tabs.ts 简化并更名为 navigation.ts；只维护主区域与可选分栏的历史，不再创建、关闭或恢复标签。保留现有 URL、分栏和笔记存储。

**Tech Stack:** React、TypeScript、Electron、CSS。

- [x] 删除 TabBar.tsx、标签栏样式、标签操作及快捷键；Electron 的 Cmd+W 恢复关闭窗口。
- [x] navigation.ts 用 main/side/pane 状态替代 tabs/active/closed，更新 App、router、TopBar、operations 和编辑器引用。使用新存储键，忽略旧标签列表。
- [x] 删除四种语言中无用标签文案，保留分栏文案并改用 navigation 分组。
- [x] 类型、lint、测试、Web 构建；独立测试库验证首页、笔记、历史导航、分栏、刷新及浅深色、768/375px；保存截图。
- [x] 提交并推送 develop，核对远端提交。
