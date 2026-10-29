import { insertInlineDate } from './InlineDate';
import { Extension } from '@tiptap/core';
import type { Editor, Range } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import Suggestion from '@tiptap/suggestion';
import {
  CalendarDays,
  Images,
  FileText,
  Globe,
  Columns2,
  Columns3,
  ListTree,
  Workflow,
  ChevronRight,
  Highlighter,
  LayoutDashboard,
  Sigma,
  Table2,
  Code2,
  ImageIcon,
  Info,
  Paperclip,
  Heading1,
  Heading2,
  Heading,
  Heading3,
  Link2,
  List,
  ListChecks,
  ListOrdered,
  Minus,
  Pilcrow,
  Quote,
  Table,
} from 'lucide-react';
import { foldText } from '../../core/search';
import { t } from '../i18n';
import type { TranslationKey } from '../i18n';
import { pickFiles } from '../platform/files';
import { editMathNear } from './Extras';
import { insertFiles } from './Media';
import { insertGallery } from './Gallery';
import { openBookmarkEditor, openPageCardPicker } from './ReferenceCards';
import type { MenuItem } from './SuggestionMenu';
import { renderSuggestion } from './SuggestionMenu';

interface BlockItem extends MenuItem {
  keywords: string;
  run: (editor: Editor, range: Range, options: SlashOptions) => void;
}

export interface SlashOptions {
  // makes a subpage of the open page and returns its id, used for databases and canvases
  createChild: (kind: 'database' | 'canvas') => string | null;
}

const linkChild = (
  editor: Editor,
  range: Range,
  options: SlashOptions,
  kind: 'database' | 'canvas',
  embed = false,
) => {
  const id = options.createChild(kind);
  if (!id) return;
  const label = kind === 'database' ? 'Database' : 'Canvas';
  chain(editor, range)
    .insertContent([
      { type: 'pageLink', attrs: embed ? { id, label, embed: true } : { id, label } },
      { type: 'text', text: ' ' },
    ])
    .run();
};

const SAMPLE_DIAGRAM = `flowchart LR
  Idea --> Draft --> Review
  Review -->|changes| Draft
  Review --> Done`;

const chain = (editor: Editor, range: Range) => editor.chain().focus().deleteRange(range);

