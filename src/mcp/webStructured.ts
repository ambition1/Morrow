/**
 * 功能：提供数据库定义与行、JSON Canvas 的 MCP 语义工具，复用项目核心命令与存储。
 * 作者：xuanli
 * 创建时间：2026-11-07 19:16:02
 */
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { canvasDoc, readCanvas, writeCanvas, canvasFromDoc } from '../core/canvas';
import { BODY_COLUMN } from '../core/database';
import { childrenOf } from '../core/tree';
import { reservedPropertyName } from '../core/vault/pageFile';
import type { DatabaseDef, PropValue, PageMeta } from '../core/model';
import type { Command } from '../core/commands';
import { canvasSchema, databaseSchema, entityPath, propValueSchema, revisionSchema } from './webSchemas';
import { toolCall } from './webResult';
import { withWebVault, vaultError } from './webVault';
import type { WebVault } from './webVault';

/** 从严格输入补齐新标识，并验证字段、视图和选项引用。 */
function databaseDefinition(
  raw: z.output<typeof databaseSchema>,
  previous?: DatabaseDef | null,
): DatabaseDef {
  /** 缺少新建视图时提供项目支持的默认表格。 */
  const views = raw.views.length
    ? raw.views
    : (previous?.views ?? [
        {
          name: '表格',
          type: 'table' as const,
          filters: [],
          sorts: [],
          groupBy: null,
          dateProp: null,
          hidden: [],
        },
      ]);
  /** 保持现有字段标识，避免修改定义时丢失行属性。 */
  const database: DatabaseDef = {
    properties: raw.properties.map((prop) => {
      /** 显式字段标识优先，交换字段名称时不能误取另一个字段的选项。 */
      const old =
        previous?.properties.find((old) => old.id === prop.id) ??
        previous?.properties.find((old) => old.name.toLowerCase() === prop.name.toLowerCase());
      return {
        ...prop,
        id: prop.id ?? old?.id ?? randomUUID(),
        options: prop.options.map((option) => ({
          ...option,
          id:
            option.id ??
            old?.options.find((old) => old.name.toLowerCase() === option.name.toLowerCase())?.id ??
            randomUUID(),
        })),
      };
    }),
    views: views.map((view) => ({
      ...view,
      id: view.id ?? previous?.views.find((old) => old.name === view.name)?.id ?? randomUUID(),
      filters: view.filters.map((filter) => ({ ...filter, id: filter.id ?? randomUUID() })),
    })),
  };
  /** 字段名和标识均须唯一，保留字段不允许被数据库覆盖。 */
  const names = database.properties.map((prop) => prop.name.toLowerCase());
  if (
    new Set(names).size !== names.length ||
    names.some(reservedPropertyName) ||
    new Set(database.properties.map((prop) => prop.id)).size !== database.properties.length
  )
    throw vaultError(400, '字段名称或标识重复，或使用了页面保留字段。');
  if (database.properties.some((prop) => ['title', 'created', 'updated'].includes(prop.id)))
    throw vaultError(400, '自定义字段不能占用 title、created、updated 内置属性标识。');
  for (const prop of database.properties) {
    if (
      new Set(prop.options.map((option) => option.id)).size !== prop.options.length ||
      new Set(prop.options.map((option) => option.name.toLowerCase())).size !== prop.options.length
    )
      throw vaultError(400, '字段选项的名称和标识必须唯一。');
  }
  /** 视图可以引用数据库字段与项目内置的伪属性。 */
  const properties = new Set(['title', 'created', 'updated', ...database.properties.map((prop) => prop.id)]);
  if (new Set(database.views.map((view) => view.id)).size !== database.views.length)
    throw vaultError(400, '视图标识重复。');
  for (const view of database.views) {
    /** 所有筛选和显示配置都验证引用，避免存下 UI 无法编辑的定义。 */
    const refs = [
      ...view.filters.map((filter) => filter.prop),
      ...view.sorts.map((sort) => sort.prop),
      ...view.hidden,
      ...Object.keys(view.widths ?? {}).filter((id) => id !== BODY_COLUMN),
      ...[view.groupBy, view.dateProp].filter((value): value is string => value !== null),
    ];
    if (refs.some((id) => !properties.has(id))) throw vaultError(400, '视图引用了不存在的字段。');
    if (
      view.dateProp &&
      !database.properties.some((prop) => prop.id === view.dateProp && prop.type === 'date')
    )
      throw vaultError(400, '日历日期字段必须是日期类型。');
  }
  return database;
}

