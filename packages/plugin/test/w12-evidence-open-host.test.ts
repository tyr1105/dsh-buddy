/**
 * W12 的测试：宿主一侧的「打开卡片上的文件 / 在访达中显示」（命令 openJobEvidence）。
 *
 * 重点：只打开 core 查过后给出的路径，界面传来的路径一律忽略；优先用 DSH 自带的 openWorkspacePath，
 * 它报错时退回系统命令（参数数组，不经过 shell）；宿主再查一次（普通文件、不是符号链接、扩展名在放行名单里）；
 * core 返回错误时什么都不调用。系统程序和 DSH 接口一律用替身。
 */
import { describe, expect, it } from 'vitest'
import type { UiApi } from '@agent-hub/core'
import { OPEN_FAILED_TEXT, dispatchCommand, revealCommandFor, type OpenDeps, type PreviewFiles } from '../src/host/real-hub.js'
import { hostFileOpener } from '../src/host/index.js'

const MD = '/中心/projects/prj_1/jobs/job_1/交付/现状梳理与下一步建议.md'
const INPUT = { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1' }

function fakeFiles(lstat: Record<string, { isFile: boolean; isSymlink: boolean } | null> = {}): PreviewFiles {
  return { lstat: path => (path in lstat ? lstat[path]! : { isFile: true, isSymlink: false }), realpath: path => path }
}

function env(opts: { host?: 'ok' | 'fail' | 'none'; exec?: 'ok' | 'fail'; files?: PreviewFiles; platform?: NodeJS.Platform } = {}) {
  const execCalls: Array<{ file: string; args: string[] }> = []
  const hostCalls: unknown[] = []
  const deps: OpenDeps = {
    platform: opts.platform ?? 'darwin',
    files: opts.files ?? fakeFiles(),
    execFile: (file, args, _options, callback) => { execCalls.push({ file, args }); callback(opts.exec === 'fail' ? new Error('exit 1') : null); return undefined },
    ...(opts.host === 'none' ? {} : {
      hostOpen: async (request: { path: string; action?: 'reveal' }) => { hostCalls.push(request); if (opts.host === 'fail') throw new Error('no verified Host mapping') },
    }),
  }
  return { deps, execCalls, hostCalls }
}

function fakeApi(result: unknown) {
  const seen: unknown[] = []
  const api = { jobEvidenceOpenTarget: async (input: unknown) => { seen.push(input); return result } } as unknown as UiApi
  return { api, seen }
}

describe('openJobEvidence', () => {
  it('优先交给 DSH 自带的打开：用默认应用打开不带 action，在访达中显示带 reveal；不调用系统命令', async () => {
    const e = env()
    const { api, seen } = fakeApi({ ok: true, data: { path: MD, action: 'open' } })
    expect(await dispatchCommand(api, 'openJobEvidence', { ...INPUT, action: 'open', path: '/etc/passwd' }, e.deps)).toEqual({ ok: true, path: MD })
    expect(seen).toEqual([{ ...INPUT, action: 'open' }])
    expect(e.hostCalls).toEqual([{ path: MD }])
    const r = fakeApi({ ok: true, data: { path: MD, action: 'reveal' } })
    expect(await dispatchCommand(r.api, 'openJobEvidence', { ...INPUT, action: 'reveal' }, e.deps)).toEqual({ ok: true, path: MD })
    expect(e.hostCalls[1]).toEqual({ path: MD, action: 'reveal' })
    expect(e.execCalls).toEqual([])
  })

  it('动作不是 reveal 的一律按「打开」请 core 查（core 再按放行名单把关）', async () => {
    const e = env()
    const { api, seen } = fakeApi({ ok: true, data: { path: MD, action: 'open' } })
    await dispatchCommand(api, 'openJobEvidence', { ...INPUT, action: 'run' }, e.deps)
    expect(seen).toEqual([{ ...INPUT, action: 'open' }])
  })

  it('DSH 拒绝或没有这个接口：退回系统命令 open / open -R，目标是单独的一个参数', async () => {
    for (const host of ['fail', 'none'] as const) {
      const e = env({ host })
      expect(await dispatchCommand(fakeApi({ ok: true, data: { path: MD, action: 'open' } }).api, 'openJobEvidence', { ...INPUT, action: 'open' }, e.deps)).toEqual({ ok: true, path: MD })
      expect(await dispatchCommand(fakeApi({ ok: true, data: { path: MD, action: 'reveal' } }).api, 'openJobEvidence', { ...INPUT, action: 'reveal' }, e.deps)).toEqual({ ok: true, path: MD })
      expect(e.execCalls, host).toEqual([{ file: 'open', args: [MD] }, { file: 'open', args: ['-R', MD] }])
    }
  })

  it('两条路都失败：返回路径和「可以复制路径」的说明，不抛出', async () => {
    const e = env({ host: 'fail', exec: 'fail' })
    expect(await dispatchCommand(fakeApi({ ok: true, data: { path: MD, action: 'open' } }).api, 'openJobEvidence', { ...INPUT, action: 'open' }, e.deps))
      .toEqual({ ok: false, path: MD, error: OPEN_FAILED_TEXT })
  })

  it('core 返回错误：原样返回，什么都不调用', async () => {
    const e = env()
    expect(await dispatchCommand(fakeApi({ ok: false, error: '找不到这个文件' }).api, 'openJobEvidence', { ...INPUT, action: 'open' }, e.deps)).toEqual({ ok: false, error: '找不到这个文件' })
    expect(e.hostCalls).toEqual([])
    expect(e.execCalls).toEqual([])
  })

  it('宿主第二道检查：能运行的文件不打开（但可以显示位置）、符号链接、不存在、相对路径、以 - 开头、控制字符一律不调用', async () => {
    const cmd = '/中心/交付/run.command'
    const cases: Array<{ path: string; action: 'open' | 'reveal'; files?: PreviewFiles }> = [
      { path: cmd, action: 'open' },
      { path: MD, action: 'open', files: fakeFiles({ [MD]: { isFile: true, isSymlink: true } }) },
      { path: MD, action: 'reveal', files: fakeFiles({ [MD]: null }) },
      { path: MD, action: 'open', files: fakeFiles({ [MD]: { isFile: false, isSymlink: false } }) },
      { path: '交付/a.md', action: 'open' },
      { path: '-a.md', action: 'open' },
      { path: '/中心/a\n.md', action: 'open' },
    ]
    for (const c of cases) {
      const e = env({ files: c.files })
      const result = await dispatchCommand(fakeApi({ ok: true, data: { path: c.path, action: c.action } }).api, 'openJobEvidence', { ...INPUT, action: c.action }, e.deps)
      expect(result, c.path).toEqual({ ok: false, path: c.path, error: OPEN_FAILED_TEXT })
      expect(e.hostCalls, c.path).toEqual([])
      expect(e.execCalls, c.path).toEqual([])
    }
    const e = env()
    expect(await dispatchCommand(fakeApi({ ok: true, data: { path: cmd, action: 'reveal' } }).api, 'openJobEvidence', { ...INPUT, action: 'reveal' }, e.deps)).toEqual({ ok: true, path: cmd })
  })

  it('各系统的「显示位置」命令', () => {
    expect(revealCommandFor('darwin', MD)).toEqual({ file: 'open', args: ['-R', MD] })
    expect(revealCommandFor('win32', 'C:\\a\\b.md')).toEqual({ file: 'explorer.exe', args: ['/select,C:\\a\\b.md'] })
    expect(revealCommandFor('linux', '/a/b/c.md')).toEqual({ file: 'xdg-open', args: ['/a/b'] })
  })
})

describe('hostFileOpener：取 DSH 的 openWorkspacePath', () => {
  it('按方法调用（保留 this），把请求和一个信号交过去；没有这个接口时返回 undefined', async () => {
    const seen: unknown[] = []
    const sc = { tag: 'sc', async openWorkspacePath(this: { tag: string }, request: unknown, signal: unknown) { seen.push([this.tag, request, signal instanceof AbortSignal]) } }
    const opener = hostFileOpener({ sessionController: sc })
    await opener!({ path: MD, action: 'reveal' })
    expect(seen).toEqual([['sc', { path: MD, action: 'reveal' }, true]])
    expect(hostFileOpener({ sessionController: {} })).toBeUndefined()
    expect(hostFileOpener({})).toBeUndefined()
  })
})
