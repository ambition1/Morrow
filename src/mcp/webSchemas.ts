/**
 * 功能：校验 MCP 的数据库、JSON Canvas 和媒体输入，拒绝静默丢弃或截断用户结构。
 * 作者：xuanli
 * 创建时间：2026-11-07 19:16:02
 */
import { z } from 'zod';
import { BODY_COLUMN } from '../core/database';
import { OPTION_COLORS, OPTION_HEX_PATTERN, PROP_TYPES, VIEW_TYPES } from '../core/model';

/** 对外只接受库内普通路径，内部注册表和回收站不能由客户端任意指定。 */
export const entityPath = z
  .string()
  .min(1)
  .max(1000)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      ![...value].some((character) => character.charCodeAt(0) < 32) &&
      value.split('/').every((part) => part.length > 0 && !part.startsWith('.')),
    '必须使用库内普通相对路径。',
  );
/** 附件只能位于库内统一的附件目录。 */
export const attachmentPath = entityPath.refine(
  (value) => value.startsWith('attachments/') && !/\.(md|markdown|canvas)$/i.test(value),
  '附件必须位于 attachments/，Markdown 和 Canvas 请使用页面工具。',
);
/** 每个写入工具都显式提交先前读取时的版本。 */
export const revisionSchema = z.string().min(1);
/** 标识限制与项目核心一致。 */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/)
  .refine((value) => !['__proto__', 'constructor', 'prototype'].includes(value), '不允许使用保留标识。');
/** 属性值与现有数据库模型一致。 */
export const propValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()).max(500),
  z.null(),
]);
/** 字段与选项可省略新标识，由服务端生成；更新时需保留原标识。 */
export const propertySchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(200),
    type: z.enum(PROP_TYPES),
    options: z
      .array(
        z.object({
          id: idSchema.optional(),
          name: z.string().trim().min(1).max(200),
          color: z
            .union([
              z.enum(OPTION_COLORS),
              z.templateLiteral(['#', z.string()]).refine((value) => OPTION_HEX_PATTERN.test(value)),
            ])
            .default('gray'),
        }),
      )
      .max(200)
      .default([]),
    formula: z.string().max(2000).optional(),
    display: z.literal('bar').optional(),
    max: z.number().positive().finite().optional(),
  })
  .strict();
/** 视图包含与 UI 相同的筛选、排序、分组与列宽配置。 */
export const viewSchema = z
  .object({
    id: idSchema.optional(),
    name: z.string().trim().min(1).max(200),
    type: z.enum(VIEW_TYPES),
    filters: z
      .array(
        z.object({
          id: idSchema.optional(),
          prop: idSchema,
          op: z.enum([
            'contains',
            'notContains',
            'is',
            'isNot',
            'empty',
            'notEmpty',
            'gt',
            'lt',
            'checked',
            'unchecked',
          ]),
          value: propValueSchema,
        }),
      )
      .max(100)
      .default([]),
    sorts: z
      .array(z.object({ prop: idSchema, dir: z.enum(['asc', 'desc']) }))
      .max(100)
      .default([]),
    groupBy: idSchema.nullable().default(null),
    dateProp: idSchema.nullable().default(null),
    hidden: z.array(idSchema).max(200).default([]),
    // 与界面共享视图布局字段，允许读取结果直接回传。
    columnOrder: z
      .array(z.union([idSchema, z.literal(BODY_COLUMN)]))
      .max(202)
      .optional(),
    showBody: z.boolean().optional(),
    groupDirection: z.enum(['asc', 'desc']).optional(),
    collapsedGroups: z.array(z.string()).optional(),
    widths: z.record(z.string(), z.number().int().min(80).max(1200)).optional(),
  })
  .strict();
/** 数据库结构不接受额外字段，避免调用者误以为未知配置已保存。 */
export const databaseSchema = z
  .object({ properties: z.array(propertySchema).max(200), views: z.array(viewSchema).max(50).default([]) })
  .strict();
/** JSON Canvas 颜色使用项目支持的预设或十六进制颜色。 */
const canvasColor = z.string().regex(/^(?:[1-6]|#[0-9a-fA-F]{3,8})$/);
/** 坐标、尺寸与项目画布读取器保持同一范围。 */
const canvasBase = {
  id: idSchema,
  x: z.number().finite().min(-1e7).max(1e7),
  y: z.number().finite().min(-1e7).max(1e7),
  width: z.number().min(20).max(1e7),
  height: z.number().min(20).max(1e7),
  color: canvasColor.optional(),
};
/** 节点支持文字、页面或附件文件、链接、分组和项目自由笔画。 */
const canvasNode = z.discriminatedUnion('type', [
  z.object({ ...canvasBase, type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({ ...canvasBase, type: z.literal('file'), file: entityPath, subpath: z.string().optional() })
    .strict(),
  z
    .object({
      ...canvasBase,
      type: z.literal('link'),
      url: z
        .string()
        .url()
        .refine((value) => /^https?:\/\//i.test(value), '链接必须使用 HTTP 或 HTTPS。'),
    })
    .strict(),
  z.object({ ...canvasBase, type: z.literal('group'), label: z.string().optional() }).strict(),
  z
    .object({
      ...canvasBase,
      type: z.literal('drawing'),
      strokes: z
        .array(
          z
            .object({
              points: z
                .array(z.number().finite())
                .min(4)
                .max(40000)
                .refine((value) => value.length % 2 === 0, '笔画坐标必须成对。'),
              width: z.number().positive().max(80),
              color: canvasColor.optional(),
              highlighter: z.boolean().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(2000),
    })
    .strict(),
]);
/** 连线只能连接本画布中的有效节点。 */
const canvasEdge = z
  .object({
    id: idSchema,
    fromNode: idSchema,
    toNode: idSchema,
    fromSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    toSide: z.enum(['top', 'right', 'bottom', 'left']).optional(),
    fromEnd: z.enum(['none', 'arrow']).optional(),
    toEnd: z.enum(['none', 'arrow']).optional(),
    color: canvasColor.optional(),
    label: z.string().optional(),
  })
  .strict();
/** 严格验证唯一标识和连线端点，拒绝读取器会静默丢掉的错误节点。 */
export const canvasSchema = z
  .object({ nodes: z.array(canvasNode).max(5000), edges: z.array(canvasEdge).max(10000) })
  .strict()
  .superRefine((value, context) => {
    /** 节点与连线分别使用独立标识集合。 */
    const nodes = new Set(value.nodes.map((node) => node.id));
    if (
      nodes.size !== value.nodes.length ||
      new Set(value.edges.map((edge) => edge.id)).size !== value.edges.length
    )
      context.addIssue({ code: 'custom', message: '画布节点或连线标识重复。' });
    if (value.edges.some((edge) => !nodes.has(edge.fromNode) || !nodes.has(edge.toNode)))
      context.addIssue({ code: 'custom', message: '连线引用了不存在的节点。' });
  });
/** 图片属性与已有图片设置面板一致；省略字段表示保留原值。 */
export const imageSettings = {
  alt: z.string().max(2000).optional(),
  caption: z.string().max(2000).optional(),
  width: z
    .number()
    .int()
    .min(10)
    .max(100)
    .nullable()
    .optional()
    .describe('图片占正文宽度的百分比，10至100；null恢复默认宽度。'),
  align: z.enum(['left', 'center', 'right']).optional(),
};
