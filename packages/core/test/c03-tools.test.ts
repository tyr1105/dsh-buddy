/** 十五个工具逐一验证有效动作、无效输入、等级边界与回合身份，断言落到真实存储事实。 */
import { describe,it,expect } from 'vitest';
import { buildTools,runTool } from '../src/tools/index.js';
import { toolFixture } from './c03-tool-fixtures.js';
import { id } from './model-fixtures.js';
import { claim } from '../src/peer/claims.js';
import { byteLength } from '../src/util/text.js';
import { answerInbox } from '../src/outreach/inbox.js';
const agenda={kind:'task',title:'复核一条来源',abandonWhen:'来源撤回',priority:2};
const watch={kind:'http',target:'https://example.test/new',why:'确认最新证据'};
const goal={aspirationId:id('asp'),title:'完成复核',doneWhen:'来源可查看',period:'week',why:'推进志向'};
const reflect={summary:'总结了经验',lessons:[],watchChanges:[],routineUpdates:[]};
const toolCases=[
  ['hub_state_get',{}, {scope:'unknown'}],
  ['hub_commit','commit',{outcome:'invalid'}],
  ['hub_agenda_upsert',agenda,{...agenda,priority:6}],
  ['hub_agenda_close',{id:id('a'),status:'done',note:'已有证据'},{id:'missing',status:'done',note:'已有证据'}],
  ['hub_watch_update',{id:id('wt'),intervalMinutes:30},{id:id('wt'),intervalMinutes:1}],
  ['hub_watch_propose',watch,{...watch,target:'not-url'}],
  ['hub_goal_upsert',goal,{...goal,aspirationId:'missing'}],
  ['hub_outbox_submit',{kind:'notify_owner',payload:{text:'核实完成'},why:'汇报结果'},{kind:'http_post',payload:{url:'not-url',body:''},why:'汇报'}],
  ['hub_lesson_propose',{text:'先核实再汇报',scope:'self',why:'避免误报'},{text:'',scope:'self',why:'避免误报'}],
  ['hub_reflect_commit',reflect,{...reflect,summary:''}],
  ['hub_send',{to:'b_0000000002',text:'请复核来源'},{to:'missing',text:'请复核来源'}],
  ['hub_handoff',{to:'b_0000000002',task:'复核来源',why:'交叉核对'},{to:'b_0000000002',task:'复核来源',files:['/etc/passwd'],why:'交叉核对'}],
  ['hub_claim',{resource:'report',minutes:30,why:'避免重复'},{resource:'report',minutes:1441,why:'避免重复'}],
  ['hub_release',{resource:'report'},{resource:''}],
  ['hub_routine_save',{name:'复核',whenToUse:'发现新来源',steps:['查看原文']},{name:'复核',whenToUse:'发现新来源',steps:[]}],
] as const;
describe('十五个工具逐项',()=>{
  for(const [name,valid,invalid] of toolCases){
    it(`${name} 有效参数产生预期结果`,async()=>{
      const {ctx,bot,tc,wake,commitArgs}=toolFixture();
      if(name==='hub_reflect_commit') ctx.store.table('wakes').patch(wake.id,{variant:'reflection'});
      if(name==='hub_release') claim(ctx,bot.id,{resource:'report',why:'正在做'});
      const result=await runTool(ctx,tc,name,valid==='commit'?commitArgs:valid);
      expect(result.ok).toBe(true);
      if(!result.ok) return;
      expect(result.text).toMatch(/[\u4e00-\u9fff]/);
      const counts:Record<string,number>={hub_commit:ctx.store.table('commits').count(),hub_reflect_commit:ctx.store.table('commits').count(),hub_handoff:ctx.store.table('handoffs').count(),hub_send:ctx.store.table('mail').count(),hub_routine_save:ctx.store.table('routines').count(),hub_lesson_propose:ctx.store.table('rules').count(),hub_outbox_submit:ctx.store.table('outbox').count()};
      if(name in counts) expect(counts[name]).toBe(1);
      if(name==='hub_agenda_upsert') expect(ctx.store.table('agenda').count()).toBe(2);
      if(name==='hub_agenda_close') expect(ctx.store.table('agenda').get(id('a'))?.status).toBe('done');
      if(name==='hub_watch_update') expect(ctx.store.table('watches').get(id('wt'))?.intervalMs).toBe(1_800_000);
      if(name==='hub_watch_propose') expect(ctx.store.table('watches').count(w=>w.status==='active')).toBe(2);
      if(name==='hub_goal_upsert') expect(ctx.store.table('goals').count(g=>g.status==='active')).toBe(2);
      if(name==='hub_release') expect(ctx.store.table('claims').count()).toBe(0);
      if(name==='hub_claim') expect(ctx.store.table('claims').count()).toBe(1);
      if(name==='hub_state_get') expect(result.text).toContain('今日余量');
    });
    it(`${name} 拒绝错误参数并保持数据`,async()=>{
      const {ctx,tc,wake}=toolFixture();
      if(name==='hub_reflect_commit') ctx.store.table('wakes').patch(wake.id,{variant:'reflection'});
      const before=ctx.store.table('agenda').list();
      const result=await runTool(ctx,tc,name,invalid);
      expect(result.ok).toBe(false); if(!result.ok) expect(result.error).toMatch(/[\u4e00-\u9fff]/);
      expect(ctx.store.table('agenda').list()).toEqual(before);
    });
  }
  for(const name of ['hub_agenda_upsert','hub_agenda_close','hub_watch_update','hub_watch_propose','hub_goal_upsert','hub_outbox_submit','hub_send','hub_handoff','hub_claim','hub_release']) {
    it(`${name} L0 不允许改变工作状态`,async()=>{
      const {ctx,bot,tc}=toolFixture(); ctx.store.table('bots').patch(bot.id,{autonomy:'L0'});
      const args=toolCases.find(c=>c[0]===name)![1]; const result=await runTool(ctx,tc,name,args);
      expect(result).toMatchObject({ok:false,error:expect.stringContaining('L0')});
    });
  }
});
it('工具数量恰好15，每个都有对象JSON Schema和中文说明',()=>{const{ctx}=toolFixture();const tools=buildTools(ctx);expect(tools).toHaveLength(15);expect(new Set(tools.map(t=>t.name)).size).toBe(15);for(const t of tools){expect(t.description).toMatch(/[\u4e00-\u9fff]/);expect(t.jsonSchema).not.toHaveProperty('$schema');expect(t.jsonSchema).toMatchObject({type:'object',properties:expect.any(Object)});}});
it('未知工具不抛异常',async()=>{const{ctx,tc}=toolFixture();expect(await runTool(ctx,tc,'missing',{})).toMatchObject({ok:false});});
it('错误会话不能冒充另一机器人',async()=>{const{ctx,tc}=toolFixture();expect(await runTool(ctx,{...tc,sessionId:'session-b'},'hub_state_get',{})).toMatchObject({ok:false,error:expect.stringContaining('sessionId')});});
it('错误唤醒单不能借用身份',async()=>{const{ctx,tc}=toolFixture();expect(await runTool(ctx,{...tc,wakeId:'missing'},'hub_state_get',{})).toMatchObject({ok:false,error:expect.stringContaining('wakeId')});});
it('handler 直接调用也执行等级检查',async()=>{const{ctx,tc,bot}=toolFixture();ctx.store.table('bots').patch(bot.id,{autonomy:'L0'});expect(await buildTools(ctx).find(t=>t.name==='hub_agenda_upsert')!.handler(ctx,tc,agenda)).toMatchObject({ok:false});});
it('交账后不再允许写事项',async()=>{const{ctx,tc,wake}=toolFixture();ctx.store.table('wakes').patch(wake.id,{status:'committed',commitId:id('c')});expect(await runTool(ctx,tc,'hub_agenda_upsert',agenda)).toMatchObject({ok:false,error:expect.stringContaining('已结束')});});
it('反思不允许直接发消息，但允许保存套路',async()=>{const{ctx,tc,wake}=toolFixture();ctx.store.table('wakes').patch(wake.id,{variant:'reflection'});expect(await runTool(ctx,tc,'hub_send',{to:'b_0000000002',text:'嗨'})).toMatchObject({ok:false,error:expect.stringContaining('只读')});expect(await runTool(ctx,tc,'hub_routine_save',{name:'方法',whenToUse:'复核',steps:['查看证据']})).toMatchObject({ok:true});});
it('建议等级目标提议接受前不覆盖原目标',async()=>{const{ctx,tc,bot}=toolFixture();ctx.store.table('bots').patch(bot.id,{autonomy:'L1'});expect(await runTool(ctx,tc,'hub_goal_upsert',{...goal,id:id('g'),title:'新标题'})).toMatchObject({ok:true});expect(ctx.store.table('goals').get(id('g'))?.title).not.toBe('新标题');const proposed=ctx.store.table('goals').list(g=>g.status==='proposed')[0]!;const inbox=ctx.store.table('inbox').list(i=>i.refId===proposed.id)[0]!;await answerInbox(ctx,inbox.id,'接受');expect(ctx.store.table('goals').get(id('g'))?.title).toBe('新标题');});
it('试岗 L3 仍只能提议新增关注',async()=>{const{ctx,tc,bot}=toolFixture();ctx.store.table('bots').patch(bot.id,{autonomy:'L3',lifecycle:'probation'});await runTool(ctx,tc,'hub_watch_propose',watch);expect(ctx.store.table('watches').list(w=>w.target===watch.target)[0]?.status).toBe('proposed');});
it('L2 家目录文件可生效，家目录外只能提议',async()=>{const{ctx,tc,bot}=toolFixture();await runTool(ctx,tc,'hub_watch_propose',{kind:'file',target:`${bot.homeDir}/work/data`,why:'关注'});await runTool(ctx,tc,'hub_watch_propose',{kind:'file',target:'/owner/data',why:'关注'});expect(ctx.store.table('watches').list(w=>w.target.endsWith('/work/data'))[0]?.status).toBe('active');expect(ctx.store.table('watches').list(w=>w.target==='/owner/data')[0]?.status).toBe('proposed');});
it('低于轮询下限和扩宽关键词都被拒绝',async()=>{const{ctx,tc}=toolFixture();ctx.store.table('watches').patch(id('wt'),{filter:'公告'});expect(await runTool(ctx,tc,'hub_watch_update',{id:id('wt'),filter:null})).toMatchObject({ok:false});expect(await runTool(ctx,tc,'hub_watch_update',{id:id('wt'),filter:'季度公告'})).toMatchObject({ok:true});});
it('状态仅总管可看全队且限制字节',async()=>{const{ctx,tc,bot}=toolFixture();expect(await runTool(ctx,tc,'hub_state_get',{scope:'team'})).toMatchObject({ok:false});ctx.store.table('bots').patch(bot.id,{role:'chief',activityText:'信息'.repeat(2000)});const r=await runTool(ctx,tc,'hub_state_get',{scope:'team'});expect(r.ok).toBe(true);if(r.ok)expect(byteLength(r.text)).toBeLessThanOrEqual(ctx.settings.c03.stateMaxBytes);});
it('议程拒绝无条件的 conditional 与超过30天的时刻',async()=>{const{ctx,tc,now}=toolFixture();expect(await runTool(ctx,tc,'hub_agenda_upsert',{...agenda,kind:'conditional'})).toMatchObject({ok:false});expect(await runTool(ctx,tc,'hub_agenda_upsert',{...agenda,dueAt:new Date(now+31*86400000).toISOString()})).toMatchObject({ok:false});});
it('议程同时接受上海时间和ISO，并限制第11个自主到期事项',async()=>{const{ctx,tc}=toolFixture();for(let i=0;i<10;i++)expect(await runTool(ctx,tc,'hub_agenda_upsert',{...agenda,title:`事项${i}`,dueAt:i%2?'2026-11-06T10:00:00+08:00':'2026-11-06 10:00'})).toMatchObject({ok:true});expect(await runTool(ctx,tc,'hub_agenda_upsert',{...agenda,dueAt:'2026-11-06 10:00'})).toMatchObject({ok:false,error:expect.stringContaining('拼周期')});});
it('复查无变化后自动将同标题间隔加倍',async()=>{const{ctx,tc,now,wake,commitArgs}=toolFixture();ctx.store.table('agenda').patch(id('a'),{kind:'review',title:'复查',status:'done',createdAt:now-3600000,dueAt:now,updatedAt:now});ctx.store.table('commits').put({...commitArgs,id:id('c'),wakeId:wake.id,botId:tc.botId,createdAt:now,outcome:'no_change'});ctx.store.table('wakes').patch(wake.id,{commitId:id('c'),status:'committed',endedAt:now,reason:{...wake.reason,evidence:[id('a')]}});const result=await runTool(ctx,{...tc,wakeId:null},'hub_agenda_upsert',{...agenda,kind:'review',title:'复查',dueAt:new Date(now+60000).toISOString()});expect(result).toMatchObject({ok:true,text:expect.stringContaining('自动推后')});expect(ctx.store.table('agenda').list(a=>a.status==='open'&&a.title==='复查')[0]?.dueAt).toBe(now+7200000);});

