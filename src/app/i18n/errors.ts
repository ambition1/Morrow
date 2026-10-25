/**
 * 功能：在界面边界翻译存储层和核心层返回的常见错误，保留未知诊断信息。
 * 作者：xuanli
 * 创建时间：2026-10-25 23:57:05
 */
import { getLocale } from './index';
import type { SupportedLocale } from './types';

/** 核心层保持与界面无关，错误在展示时才转换成中文。 */
const messages: Record<string, string> = {
  'Document must be an object of type "doc".': '文档格式无效。',
  'Document is nested too deeply.': '文档嵌套层级过深。',
  'Document is too large.': '文档过大，请拆分为多个页面。',
  'Document contains an invalid node.': '文档包含无效的内容块。',
  'Text node has invalid text.': '文本内容无效。',
  'Node has invalid attributes.': '内容块属性无效。',
  'Node has invalid marks.': '内容块格式标记无效。',
  'Node has an invalid mark.': '内容块包含无效的格式标记。',
  'Node has invalid content.': '内容块数据无效。',
  'Only pages in the trash can be deleted permanently.': '只有回收站中的页面才能永久删除。',
  'That checklist item no longer exists.': '此任务项已不存在。',
  'Invalid cover.': '封面无效。',
  'Only ordinary pages can be encrypted.': '只有普通页面可以加密。',
  'Unknown page kind.': '未知页面类型。',
  'Invalid property.': '属性无效。',
  'Invalid property value.': '属性值无效。',
  'That page is not a database.': '此页面不是数据库。',
  'Invalid database.': '数据库无效。',
  'Invalid page id.': '页面标识无效。',
  'A page with this id already exists.': '具有相同标识的页面已存在。',
  'Invalid daily date.': '每日笔记的日期无效。',
  'A page cannot be moved inside itself.': '不能将页面移动到自身内部。',
  'A page cannot be moved inside one of its own subpages.': '不能将页面移动到自己的子页面内部。',
  'Invalid id for the copy.': '副本标识无效。',
  'Nothing to insert.': '没有可插入的内容。',
  'Invalid page id in import.': '导入内容包含无效的页面标识。',
  'Imported page has a missing parent.': '导入页面缺少父页面。',
  'Imported pages contain a cycle.': '导入页面的层级关系存在循环。',
  'The parent page does not exist.': '父页面不存在。',
  'Pages cannot be added inside a page in the trash.': '不能在回收站中的页面内添加页面。',
  'That page no longer exists.': '此页面已不存在。',
  'Invalid page icon.': '页面图标无效。',
  'Encrypted pages need a vault folder.': '加密页面需要文件笔记库。',
  'This page could not be read, so it is protected from changes.': '无法读取此页面，已禁止修改以保护原内容。',
  'Nothing to write yet.': '暂无可写入的内容。',
  'The desktop shell stopped before finishing the save.': '保存尚未完成，文件服务已停止。',
  'The file kept changing on disk while Morrow tried to save it.':
    '保存期间文件持续被其他程序修改，请稍后重试。',
  'This page is not on disk.': '磁盘中没有此页面。',
  'That password is not right.': '密码不正确。',
  'The page was decrypted but could not be read.': '页面已解密，但无法读取内容。',
  'Failed to fetch': '网络连接失败，请检查连接后重试。',
  'Load failed': '加载失败，请检查网络连接。',
};

/** 翻译已知错误和存储错误前缀；文件名和技术详情保持原样。 */
export function localizeError(message: string, locale: SupportedLocale = getLocale()): string {
  if (locale !== 'zh-CN') return message;
  return (
    messages[message] ??
    message
      .replace(/^Could not open the folder (.*): /, '无法打开笔记库 $1：')
      .replace(/^Could not open your workspace: /, '无法打开工作区：')
      .replace(/^Could not save: /, '无法保存：')
  );
}
