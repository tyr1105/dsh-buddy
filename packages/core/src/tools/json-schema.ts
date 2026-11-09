/** 工具 Schema 适配：保留参数约束，把模型接口难以识别的引用与可空联合整理成直接可读的字段。 */
import { z } from 'zod';

type SchemaNode = Record<string, unknown>;
const rootCombinators = ['oneOf', 'anyOf', 'allOf', 'not', 'if'];
const schemaMaps = new Set(['properties', 'patternProperties', 'dependentSchemas']);
const schemaChildren = new Set(['items', 'additionalProperties', 'unevaluatedProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames']);
const schemaLists = new Set(['oneOf', 'anyOf', 'allOf', 'prefixItems']);
const annotations = new Set(['title', 'description', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly', '$comment']);
// 这些约束仅作用于其对应类型；未知或复合约束可能也约束 null，保留 anyOf 才不改变含义。
const nullableSafeConstraints = new Set(['type', 'enum', 'minLength', 'maxLength', 'pattern', 'format',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'properties', 'patternProperties', 'required', 'additionalProperties', 'unevaluatedProperties',
  'dependentRequired', 'dependentSchemas', 'minProperties', 'maxProperties',
  'items', 'prefixItems', 'contains', 'minContains', 'maxContains', 'minItems', 'maxItems', 'uniqueItems']);

/** 仅识别对象，不把默认值、枚举成员或示例正文误当成 Schema 改写。 */
function isObject(value: unknown): value is SchemaNode {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 导出时优先直接内联重复定义；循环类型无法有限内联，明确拒绝而不是悄悄放宽参数。 */
export function toolJsonSchema(schema: z.ZodType): SchemaNode {
  return normalizeToolJsonSchema(z.toJSONSchema(schema, { reused: 'inline', cycles: 'throw' }));
}

/** 处理完整 JSON Schema 文档；保留运行时 Zod 校验，根参数必须显式声明对象和字段。 */
export function normalizeToolJsonSchema(document: SchemaNode): SchemaNode {
  /** 只允许当前文档的引用；外部和循环引用不能在本地可靠展开，直接报告配置错误。 */
  function resolveReference(reference: string): SchemaNode {
    if (!reference.startsWith('#/')) throw new Error(`工具 Schema 不支持外部引用：${reference}`);
    let value: unknown = document;
    for (const part of reference.slice(2).split('/')) {
      const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
      value = isObject(value) ? value[key] : undefined;
    }
    if (!isObject(value)) throw new Error(`工具 Schema 引用不存在：${reference}`);
    return value;
  }

  /** 只遍历 Schema 关键字；字段名可叫 $ref，默认正文也可含同名键，均不得被误删。 */
  function visit(value: unknown, references: string[] = []): unknown {
    if (!isObject(value)) return value;
    let source = value;
    if (typeof value.$ref === 'string') {
      if (references.includes(value.$ref)) throw new Error(`工具 Schema 不能内联循环引用：${value.$ref}`);
      const target = visit(resolveReference(value.$ref), [...references, value.$ref]) as SchemaNode;
      const { $ref: _reference, ...siblings } = value;
      // 引用旁的注释和默认值可覆盖；重复的约束必须逐项一致，避免合并时遗失约束。
      for (const [key, sibling] of Object.entries(siblings)) {
        if (!['title', 'description', 'default', 'examples', '$defs', '$schema'].includes(key)
          && key in target && JSON.stringify(target[key]) !== JSON.stringify(sibling)) {
          throw new Error(`工具 Schema 引用旁的 ${key} 约束冲突，不能安全内联`);
        }
      }
      source = { ...target, ...siblings };
    }
    const result: SchemaNode = {};
    for (const [key, child] of Object.entries(source)) {
      if (['$schema', '$defs', '$ref', 'propertyNames'].includes(key)) continue;
      if (schemaMaps.has(key) && isObject(child)) {
        result[key] = Object.fromEntries(Object.entries(child).map(([name, field]) => [name, visit(field, references)]));
      } else if (schemaChildren.has(key)) {
        result[key] = visit(child, references);
      } else if (schemaLists.has(key) && Array.isArray(child)) {
        result[key] = child.map(field => visit(field, references));
      } else result[key] = child;
    }
    // nullable 的普通类型用 type 数组表示；枚举同时补 null，保持原来的允许值集合。
    const branches = result.anyOf;
    if (Array.isArray(branches) && branches.length === 2 && branches.every(isObject)) {
      const nullable = branches.find(branch => branch.type === 'null' && Object.keys(branch).length === 1);
      const content = branches.find(branch => branch !== nullable);
      const outerHasOnlyAnnotations = Object.keys(result).every(key => key === 'anyOf' || annotations.has(key));
      const branchHasOnlySafeConstraints = content && Object.keys(content).every(key => annotations.has(key) || nullableSafeConstraints.has(key));
      if (nullable && content && typeof content.type === 'string' && content.type !== 'null'
        && outerHasOnlyAnnotations && branchHasOnlySafeConstraints) {
        delete result.anyOf;
        return { ...content, ...result, type: [content.type, 'null'],
          ...(Array.isArray(content.enum) ? { enum: [...content.enum, null] } : {}) };
      }
    }
    return result;
  }

  const result = visit(document) as SchemaNode;
  if (result.type !== 'object' || !isObject(result.properties) || rootCombinators.some(key => key in result)) {
    throw new Error('工具 Schema 根节点必须是含 properties 的对象，不能使用联合或条件分支');
  }
  return result;
}