/** 将按字段名称或标识传入的行值映射为核心属性值，拒绝类型错误和未知选项。 */
function rowValues(
  vault: WebVault,
  database: DatabaseDef,
  values: Record<string, PropValue>,
): Record<string, PropValue> {
  /** 只写入明确指定的字段，不改变其他行属性。 */
  const result: Record<string, PropValue> = {};
  for (const [key, value] of Object.entries(values)) {
    /** 标识优先匹配，其次使用精确字段名。 */
    const prop =
      database.properties.find((prop) => prop.id === key) ??
      database.properties.find((prop) => prop.name === key);
    if (!prop || prop.type === 'formula') throw vaultError(400, '字段不存在，或试图写入自动计算的公式字段。');
    if (Object.hasOwn(result, prop.id)) throw vaultError(400, '同一字段不能同时按名称和标识重复赋值。');
    if (value === null || value === '') {
      result[prop.id] = null;
      continue;
    }
    /** 单选和多选均接受返回的选项标识或现有选项名称。 */
    const optionId = (value: string): string => {
      /** 不隐式创建选项，避免调用中的拼写错误改变数据库定义。 */
      const option = prop.options.find((option) => option.id === value || option.name === value);
      if (!option) throw vaultError(400, '字段选项不存在，请先更新数据库定义。');
      return option.id;
    };
    if (prop.type === 'select' && typeof value === 'string') result[prop.id] = optionId(value);
    else if (prop.type === 'multiSelect' && Array.isArray(value))
      result[prop.id] = [...new Set(value.map(optionId))];
    else if (prop.type === 'relation' && Array.isArray(value))
      result[prop.id] = value.map((target) => vault.page(target).id);
    else if (prop.type === 'number' && typeof value === 'number') result[prop.id] = value;
    else if (prop.type === 'checkbox' && typeof value === 'boolean') result[prop.id] = value;
    else if (
      prop.type === 'date' &&
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value
    )
      result[prop.id] = value;
    else if (['text', 'url'].includes(prop.type) && typeof value === 'string') result[prop.id] = value;
    else throw vaultError(400, `字段 ${prop.name} 的值类型不正确。`);
  }
  return result;
}

/** 统一返回数据库定义、真实行路径和当前版本。 */
function describeDatabase(vault: WebVault, page: PageMeta, offset = 0, limit = 100) {
  /** 行列表分页，避免大数据库一次占满 MCP 上下文。 */
  const rows = childrenOf(vault.state.pages, page.id);
  return {
    revision: vault.revision,
    page: vault.describe(page),
    total: rows.length,
    offset,
    rows: rows.slice(offset, offset + limit).map((row) => vault.describe(row)),
  };
}

/** 校验 Canvas 文件目标存在，不把输入错误静默保存成坏链接。 */
function canvasData(vault: WebVault, data: z.output<typeof canvasSchema>) {
  for (const node of data.nodes) {
    if (
      node.type === 'file' &&
      !vault.snapshot.others.includes(node.file) &&
      !Object.values(vault.state.pages).some((page) => vault.repository.pathOf(page.id) === node.file)
    )
      throw vaultError(400, `画布引用的文件不存在：${node.file}`);
  }
  /** 页面引用在内存里使用稳定 ID，保存时由项目写回文件路径。 */
  const canvas = readCanvas(
    data,
    (path) =>
      Object.values(vault.state.pages).find((page) => vault.repository.pathOf(page.id) === path)?.id ?? null,
  );
  if (!canvas) throw vaultError(400, '画布数据无效。');
  return canvas;
}

