/** 从包入口组装最小存储场景，保证宿主可直接使用公开导出与独立 testing 命名空间。 */
import { expect, it } from 'vitest';
import * as core from '../src/index.js';

it('公开入口能组合设置、领域校验、注入替身和文件存储', async () => {
  const settings = core.resolveSettings({ rootDir: '/public-api' });
  const clock = new core.testing.FakeClock(1_793_808_000_000);
  const fs = new core.testing.MemoryFs(clock);
  const store = new core.FileStore(fs, clock, settings.rootDir, settings.timezone);
  const id = core.newId('au', new core.testing.SeededRng(7));
  const entry = core.AuditEntrySchema.parse({ id, at: clock.now(), actor: 'hub', action: '启动', detail: '' });
  store.log('audit').append(entry);
  await store.flush();
  const restored = new core.FileStore(fs, clock, settings.rootDir, settings.timezone);
  await restored.load();
  expect(restored.log('audit').all()).toEqual([entry]);
  expect('FakeClock' in core).toBe(false);
});
