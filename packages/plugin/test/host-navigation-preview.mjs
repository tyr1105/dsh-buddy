/**
 * 功能折叠的隔离预览：复用现有 UI 预览服务器和真实插件组件。
 * 只在内存里调整虚构宿主菜单，把“新会话”放到功能 nav 外，与参考截图一致。
 * 不改已有预览脚本、不运行生产 DSH；固定使用独立的本机 3953 端口。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const preview = resolve(root, 'scripts/dev/ui-preview.mjs')
let source = readFileSync(preview, 'utf8')
source = source
  .replace('fileURLToPath(import.meta.url)', JSON.stringify(preview))
  .replace("from 'esbuild'", `from ${JSON.stringify(import.meta.resolve('esbuild'))}`)
  .replaceAll('3952', '3953')
const buildAnchor = 'const bundle = await build({'
if (!source.includes(buildAnchor)) throw new Error('UI 预览构建入口已变化，请更新隔离夹具。')
source = source.replace(buildAnchor, `
const navigationFixture = {
  name: 'navigation-fixture',
  setup(builder) {
    builder.onLoad({ filter: /ui-preview\\.tsx$/ }, ({ path }) => {
      const original = readFileSync(path, 'utf8');
      const nav = '<nav aria-label="DSH 导航" className="preview-navigation">';
      if (!original.includes(nav)) throw new Error('UI 预览导航结构已变化，请更新隔离夹具。');
      return {
        loader: 'tsx', resolveDir: dirname(path),
        contents: original
          .replace(nav, '<button className="preview-new-session">新会话</button>' + nav)
          .replace('<button>新会话</button><button>库</button><button>技能</button><button>笔记本</button><button>Agent 中心</button>',
            '<button>插件</button><button>任务看板</button><button>自动化任务</button><button>上下文洞察</button><button>技能中心</button>')
      };
    });
  }
};
const bundle = await build({ plugins: [navigationFixture],
`)
await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
