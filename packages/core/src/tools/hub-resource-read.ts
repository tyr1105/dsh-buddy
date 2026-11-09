/**
 * 资料读取工具（v2 计划 3.3 / F17）：队友按 resourceId 读取注册资料的正文。
 *
 * 每一次读取都按顺序过四道闸，任何一道不过都返回中文失败并写 resource_read_denied 审计：
 * 1. 资料授权：org/access.ts 的 canRead（归档、不在岗、restricted 无授权都拒），授权口径唯一；
 * 2. 子路径逃逸：目录资料的可选 path 用 posix.resolve 归一后必须仍在资料 locator 子树内，挡掉 ../；
 * 3. 工作数据：再过一道 gate/paths.ts 的 workDataDenied——落在 workDataPaths 且队友未获工作数据
 *    许可时硬拒绝，资料授权不能绕过它（计划 3.3：两者叠加，工作数据规则优先）；
 * 4. 资源上限：文件内容受 RESOURCE_READ_MAX_BYTES 字节限制，链接受超时与字节上限限制。
 * 成功写 resource_read_ok 审计（actor 为 hub），审计 detail 只记元信息，绝不落资料正文。
 */
import { posix } from 'node:path';
import { z } from 'zod';
import type { HubContext } from '../engine/context.js';
import { recordId, text } from '../model/primitives.js';
import { V2_DEFAULTS } from '../config/defaults.js';
import { utf8Prefix } from '../io/utf8-prefix.js';
import { byteLength } from '../util/text.js';
import { writeOutreachAudit } from '../outreach/audit.js';
import { watchGateContext } from '../perception/access.js';
import { within, workDataDenied } from '../gate/paths.js';
import { explainReadDenial, type ResourceAccessData, type ResourceAccessFacts } from '../org/access.js';
import { defineTool } from './common.js';

/** resourceId 必填；path 仅目录资料可用，用来定位目录内的具体文件或子目录。 */
export const HubResourceReadInputSchema = z.strictObject({
  resourceId: recordId('res'),
  path: text.trim().min(1, 'path 不能为空或只有空白').max(1000, 'path 不能超过 1000 字').optional(),
});

/** 拒绝统一落审计：detail 只含 id 与原因，不含 locator 之外的信息、更不含正文。 */
function deny(ctx: HubContext, resourceId: string, botId: string, reason: string, kind?: string): { ok: false; error: string } {
  writeOutreachAudit(ctx, 'resource_read_denied', { resourceId, botId, kind: kind ?? null, reason }, 'hub');
  return { ok: false, error: reason };
}

/** 成功统一落审计并按字节上限收口；超长时在文末标明已截断，截断点保持 UTF-8 字符完整。 */
function ok(ctx: HubContext, resourceId: string, botId: string, kind: string, content: string, maxBytes: number): { ok: true; text: string } {
  const bytes = byteLength(content);
  const capped = bytes > maxBytes ? `${utf8Prefix(content, maxBytes)}\n（已截断，超过 ${maxBytes} 字节）` : content;
  writeOutreachAudit(ctx, 'resource_read_ok', { resourceId, botId, kind, bytes, truncated: bytes > maxBytes }, 'hub');
  return { ok: true, text: capped };
}

/** 目录内子路径解析：拒绝空字符，归一化后必须仍在资料目录子树，挡掉 ../ 与绝对路径逃逸。 */
function resolveWithinDir(resourceLocator: string, subPath: string): string {
  if (subPath.includes('\0')) throw new Error('path 不能包含空字符');
  const joined = posix.resolve(resourceLocator, subPath);
  if (!within(joined, resourceLocator)) {
    throw new Error(`path 不能逃出资料目录：${subPath}`);
  }
  return joined;
}

