/**
 * P74g 的测试：宿主一侧的两个只读命令（readJobEvidence、openJobPreview）。
 *
 * 重点：打开预览只打开 core 返回的目标，不接受界面传来的任何路径或地址；调用系统程序用参数数组、不经过 shell；
 * 目标作为单独的一个参数；打不开时返回 ok:false 和目标；core 返回错误时不调用系统程序。
 * 系统程序一律用替身（execFile 的替身），测试里不会真的打开任何程序或地址。
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { UiApi } from '@agent-hub/core'
import { OPEN_FAILED_TEXT, dispatchCommand, openCommandFor, openTarget, type OpenDeps, type PreviewFiles } from '../src/host/real-hub.js'

/** 测试里的中心预览目录和其中的一个副本文件（P74r4b：宿主只打开预览目录里的 .html 普通文件）。 */
const PREVIEW_ROOT = '/中心/.hub/preview'
const COPY = `${PREVIEW_ROOT}/job_0000000001/abc123/index.html`

/** 文件操作的替身：默认所有路径都是普通文件、真实路径等于自己；可以按路径覆盖。 */
function fakeFiles(overrides: { lstat?: Record<string, { isFile: boolean; isSymlink: boolean } | null>; real?: Record<string, string> } = {}): PreviewFiles {
  return {
    lstat: path => (path in (overrides.lstat ?? {}) ? overrides.lstat![path]! : { isFile: true, isSymlink: false }),
    realpath: path => overrides.real?.[path] ?? path,
  }
}

/** 记录每次调用的 execFile 替身。fail 为真时用错误回调；throws 为真时直接抛出。 */
function fakeExec(mode: 'ok' | 'fail' | 'throws' = 'ok', platform: NodeJS.Platform = 'darwin', files: PreviewFiles = fakeFiles()) {
  const calls: Array<{ file: string; args: string[]; options: Record<string, unknown> }> = []
  const deps: OpenDeps = {
    platform,
    previewRoot: PREVIEW_ROOT,
    files,
    execFile: (file, args, options, callback) => {
      calls.push({ file, args, options: options as unknown as Record<string, unknown> })
      if (mode === 'throws') throw new Error('spawn open ENOENT')
      callback(mode === 'fail' ? new Error('exit 1') : null)
      return undefined
    },
  }
  return { calls, deps }
}