export const BLOCK_ITEMS: BlockItem[] = [
  {
    id: 'text',
    title: 'Text',
    description: 'Plain paragraph',
    icon: Pilcrow,
    keywords: 'paragraph plain',
    run: (e, r) => chain(e, r).setParagraph().run(),
  },
  {
    id: 'h1',
    title: 'Heading 1',
    description: 'Large section heading',
    icon: Heading1,
    hint: '#',
    keywords: 'title h1',
    run: (e, r) => chain(e, r).setHeading({ level: 1 }).run(),
  },
  {
    id: 'h2',
    title: 'Heading 2',
    description: 'Medium heading',
    icon: Heading2,
    hint: '##',
    keywords: 'subtitle h2',
    run: (e, r) => chain(e, r).setHeading({ level: 2 }).run(),
  },
  {
    id: 'h3',
    title: 'Heading 3',
    description: 'Small heading',
    icon: Heading3,
    hint: '###',
    keywords: 'h3',
    run: (e, r) => chain(e, r).setHeading({ level: 3 }).run(),
  },
  ...([4, 5, 6] as const).map((level) => ({
    id: `h${level}`,
    title: `Heading ${level}`,
    description: 'A smaller heading, for deeper sections',
    icon: Heading,
    hint: '#'.repeat(level),
    keywords: `h${level} subheading`,
    run: (e: Editor, r: Range) => chain(e, r).setHeading({ level }).run(),
  })),
  {
    id: 'bullet',
    title: 'Bulleted list',
    description: 'Simple list',
    icon: List,
    hint: '-',
    keywords: 'unordered ul bullet',
    run: (e, r) => chain(e, r).toggleBulletList().run(),
  },
  {
    id: 'ordered',
    title: 'Numbered list',
    description: 'List with numbers',
    icon: ListOrdered,
    hint: '1.',
    keywords: 'ordered ol',
    run: (e, r) => chain(e, r).toggleOrderedList().run(),
  },
  {
    id: 'task',
    title: 'Checklist',
    description: 'Track tasks',
    icon: ListChecks,
    hint: '[ ]',
    keywords: 'todo task checkbox',
    run: (e, r) => chain(e, r).toggleTaskList().run(),
  },
  {
    id: 'quote',
    title: 'Quote',
    description: 'Quotation or callout',
    icon: Quote,
    hint: '>',
    keywords: 'blockquote citation',
    run: (e, r) => chain(e, r).setBlockquote().run(),
  },
  {
    id: 'code',
    title: 'Code block',
    description: 'Monospaced code',
    icon: Code2,
    hint: '```',
    keywords: 'snippet pre',
    run: (e, r) => chain(e, r).setCodeBlock().run(),
  },
  {
    id: 'divider',
    title: 'Divider',
    description: 'Horizontal line',
    icon: Minus,
    hint: '---',
    keywords: 'hr rule separator line',
    run: (e, r) => chain(e, r).setHorizontalRule().run(),
  },
  {
    id: 'callout',
    title: 'Callout',
    description: 'Highlighted note',
    icon: Info,
    keywords: 'note tip warning aside alert',
    run: (e, r) => chain(e, r).setCallout().run(),
  },
  {
    id: 'toggle',
    title: 'Toggle',
    description: 'Content that folds away',
    icon: ChevronRight,
    keywords: 'details collapse fold accordion',
    run: (e, r) => chain(e, r).setDetails().run(),
  },
  {
    id: 'image',
    title: 'Image',
    description: 'Picture from your computer',
    icon: ImageIcon,
    keywords: 'picture photo upload',
    run: (e, r) => {
      chain(e, r).run();
      void pickFiles('image/*', true).then((files) => insertFiles(e, files));
    },
  },
  {
    id: 'gallery',
    title: 'Gallery',
    description: 'A collection of photos',
    icon: Images,
    keywords: 'gallery album photos images 图册 相册 图片组',
    run: (editor, range) => {
      chain(editor, range).run();
      void pickFiles('image/*', true).then((files) => insertGallery(editor, files));
    },
  },
  {
    id: 'pageCard',
    title: 'Reference card',
    description: 'A card linked to a local note',
    icon: FileText,
    keywords: 'reference card local page note 引用卡片 笔记卡片',
    run: (editor, range) => {
      chain(editor, range).run();
      openPageCardPicker(editor);
    },
  },
  {
    id: 'bookmark',
    title: 'Website card',
    description: 'A manually written link preview',
    icon: Globe,
    keywords: 'bookmark website link preview card 网页卡片 书签 链接摘要',
    run: (editor, range) => {
      chain(editor, range).run();
      openBookmarkEditor(editor);
    },
  },
  {
    id: 'inlineCode',
    title: 'Inline code',
    description: 'Code inside a sentence',
    icon: Code2,
    keywords: 'inline code 行内代码',
    run: (editor, range) => chain(editor, range).toggleCode().run(),
  },
  {
    id: 'file',
    title: 'File',
    description: 'Attach any file',
    icon: Paperclip,
    keywords: 'attachment upload pdf document',
    run: (e, r) => {
      chain(e, r).run();
      void pickFiles('', true).then((files) => insertFiles(e, files));
    },
  },
  {
    id: 'table',
    title: 'Table',
    description: 'Rows and columns',
    icon: Table,
    keywords: 'grid spreadsheet',
    run: (e, r) => chain(e, r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    id: 'math',
    title: 'Formula',
    description: 'Display maths in LaTeX',
    icon: Sigma,
    hint: '$$',
    keywords: 'math equation latex katex tex formula',
    run: (e, r) => {
      chain(e, r)
        .insertContent({ type: 'blockMath', attrs: { latex: '' } })
        .run();
      // the formula opens for typing straight away
      editMathNear(e, r.from);
    },
  },
  {
    id: 'inlineMath',
    title: 'Inline formula',
    description: 'Maths inside a sentence',
    icon: Sigma,
    hint: '$…$',
    keywords: 'math equation latex inline',
    // inserted at the slash itself, then opened for typing like a block formula
    run: (e, r) => {
      chain(e, r)
        .insertContent({ type: 'inlineMath', attrs: { latex: '' } })
        .run();
      editMathNear(e, r.from);
    },
  },
  {
    id: 'highlight',
    title: 'Highlight',
    description: 'Mark text to find it again',
    icon: Highlighter,
    hint: '==',
    keywords: 'mark marker yellow',
    run: (e, r) => chain(e, r).toggleHighlight().run(),
  },
  {
    id: 'database',
    title: 'Database',
    description: 'Table, board and calendar of pages',
    icon: Table2,
    keywords: 'collection kanban board calendar gallery table',
    run: (e, r, options) => linkChild(e, r, options, 'database'),
  },
  {
    id: 'canvas',
    title: 'Canvas',
    description: 'Cards and arrows on a whiteboard',
    icon: LayoutDashboard,
    keywords: 'whiteboard board diagram mind map',
    run: (e, r, options) => linkChild(e, r, options, 'canvas'),
  },
  {
    id: 'inlineDatabase',
    title: 'Inline database',
    description: 'A database shown right on this page',
    icon: Table2,
    keywords: 'inline table board embedded view',
    run: (e, r, options) => linkChild(e, r, options, 'database', true),
  },
  {
    id: 'inlineCanvas',
    title: 'Inline canvas',
    description: 'A whiteboard shown right on this page',
    icon: LayoutDashboard,
    keywords: 'inline whiteboard drawing sketch embedded board',
    run: (e, r, options) => linkChild(e, r, options, 'canvas', true),
  },
  {
    id: 'columns2',
    title: '2 columns',
    description: 'Put blocks side by side',
    icon: Columns2,
    keywords: 'columns layout side by side split',
    run: (e, r) => chain(e, r).setColumns(2).run(),
  },
  {
    id: 'columns3',
    title: '3 columns',
    description: 'Three blocks side by side',
    icon: Columns3,
    keywords: 'columns layout side by side split',
    run: (e, r) => chain(e, r).setColumns(3).run(),
  },
  {
    id: 'toc',
    title: 'Table of contents',
    description: 'Every heading on this page',
    icon: ListTree,
    keywords: 'toc outline contents headings index',
    run: (e, r) => chain(e, r).insertContent({ type: 'tableOfContents' }).run(),
  },
  {
    id: 'diagram',
    title: 'Diagram',
    description: 'Flowcharts and more with Mermaid',
    icon: Workflow,
    keywords: 'mermaid flowchart sequence gantt chart graph uml',
    run: (e, r) =>
      chain(e, r)
        .insertContent({
          type: 'codeBlock',
          attrs: { language: 'mermaid' },
          content: [{ type: 'text', text: SAMPLE_DIAGRAM }],
        })
        .run(),
  },
  {
    id: 'date',
    title: 'Date',
    description: 'Display a date and optional time in this document',
    icon: CalendarDays,
    keywords: 'date time calendar today tomorrow 日期 时间 日历 时刻',
    run: (editor, range) => insertInlineDate(editor, range),
  },
  {
    id: 'embed',
    title: 'Embed a page',
    description: 'Show another page inside this one',
    icon: Link2,
    hint: '![[',
    keywords: 'transclude include synced block mirror',
    run: (e, r) => chain(e, r).insertContent('![[').run(),
  },
  {
    id: 'link',
    title: 'Link to page',
    description: 'Mention another page',
    icon: Link2,
    hint: '[[',
    keywords: 'mention reference wiki',
    run: (e, r) => chain(e, r).insertContent('[[').run(),
  },
];

export function getLocalizedBlocks(): BlockItem[] {
  return BLOCK_ITEMS.map((item) => {
    const titleKey = `slash.items.${item.id}.title` as TranslationKey;
    const descKey = `slash.items.${item.id}.description` as TranslationKey;
    const kwKey = `slash.items.${item.id}.keywords` as TranslationKey;
    const title = t(titleKey);
    const description = t(descKey);
    const localizedKw = t(kwKey);
    const keywords =
      localizedKw && localizedKw !== kwKey ? `${item.keywords ?? ''} ${localizedKw}` : item.keywords;
    return {
      ...item,
      title: title && title !== titleKey ? title : item.title,
      description: description && description !== descKey ? description : item.description,
      keywords,
    };
  });
}

/** 最近执行的命令只保存在当前浏览器偏好中。 */
const RECENT_BLOCKS_KEY = 'morrow.recentBlocks';
/** 格式区按照七列、两行的视觉顺序排列。 */
const FORMAT_IDS = [
  'text',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'bullet',
  'ordered',
  'task',
  'quote',
  'link',
  'inlineCode',
  'divider',
];
/** 内容区使用双列短标签，图册与普通图片分开。 */
const CONTENT_IDS = ['image', 'gallery', 'table', 'file', 'callout', 'columns2', 'toggle', 'toc'];

/** 读取最多四个最近命令，损坏的偏好不影响打开菜单。 */
export function recentBlockIds(): string[] {
  try {
    // 本地存储只接收字符串数组，并在重开时去重。
    const saved: unknown = JSON.parse(localStorage.getItem(RECENT_BLOCKS_KEY) ?? '[]');
    return Array.isArray(saved)
      ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))].slice(0, 4)
      : [];
  } catch {
    return [];
  }
}