export const hubResourceRead = defineTool('hub_resource_read',
  '按 resourceId 读取你有权查阅的中心资料正文：文件直接读；目录可给 path 读其中的某个文件或子目录清单，不给 path 则列目录；链接走网络读取。受字节上限与工作数据规则约束。',
  HubResourceReadInputSchema, 'all', async (ctx, tc, args) => {
    const now = ctx.clock.now();
    const facts: ResourceAccessData = {
      bots: ctx.store.table('bots').list(),
      resources: ctx.store.table('resources').list(),
      grants: ctx.store.table('grants').list(),
    };
    const bot = ctx.store.table('bots').get(tc.botId) ?? null;
    const resource = ctx.store.table('resources').get(args.resourceId) ?? null;

    // 第一道闸：资料授权（含归档、不在岗、restricted 无授权）。拒绝原因不暴露 locator 之外的信息。
    const denial = explainReadDenial(bot, resource, facts satisfies ResourceAccessFacts, now);
    if (denial) return deny(ctx, args.resourceId, tc.botId, denial, resource?.kind);
    // bot/resource 非空由 explainReadDenial 已保证；显式判空只是让类型系统放心。
    if (!bot || !resource) return deny(ctx, args.resourceId, tc.botId, '资料不存在或已归档，不能读取');

    // 笔记类型与服务层同口径：本期保守不支持。
    if (resource.kind === 'note') {
      return deny(ctx, resource.id, bot.id, '笔记资料后续版本支持，本期暂不能读取 note 类型资料', 'note');
    }
    // 只有目录资料允许带子路径；文件与链接给 path 都是调用方理解错误，直接中文拒绝。
    if (args.path !== undefined && resource.kind !== 'dir') {
      return deny(ctx, resource.id, bot.id, 'path：只有目录类型资料可以指定子路径', resource.kind);
    }

    // 链接资料：走注入的网络能力，超时与字节上限显式传入，绝不碰真实系统网络。
    if (resource.kind === 'url') {
      try {
        const result = await ctx.net.get(resource.locator, {
          timeoutMs: V2_DEFAULTS.RESOURCE_NET_TIMEOUT_MS,
          maxBytes: V2_DEFAULTS.RESOURCE_READ_MAX_BYTES,
        });
        if (result.status < 200 || result.status >= 300) {
          return deny(ctx, resource.id, bot.id, `读取链接失败：服务端返回 ${result.status}`, 'url');
        }
        return ok(ctx, resource.id, bot.id, 'url', result.text, V2_DEFAULTS.RESOURCE_READ_MAX_BYTES);
      } catch (error) {
        return deny(ctx, resource.id, bot.id,
          `读取链接失败：${error instanceof Error ? error.message : '网络错误'}`, 'url');
      }
    }

    // 文件/目录：定位最终路径。目录不给 path 就读目录根，给 path 必须收敛在目录子树内。
    let target: string;
    let recursive = false;
    if (resource.kind === 'dir') {
      try {
        target = args.path === undefined ? resource.locator : resolveWithinDir(resource.locator, args.path);
      } catch (error) {
        return deny(ctx, resource.id, bot.id, error instanceof Error ? error.message : 'path 非法', 'dir');
      }
      // 目录列举（含递归读整棵子树的语义）会读到子路径，工作数据按递归口径判。
      recursive = true;
    } else {
      target = resource.locator;
    }

    // 第三道闸：工作数据规则优先于资料授权，命中且未获许可就硬拒绝，授权不能绕过。
    const gateCtx = watchGateContext(ctx, bot);
    if (workDataDenied(target, gateCtx, recursive)) {
      return deny(ctx, resource.id, bot.id, '该资料位于尚未允许访问的工作数据目录，资料授权不能绕过工作数据规则', resource.kind);
    }

    const maxBytes = V2_DEFAULTS.RESOURCE_READ_MAX_BYTES;
    if (resource.kind === 'dir') {
      const stat = await ctx.fs.stat(target);
      if (!stat) return deny(ctx, resource.id, bot.id, `资料路径不存在：${args.path ?? ''}`, 'dir');
      if (stat.isDir) {
        // 目录不回正文，只回直接子项清单；仍走统一字节收口，防止超大目录撑爆回合上下文。
        const entries = await ctx.fs.list(target);
        return ok(ctx, resource.id, bot.id, 'dir',
          `目录 ${target} 的内容（${entries.length} 项）：\n${entries.map(name => `- ${name}`).join('\n')}`, maxBytes);
      }
      const text2 = await ctx.fs.readText(target);
      if (text2 === null) return deny(ctx, resource.id, bot.id, `资料文件不存在或已移动：${args.path ?? ''}`, 'dir');
      return ok(ctx, resource.id, bot.id, 'dir', `文件 ${target}：\n${text2}`, maxBytes);
    }

    // kind === 'file'
    const content = await ctx.fs.readText(target);
    if (content === null) return deny(ctx, resource.id, bot.id, '资料文件不存在或已移动', 'file');
    return ok(ctx, resource.id, bot.id, 'file', content, maxBytes);
  });
