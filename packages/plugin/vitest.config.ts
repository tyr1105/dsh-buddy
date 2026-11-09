// vitest 配置：把 react 指到测试桩——插件运行时由宿主提供 react（打包期 alias），
// 依赖里不装 react；仓库层测试（hub-state）只需要 import 不断（D05 第 12 条）。
// setupFiles（D07 第 22 条）：HOME 与 AGENT_HUB_ROOT 指到 mkdtemp 临时目录，
// 配合 resolveRootDir 里的测试守护，双保险保证测试绝不写主人真实的 ~/AgentHub。
// JSX 运行时（P53）：组件文件 import 时要用，单独指到一个只产出普通对象的桩，
// 这样测试才能加载 .tsx；必须排在 react 前面，否则会被当成 react 桩的子路径而找不到文件。
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: [
      { find: /^react\/jsx(-dev)?-runtime$/, replacement: fileURLToPath(new URL('./test/helpers/jsx-runtime-stub.ts', import.meta.url)) },
      { find: 'react', replacement: fileURLToPath(new URL('./test/helpers/react-stub.ts', import.meta.url)) },
    ],
  },
  test: {
    setupFiles: [fileURLToPath(new URL('./test/helpers/setup-env.ts', import.meta.url))],
  },
})