/** 用户执行命令后才更新最近使用，不因悬停或搜索而变化。 */
export function rememberBlock(id: string): void {
  try {
    localStorage.setItem(
      RECENT_BLOCKS_KEY,
      JSON.stringify([id, ...recentBlockIds().filter((saved) => saved !== id)].slice(0, 4)),
    );
  } catch {
    /* 私密浏览或存储已满时保持菜单可用。 */
  }
}

/** 空查询的紧凑分组；返回扁平顺序供键盘与鼠标共同使用。 */
function grouped(): BlockItem[] {
  // 本地化文案与命令定义仍来自唯一列表。
  const items = getLocalizedBlocks();
  // 已放入格式区和内容区的命令不会在更多区重复。
  const placed = new Set([...FORMAT_IDS, ...CONTENT_IDS]);
  // 最近使用允许与其所属分组同时展示，但采用独立选项ID。
  const recent = recentBlockIds().flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item
      ? [
          {
            ...item,
            id: `recent:${id}`,
            commandId: id,
            compact: 'recent' as const,
            section: t('editor.insertion.recent'),
          },
        ]
      : [];
  });
  // 图标格式按钮的字符本身包含标题级别，不另外占文字行。
  const format = FORMAT_IDS.flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item
      ? [
          {
            ...item,
            compact: 'format' as const,
            glyph: id === 'text' ? 'T' : /^h[1-6]$/.test(id) ? id.toUpperCase() : undefined,
            section: t('editor.insertion.format'),
          },
        ]
      : [];
  });
  // 一般内容在图标区之后以双列排列。
  const content = CONTENT_IDS.flatMap((id) => {
    const item = items.find((candidate) => candidate.id === id);
    return item ? [{ ...item, compact: 'content' as const, section: t('editor.insertion.content') }] : [];
  });
  // 已有其他能力全部保留，没有为了压缩面板而删掉命令。
  const more = items
    .filter((item) => !placed.has(item.id))
    .map((item) => ({ ...item, compact: 'more' as const, section: t('editor.insertion.more') }));
  return [...recent, ...format, ...content, ...more];
}