it('缺少wakeId也不能绕过当前反思的只读限制',async()=>{const{ctx,tc,wake}=toolFixture();ctx.store.table('wakes').patch(wake.id,{variant:'reflection'});expect(await runTool(ctx,{...tc,wakeId:null},'hub_send',{to:'b_0000000002',text:'继续'})).toMatchObject({ok:false,error:expect.stringContaining('只读')});});
it('暂停和隔离机器人不能经工具写数据，仍可读状态',async()=>{const{ctx,tc,bot}=toolFixture();for(const lifecycle of ['paused','quarantined','retired','draft'] as const){ctx.store.table('bots').patch(bot.id,{lifecycle});expect(await runTool(ctx,tc,'hub_agenda_upsert',agenda)).toMatchObject({ok:false,error:expect.stringContaining('不在岗')});expect(await runTool(ctx,tc,'hub_state_get',{})).toMatchObject({ok:true});}});
it('授权撤销后不能重新激活工作数据关注，但允许暂停',async()=>{const{ctx,tc}=toolFixture();ctx.settings.workDataPaths=['/hub/shared/company'];ctx.store.table('watches').patch(id('wt'),{kind:'file',target:'/hub/shared/company/data',intervalMs:null,status:'paused'});expect(await runTool(ctx,tc,'hub_watch_update',{id:id('wt'),status:'active'})).toMatchObject({ok:false,error:expect.stringContaining('工作数据')});expect(await runTool(ctx,tc,'hub_watch_update',{id:id('wt'),status:'paused'})).toMatchObject({ok:true});});
it('超长目标不能把预算和等待事项挤出状态摘要',async()=>{const{ctx,tc}=toolFixture();ctx.store.table('goals').patch(id('g'),{title:'长目标'.repeat(3000)});const result=await runTool(ctx,tc,'hub_state_get',{});expect(result.ok).toBe(true);if(result.ok){expect(result.text).toContain('今日余量');expect(result.text).toContain('在等');expect(byteLength(result.text)).toBeLessThanOrEqual(ctx.settings.c03.stateMaxBytes);}});