/** core 的两个只读命令的替身。 */
function fakeApi(preview: unknown, evidence: unknown = { ok: true, data: { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' } }) {
  const seen: { preview: unknown[]; evidence: unknown[] } = { preview: [], evidence: [] }
  const api = {
    jobPreviewTarget: async (input: unknown) => { seen.preview.push(input); return preview },
    readJobEvidence: async (input: unknown) => { seen.evidence.push(input); return evidence },
  } as unknown as UiApi
  return { api, seen }
}

describe('openJobPreview：只打开 core 返回的目标', () => {
  it('文件：只调用一次系统程序，程序名和参数是数组，目标是单独的一个参数；界面传来的路径和地址被忽略', async () => {
    const { calls, deps } = fakeExec()
    // 预期已改（P74r4b）：core 返回的是预览副本，不再是主题文件夹里的原文件。
    const { api, seen } = fakeApi({ ok: true, data: { kind: 'file', path: COPY } })
    const result = await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001', path: '/etc/passwd', url: 'http://example.com', target: '/bin/sh' }, deps)
    expect(result).toEqual({ ok: true, path: COPY })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ file: 'open', args: [COPY] })
    expect(Array.isArray(calls[0]!.args)).toBe(true)
    // 不经过 shell：没有 shell 选项，程序名不是 sh、bash、cmd。
    expect(calls[0]!.options).not.toHaveProperty('shell')
    expect(['sh', 'bash', 'zsh', 'cmd', 'cmd.exe']).not.toContain(calls[0]!.file)
    // 传给 core 的只有 jobId。
    expect(seen.preview).toEqual([{ jobId: 'job_0000000001' }])
  })

  it('地址：同样只打开 core 返回的地址；带 & 和空格的查询串原样作为一个参数，不被拆开', async () => {
    const { calls, deps } = fakeExec()
    const url = 'http://localhost:5173/?a=1&b=2%20x'
    const { api } = fakeApi({ ok: true, data: { kind: 'url', url } })
    expect(await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps)).toEqual({ ok: true, path: url })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args).toEqual([url])
  })

  it('execFile 抛错、或回调带错误：返回 ok:false 和目标，不抛出', async () => {
    for (const mode of ['throws', 'fail'] as const) {
      const { calls, deps } = fakeExec(mode)
      const { api } = fakeApi({ ok: true, data: { kind: 'file', path: COPY } })
      expect(await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps), mode)
        .toEqual({ ok: false, path: COPY, error: '没能自动打开，可以复制这个路径自己打开' })
      expect(calls, mode).toHaveLength(1)
    }
    expect(OPEN_FAILED_TEXT).toBe('没能自动打开，可以复制这个路径自己打开')
  })

  it('core 返回错误：原样返回，不调用系统程序', async () => {
    const { calls, deps } = fakeExec()
    const { api } = fakeApi({ ok: false, error: '预览地址不是本机地址，不能打开' })
    expect(await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps)).toEqual({ ok: false, error: '预览地址不是本机地址，不能打开' })
    expect(calls).toHaveLength(0)
  })

  it('缺 jobId：中文错误，不进 core、不调用系统程序', async () => {
    const { calls, deps } = fakeExec()
    const { api, seen } = fakeApi({ ok: true, data: { kind: 'file', path: '/x/y.html' } })
    const result = await dispatchCommand(api, 'openJobPreview', { path: '/x/y.html' }, deps)
    expect(result.ok).toBe(false)
    expect(seen.preview).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  it('core 的替身即使返回了异常的目标（以 - 开头、含换行、不是绝对路径、不是 http 地址）：宿主也不打开', async () => {
    const bad: Array<{ kind: 'file' | 'url'; path?: string; url?: string }> = [
      { kind: 'file', path: '-a' }, { kind: 'file', path: '相对/路径.html' }, { kind: 'file', path: '/a\n/b.html' }, { kind: 'file', path: '' },
      { kind: 'url', url: 'file:///etc/passwd' }, { kind: 'url', url: 'javascript:alert(1)' }, { kind: 'url', url: '--help' },
    ]
    for (const target of bad) {
      const { calls, deps } = fakeExec()
      const { api } = fakeApi({ ok: true, data: target })
      const result = await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps)
      expect(result, JSON.stringify(target)).toMatchObject({ ok: false, error: OPEN_FAILED_TEXT })
      expect(calls, JSON.stringify(target)).toHaveLength(0)
    }
  })

  it('P74i-m2（低-5）地址的第二道检查：主机必须是本机（按解析后的主机名判断），localhost.evil.example、127.0.0.1@evil.example 不打开，127.0.0.1:5173 打开', async () => {
    for (const url of ['http://localhost.evil.example/', 'http://127.0.0.1@evil.example/', 'https://evil.example/', 'http://[::1]@evil.example/']) {
      const { calls, deps } = fakeExec()
      const { api } = fakeApi({ ok: true, data: { kind: 'url', url } })
      const result = await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps)
      expect(result, url).toMatchObject({ ok: false, error: OPEN_FAILED_TEXT })
      expect(calls, url).toHaveLength(0)
    }
    for (const url of ['http://127.0.0.1:5173/', 'https://localhost/a.html', 'http://[::1]:5173/']) {
      const { calls, deps } = fakeExec()
      const { api } = fakeApi({ ok: true, data: { kind: 'url', url } })
      expect(await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, deps), url).toEqual({ ok: true, path: url })
      expect(calls, url).toHaveLength(1)
    }
  })

  it('三种系统的命令：macOS open、Windows rundll32（不用 cmd，避免 & 被当成命令分隔）、Linux xdg-open，目标都是参数数组里单独的一项', () => {
    expect(openCommandFor('darwin', '/a/b.html')).toEqual({ file: 'open', args: ['/a/b.html'] })
    expect(openCommandFor('linux', 'http://localhost:3000/')).toEqual({ file: 'xdg-open', args: ['http://localhost:3000/'] })
    expect(openCommandFor('win32', 'C:\\a\\b.html')).toEqual({ file: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'C:\\a\\b.html'] })
  })

  it('openTarget 直接调用：macOS、Linux 都只调用一次、不抛出；地址三个系统都可以', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const { calls, deps } = fakeExec('ok', platform)
      expect(await openTarget('file', COPY, deps)).toEqual({ ok: true, path: COPY })
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args.at(-1)).toBe(COPY)
    }
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      const { calls, deps } = fakeExec('ok', platform)
      expect(await openTarget('url', 'http://localhost:3000/', deps)).toEqual({ ok: true, path: 'http://localhost:3000/' })
      expect(calls).toHaveLength(1)
    }
  })

  // 预期已改（P74r4b 第 4 节）：原来这里还有 Windows 打开文件的一条。Windows 上路径用反斜杠，
  // 宿主的「在预览目录之内」检查按斜杠写法比较，文件预览在 Windows 上被拒绝（功能不可用，不越界）。
  it('Windows 上文件预览被拒绝：不调用系统程序（已知限制）', async () => {
    const { calls, deps } = fakeExec('ok', 'win32')
    const target = 'C:\\中心\\.hub\\preview\\job_0000000001\\abc\\index.html'
    expect(await openTarget('file', target, deps)).toMatchObject({ ok: false, error: OPEN_FAILED_TEXT })
    expect(calls).toHaveLength(0)
  })
})