/** 注册数据库、行和画布工具；每次调用独立加载并检查版本。 */
export function registerStructuredTools(server: McpServer, baseUrl: string): void {
  server.registerTool(
    'create_database',
    {
      description:
        '创建数据库页面。字段可包含文本/数字/单多选/日期/复选框/URL/关联/公式，视图支持表格/看板/日历/列表/画廊。返回稳定字段和选项ID；parent_path 可指定父页面。',
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        parent_path: entityPath.optional(),
        definition: databaseSchema,
        revision: revisionSchema,
      },
    },
    ({ title, parent_path, definition, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 新页面使用项目允许的 UUID，布局交给仓库确定。 */
          const id = randomUUID();
          await vault.execute([
            {
              type: 'page.create',
              id,
              parentId: parent_path ? vault.page(parent_path).id : null,
              title,
              kind: 'database',
              database: databaseDefinition(definition),
              now: Date.now(),
            },
          ]);
          return describeDatabase(vault, vault.state.pages[id]!);
        }),
      ),
  );
  server.registerTool(
    'read_database',
    {
      description: '读取数据库字段/视图定义、分页行的稳定ID/路径/属性和 revision，供下一次修改使用。',
      inputSchema: {
        path: entityPath,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(100),
      },
    },
    ({ path, offset, limit }) =>
      toolCall(() =>
        withWebVault(baseUrl, undefined, async (vault) =>
          describeDatabase(vault, vault.page(path, 'database'), offset, limit),
        ),
      ),
  );
  server.registerTool(
    'update_database',
    {
      description:
        '替换数据库字段和视图定义，更新时保留已有字段/选项/视图ID。修改定义会按 UI 相同规则更新行的前置信息。',
      inputSchema: { path: entityPath, definition: databaseSchema, revision: revisionSchema },
    },
    ({ path, definition, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 核心命令同时更新数据库和子行序列化。 */
          const page = vault.page(path, 'database');
          await vault.execute([
            {
              type: 'database.set',
              id: page.id,
              database: databaseDefinition(definition, page.database),
              now: Date.now(),
            },
          ]);
          return describeDatabase(vault, vault.state.pages[page.id]!);
        }),
      ),
  );
  server.registerTool(
    'create_database_row',
    {
      description:
        '在数据库中创建行页面。values 的键可用字段名称或ID，单多选值可用已有选项名称或ID；公式不可直接赋值。',
      inputSchema: {
        database_path: entityPath,
        title: z.string().trim().min(1).max(500),
        values: z.record(z.string(), propValueSchema).default({}),
        markdown: z.string().optional(),
        revision: revisionSchema,
      },
    },
    ({ database_path, title, values, markdown, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 先完成所有字段校验，再创建任何文件。 */
          const database = vault.page(database_path, 'database');
          /** 新行作为数据库的普通子页面保存。 */
          const id = randomUUID();
          await vault.execute([
            {
              type: 'page.create',
              id,
              parentId: database.id,
              title,
              properties: rowValues(vault, database.database!, values),
              ...(markdown !== undefined ? { doc: vault.markdown(markdown) } : {}),
              now: Date.now(),
            },
          ]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[id]!) };
        }),
      ),
  );
  server.registerTool(
    'update_database_row',
    {
      description:
        '合并修改行属性，未指定的属性和正文保持原样；null 清空属性。可选修改标题，正文通过 write_page 或媒体工具修改。',
      inputSchema: {
        path: entityPath,
        values: z.record(z.string(), propValueSchema),
        title: z.string().trim().min(1).max(500).optional(),
        revision: revisionSchema,
      },
    },
    ({ path, values, title, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 保留行正文，避免为了修改属性而重新解析正文丢失媒体属性。 */
          const page = vault.page(path);
          /** 行必须仍位于有效数据库中。 */
          const database = page.parentId ? vault.state.pages[page.parentId] : null;
          if (!database?.database || database.kind !== 'database')
            throw vaultError(400, '此页面不是数据库行。');
          /** 所有命令先验证，通过后才保存批次。 */
          const commands: Command[] = [
            {
              type: 'page.setProperties',
              id: page.id,
              values: rowValues(vault, database.database, values),
              now: Date.now(),
            },
          ];
          if (title !== undefined)
            commands.push({ type: 'page.rename', id: page.id, title, now: Date.now() });
          await vault.execute(commands);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
        }),
      ),
  );
  server.registerTool(
    'trash_database_row',
    {
      description: '将数据库行移入 UI 回收站，保留恢复能力。',
      inputSchema: { path: entityPath, revision: revisionSchema },
    },
    ({ path, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 避免误将任意普通页面作为行删除。 */
          const page = vault.page(path);
          if (!page.parentId || vault.state.pages[page.parentId]?.kind !== 'database')
            throw vaultError(400, '此页面不是数据库行。');
          await vault.execute([{ type: 'page.trash', id: page.id, now: Date.now() }]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
        }),
      ),
  );
  for (const kind of ['database', 'canvas'] as const) {
    server.registerTool(
      `trash_${kind}`,
      {
        description:
          kind === 'database'
            ? '将数据库及其子行移入 UI 回收站，保留从界面恢复的能力。'
            : '将画布移入 UI 回收站，保留从界面恢复的能力。',
        inputSchema: { path: entityPath, revision: revisionSchema },
      },
      ({ path, revision }) =>
        toolCall(() =>
          withWebVault(baseUrl, revision, async (vault) => {
            /** 复用既有整树回收逻辑，避免只移除数据库文件而遗留行目录。 */
            const page = vault.page(path, kind);
            await vault.execute([{ type: 'page.trash', id: page.id, now: Date.now() }]);
            return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
          }),
        ),
    );
  }
  server.registerTool(
    'create_canvas',
    {
      description:
        '创建 JSON Canvas 画布。支持文字、文件/页面/图片、链接、分组、自由笔画及连线；file 使用库根相对路径。',
      inputSchema: {
        title: z.string().trim().min(1).max(500),
        parent_path: entityPath.optional(),
        canvas: canvasSchema,
        revision: revisionSchema,
      },
    },
    ({ title, parent_path, canvas, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** 画布直接复用项目的标准 .canvas 序列化。 */
          const id = randomUUID();
          await vault.execute([
            {
              type: 'page.create',
              id,
              parentId: parent_path ? vault.page(parent_path).id : null,
              title,
              kind: 'canvas',
              doc: canvasDoc(canvasData(vault, canvas)),
              now: Date.now(),
            },
          ]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[id]!) };
        }),
      ),
  );
  server.registerTool(
    'read_canvas',
    {
      description: '读取画布的 JSON Canvas 节点和连线，页面引用返回文件路径；返回 revision 用于更新。',
      inputSchema: { path: entityPath },
    },
    ({ path }) =>
      toolCall(() =>
        withWebVault(baseUrl, undefined, async (vault) => {
          /** 对外使用通用 JSON Canvas 文件形状，而非内部页面ID节点。 */
          const page = vault.page(path, 'canvas');
          return {
            revision: vault.revision,
            page: vault.describe(page),
            canvas: JSON.parse(
              writeCanvas(canvasFromDoc(vault.state.docs[page.id]), (id) => vault.repository.pathOf(id)),
            ),
          };
        }),
      ),
  );
  server.registerTool(
    'update_canvas',
    {
      description:
        '整体更新画布节点与连线，可添加/移动/缩放/修改/移除节点及连线。先 read_canvas，提交完整结构与其 revision。',
      inputSchema: { path: entityPath, canvas: canvasSchema, revision: revisionSchema },
    },
    ({ path, canvas, revision }) =>
      toolCall(() =>
        withWebVault(baseUrl, revision, async (vault) => {
          /** ID、连线和文件引用先校验，失败时不写任何内容。 */
          const page = vault.page(path, 'canvas');
          await vault.execute([
            { type: 'page.setDoc', id: page.id, doc: canvasDoc(canvasData(vault, canvas)), now: Date.now() },
          ]);
          return { revision: vault.revision, page: vault.describe(vault.state.pages[page.id]!) };
        }),
      ),
  );
}
