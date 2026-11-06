// vitest 配置：把 react 指到测试桩——插件运行时由宿主提供 react（打包期 alias），
// 依赖里不装 react；仓库层测试（hub-state）只需要 import 不断（D05 第 12 条）。
// setupFiles（D07 第 22 条）：HOME 与 AGENT_HUB_ROOT 指到 mkdtemp 临时目录，
// 配合 resolveRootDir 里的测试守护，双保险保证测试绝不写主人真实的 ~/AgentHub。
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      react: fileURLToPath(new URL('./test/helpers/react-stub.ts', import.meta.url)),
    },
  },
  test: {
    setupFiles: [fileURLToPath(new URL('./test/helpers/setup-env.ts', import.meta.url))],
  },
})