describe('P74r4b 宿主打开之前再查一次目标：不满足就不打开', () => {
  const refuse = async (target: string, files: PreviewFiles, label: string, previewRoot: string | null = PREVIEW_ROOT) => {
    const { calls, deps } = fakeExec('ok', 'darwin', files)
    const { api } = fakeApi({ ok: true, data: { kind: 'file', path: target } })
    const result = await dispatchCommand(api, 'openJobPreview', { jobId: 'job_0000000001' }, { ...deps, previewRoot: previewRoot ?? undefined } as OpenDeps)
    expect(result, label).toMatchObject({ ok: false, error: OPEN_FAILED_TEXT })
    expect(calls, label).toHaveLength(0)
  }

  it('目标不在预览目录之内：别的目录、前缀相同的兄弟目录、预览目录本身', async () => {
    await refuse('/项目/jobs/job_0000000001/交付/index.html', fakeFiles(), '主题文件夹里的原文件')
    await refuse('/中心/.hub/preview-other/job_0000000001/index.html', fakeFiles(), '前缀相同的兄弟目录')
    await refuse('/中心/.hub/preview.html', fakeFiles(), '预览目录同名的文件')
    await refuse('/中心/.hub/preview/../state/index.html', fakeFiles({ real: { '/中心/.hub/preview/../state/index.html': '/中心/.hub/state/index.html' } }), '上级目录写法')
  })

  it('目标的真实路径在预览目录之外（路径上有指向外面的目录链接）：不打开', async () => {
    await refuse(COPY, fakeFiles({ real: { [COPY]: '/外面/index.html' } }), '真实路径在外面')
  })

  it('目标是符号链接、不是普通文件、不存在：不打开', async () => {
    // 符号链接单独判断（即使信息里同时写着是普通文件，也不打开）。
    await refuse(COPY, fakeFiles({ lstat: { [COPY]: { isFile: true, isSymlink: true } } }), '符号链接')
    await refuse(COPY, fakeFiles({ lstat: { [COPY]: { isFile: false, isSymlink: false } } }), '文件夹')
    await refuse(COPY, fakeFiles({ lstat: { [COPY]: null } }), '不存在')
  })

  it('扩展名不是 .html、.htm：不打开（大写可以）', async () => {
    for (const name of ['a.txt', 'a.command', 'a.app', 'a', 'a.html.sh', 'a.js']) await refuse(`${PREVIEW_ROOT}/job_0000000001/abc/${name}`, fakeFiles(), name)
    const { calls, deps } = fakeExec()
    expect(await openTarget('file', `${PREVIEW_ROOT}/job_0000000001/abc/A.HTM`, deps)).toMatchObject({ ok: true })
    expect(calls).toHaveLength(1)
  })

  it('没有给出预览目录、检查时出错：不打开', async () => {
    await refuse(COPY, fakeFiles(), '没有预览目录', null)
    await refuse(COPY, { lstat: () => { throw new Error('没有权限') }, realpath: p => p }, 'lstat 出错')
    await refuse(COPY, { lstat: () => ({ isFile: true, isSymlink: false }), realpath: () => { throw new Error('循环链接') } }, 'realpath 出错')
  })

  it('用真实文件系统：预览目录里的 .html 可以打开；指向外面的符号链接、路径上有目录链接的不打开（测试结束删除临时目录）', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'p74r4b-host-')))
    try {
      const root = join(base, 'preview')
      mkdirSync(join(root, 'job', 'abc'), { recursive: true })
      mkdirSync(join(base, 'outside'))
      writeFileSync(join(root, 'job', 'abc', 'index.html'), '<html></html>')
      writeFileSync(join(base, 'outside', 'x.html'), '<html>外面</html>')
      symlinkSync(join(base, 'outside', 'x.html'), join(root, 'job', 'abc', 'link.html'))
      symlinkSync(join(base, 'outside'), join(root, 'job', 'dirlink'))
      const run = async (target: string) => {
        const { calls, deps } = fakeExec()
        const result = await openTarget('file', target, { ...deps, previewRoot: root, files: undefined })
        return { ok: result.ok, calls: calls.length }
      }
      expect(await run(join(root, 'job', 'abc', 'index.html'))).toEqual({ ok: true, calls: 1 })
      expect(await run(join(root, 'job', 'abc', 'link.html'))).toEqual({ ok: false, calls: 0 })
      expect(await run(join(root, 'job', 'dirlink', 'x.html'))).toEqual({ ok: false, calls: 0 })
      expect(await run(join(base, 'outside', 'x.html'))).toEqual({ ok: false, calls: 0 })
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('readJobEvidence：只读，整个透传给 core', () => {
  it('只把 jobId、submissionId、evidenceId 交给 core，多余字段不传；core 的结果原样返回', async () => {
    const { api, seen } = fakeApi({ ok: true, data: { kind: 'file', path: '/x.html' } })
    const result = await dispatchCommand(api, 'readJobEvidence', { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1', path: '/etc/passwd' })
    expect(result).toEqual({ ok: true, data: { mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' } })
    expect(seen.evidence).toEqual([{ jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1' }])
  })

  it('core 抛出时返回中文失败，不冒泡', async () => {
    const api = { readJobEvidence: async () => { throw new Error('读取出了问题') } } as unknown as UiApi
    expect(await dispatchCommand(api, 'readJobEvidence', { jobId: 'job_0000000001', submissionId: 'jsb_0000000001', evidenceId: 'ev1' })).toEqual({ ok: false, error: '读取出了问题' })
  })
})
