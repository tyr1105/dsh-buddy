/**
 * 释放工具只能解除自己的资源认领，已到期的锁按已经释放处理。
 * P74b 起不再注册为工具（与 hub_claim 一起移除）；文件保留，认领表与过期处理仍在用。
 */
import { z } from 'zod';
import { release } from '../peer/claims.js';
import { defineTool, requiredText } from './common.js';
export const ReleaseInputSchema = z.strictObject({ resource: requiredText });
export const hubRelease = defineTool('hub_release', '不再负责某项资源时释放 resource；只能释放自己的有效认领锁，不能解除同伴的锁。', ReleaseInputSchema, 'L1', (ctx, tc, args) => ({ ok: true, text: release(ctx, tc.botId, args.resource) ? '认领锁已释放' : '该资源没有自己的有效认领锁' }));
