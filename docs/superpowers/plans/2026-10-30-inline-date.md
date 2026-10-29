# 文档内日期与时间实施计划

**Goal:** 插入可原地编辑的日期标签，点击日历修改日期及可选时刻，不跳转文档。

**Architecture:** 独立 inlineDate 行内节点，复用 Popover 和现有日历样式；旧 dateMention 每日笔记链接保持兼容。使用可读 HTML time 持久化，不依赖页面 ID。

**Tech Stack:** Tiptap、React、现有 i18n 与 CSS 语义令牌。

- [x] 日期／时刻校验及 Markdown 往返、纯文本、静态导出测试。
- [x] 行内标签、月份／年份导航、快捷日期、时刻选择和键盘日历。
- [x] 接入斜杠菜单、翻译及样式；只读模式不编辑、不跳转。
- [x] 类型、lint、测试、构建与独立临时笔记库浏览器验收。
- [x] 提交并按既有 develop 流程推送，更新本地 Web 构建。

实际验收与截图：[日期组件验收](../../design/inline-date/README.md)。
