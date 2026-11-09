/** 工具与协作测试共用内存环境：每例都具有独立机器人、会话、回合与可修改事项。 */
import { createTestContext } from '../src/io/testing/create-test-context.js';
import { botFixture, goalFixture, watchFixture, modelFixtures, id } from './model-fixtures.js';
import type { ToolContext } from '../src/tools/types.js';
import { AgendaItemSchema, WakeTicketSchema, CommitSchema } from '../src/model/index.js';
export function toolFixture() {
  const ctx = createTestContext(); const now = ctx.clock.now();
  const bot = { ...botFixture, autonomy: 'L2' as const, sessionId:'session-a', createdAt:now, updatedAt:now };
  const peer = {...bot, id:'b_0000000002', name:'执行员', homeDir:'/hub/bots/b_0000000002', sessionId:'session-b'};
  ctx.store.table('bots').put(bot); ctx.store.table('bots').put(peer);
  ctx.store.table('aspirations').put({id:id('asp'),botId:bot.id,text:'核实公开信息',status:'active',createdBy:'owner',approved:true,createdAt:now});
  ctx.store.table('goals').put({...goalFixture,lastProgressAt:now,createdAt:now,updatedAt:now});
  ctx.store.table('agenda').put({...AgendaItemSchema.parse(modelFixtures.AgendaItem.valid),createdAt:now,updatedAt:now});
  ctx.store.table('watches').put({...watchFixture,kind:'http',target:'https://example.test/feed',intervalMs:900_000,createdAt:now,updatedAt:now});
  const wake = {...WakeTicketSchema.parse(modelFixtures.WakeTicket.valid),sessionId:bot.sessionId,startedAt:now,lastEventAt:now};
  ctx.store.table('wakes').put(wake);
  const tc: ToolContext={botId:bot.id,sessionId:bot.sessionId,wakeId:wake.id};
  const commit = CommitSchema.parse(modelFixtures.Commit.valid);
  const {id: _id,wakeId: _wakeId,botId: _botId,createdAt: _createdAt,...commitArgs}=commit;
  return {ctx,bot,peer,tc,wake,now,commitArgs};
}