// blocks whose name matches come before blocks that only match a keyword, so /diagram finds the diagram
export function filterBlocks(query: string): BlockItem[] {
  const folded = foldText(query.trim());
  if (!folded) return grouped();
  const words = folded.split(/\s+/);
  const items = getLocalizedBlocks();
  const rank = (item: BlockItem): number => {
    const title = foldText(item.title);
    if (title.startsWith(folded)) return 0;
    if (title.includes(folded)) return 1;
    const haystack = `${title} ${foldText(item.keywords ?? '')}`;
    return words.every((word) => haystack.includes(word)) ? 2 : -1;
  };
  return items
    .map((item) => ({ item, score: rank(item) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score)
    .map((entry) => entry.item);
}

export const SlashCommand = Extension.create<SlashOptions>({
  name: 'slashCommand',
  addOptions() {
    return { createChild: () => null };
  },
  addProseMirrorPlugins() {
    const options = this.options;
    return [
      Suggestion<MenuItem, MenuItem>({
        editor: this.editor,
        pluginKey: new PluginKey('slashCommand'),
        char: '/',
        startOfLine: false,
        // names like "2 columns" have spaces, a sentence typed after a slash simply finds nothing
        allowSpaces: true,
        allow: ({ state }) => {
          const parent = state.selection.$from.parent;
          return parent.type.name !== 'codeBlock';
        },
        items: ({ query }) =>
          query.length > 40 || /\s{2}/.test(query) ? [] : filterBlocks(query).slice(0, 40),
        command: ({ editor, range, props }) => {
          const item = BLOCK_ITEMS.find((candidate) => candidate.id === (props.commandId ?? props.id));
          if (!item || !editor.isEditable) return;
          item.run(editor, range, options);
          rememberBlock(item.id);
        },
        render: renderSuggestion(
          () => t('slash.menu.insertBlock'),
          () => t('slash.menu.noMatchingBlocks'),
          'insert',
          { mode: 'slash' },
        ),
      }),
    ];
  },
});
