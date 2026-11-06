# T6-storage-events

## [corrected] 1) ctx.storageDomain：defineDomain/open 的 API、增删改查方法、数据落在哪

结论（核对后）：服务名 `storageDomain`，插件写 `inject: ['storageDomain']`。dsh-base 默认挂载 storage、storage-json（root = `dshHomePath('storages')`）和 storage-domain（backend: json）。同一个 facility 也挂在 `ctx.storage.domain`。本版只有 json 后端，数据在 `$DSH_HOME/storages/`，默认 `~/.dsh/storages/`。

① 声明：`defineDomain(spec)` 做 6 项校验后原样返回；`domainTable(schema)` 只返回 `{ valueSchema: schema }`。可以不 import 任何 @deepseek-ai 包、手写 spec，但 open() 不会替你跑 defineDomain。json 后端只校验 name 和表名：必须匹配 `/^[a-z][a-z0-9_]*$/`，不合法抛 StorageError `malformed-medium`。其余检查全被跳过：
- `layout` 拼错（如 'per_record'）会被静默当成 single；
- `invalidRecords` 拼错会静默不备份；
- version 非整数、compatibleVersions 越界、global schema 接受 null，都不报错。
所以手写 spec 要自己复刻这些检查，见 code。

spec 字段：`name`；`version`（非负整数）；`layout?: 'single' | 'per-record'`（默认 single）；`compatibleVersions?: number[]`（每项小于 version，只对 per-record 生效）；`invalidRecords?: 'backup-and-skip'`；`global?: { schema, initial }`；`tables: { 表名: { valueSchema } }`。
valueSchema 只需要 `parse(raw)`：open 时对每条已存记录调用，抛错就算这条记录非法。global 在 open 时也只调 `parse`。defineDomain 还要求 global schema 有 `safeParse`，且 `safeParse(null)` 不能成功：null 是「从未写过」的标记，存进 null 后重开会回到 initial。

② 打开：`const domain = await ctx.storageDomain.open(spec)`，按顺序执行：
1. 同名域已打开或正在关闭：DomainError `already-open`。
2. 按 `routes[name] ?? backend` 找后端：找不到抛 StorageError `backend-not-found`。
3. 后端没有 kv 能力：`facet-unsupported`。
4. 打开存储单元：single 版本不符抛 `version-mismatch`，文件坏抛 `malformed-medium`。
5. loadAll 后逐条 `valueSchema.parse`：失败抛 `invalid-record`，`err.detail = { table, key }`；global 失败时 table 和 key 都是 ''。
失败时如果单元已打开会先关闭，然后释放名字。
返回的 Domain：`name`；`table(名)`（未声明抛普通 Error）；`global`（spec 没声明时一访问就抛普通 Error）；`close(): Promise<void>`（可重复调用）。

③ 增删改查，先 `const t = domain.table('bots')`：
- 查：`t.get(key)`、`t.entries()`、`t.keys()`、`t.size`，同步读内存；entries 和 keys 返回快照迭代器。
- 增或改：`await t.put(key, value)`，落盘后才 resolve。
- 原子读改写：`await t.update(key, cur => next)`，返回 next；key 不存在抛 DomainError `missing-key`。
- 删：`await t.delete(key)` 返回 boolean；key 不存在返回 false，不发事件。
- 单值槽位：`domain.global.get()`、`await domain.global.set(v)`。
close 开始后新写立即被拒（DomainError `closed`）；close 完成后读也抛 `closed`。每次写成功后发 `domain/changed`，载荷是 `{ domain, table, key, operation: 'put' | 'deleted', value? }`；写 global 时 table 和 key 都是 ''。

④ 错误：DomainError.code 取值为 already-open、facet-unsupported、invalid-record、missing-key、closed；后端 StorageError 原样透传（backend-not-found、version-mismatch、malformed-medium、closed）。注意不是所有错误都带 code：table() 或 global 未声明、per-record 的非法 key、后端「unit already open」抛的都是普通 Error。

⑤ 磁盘：根目录是 `dshHomePath('storages')`，目录 0700，文件 0600。
- single：`<root>/<name>.json`，顶层键 unit（{name, version}）、global（值或 null）、tables（{表: {key: 值}}），2 空格缩进，末尾换行。
- per-record：`<root>/<name>/<表>/<key>.json`，内容是 `{ version: N, record: 值 }`；global 在 `<root>/<name>/global.json`，格式相同。

⑥ 官方已占用的域名：schedule（single，v1）、workspace（single，v2，带 global）、session_projcache（per-record，v7，兼容 3–6，backup-and-skip）。这些数据不会进入模型上下文。

⑦ 生命周期：facility 不会把域绑到调用方插件的生命周期上，必须自己写 `ctx.effect(() => () => domain.close())`。另外 open 要 await：如果 await 期间插件已被卸载，`ctx.effect` 会抛 INACTIVE_EFFECT。这时必须当场 `await domain.close()` 再把错误抛出去（官方 schedule 就这么写）。否则名字会一直被占用，之后 open 一律报 already-open，直到重启 DSH。`ctx.storageDomain.get(name)` 只用于诊断；不要调 `closeAll()`，它会关掉所有插件的域。

```
// lib/index.js（宿主半）——手写 spec，但在模块加载时复刻 defineDomain 的校验（dsh-storage-domain/lib/index.js:61-76）
// botSchema / stateSchema 沿用调研员示例里的「最小 zod 兼容校验器」
const NAME_RE = /^[a-z][a-z0-9_]*$/
function checkSpec(spec) {
  if (!NAME_RE.test(spec.name)) throw new Error(`bad domain name ${spec.name}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error('version must be a non-negative integer')
  for (const v of spec.compatibleVersions ?? []) if (!Number.isInteger(v) || v < 0 || v >= spec.version) throw new Error(`bad compatibleVersions entry ${v}`)
  if (spec.layout !== undefined && spec.layout !== 'single' && spec.layout !== 'per-record') throw new Error(`bad layout ${spec.layout}`)   // 不查的话拼错会被静默当成 single
  if (spec.invalidRecords !== undefined && spec.invalidRecords !== 'backup-and-skip') throw new Error('bad invalidRecords')          // 不查的话拼错会静默不备份
  for (const t of Object.keys(spec.tables)) if (!NAME_RE.test(t)) throw new Error(`bad table name ${t}`)
  if (spec.global !== undefined && spec.global.schema.safeParse(null).success) throw new Error('global schema must reject null')
  return spec
}

export const HUB_DOMAIN = checkSpec({
  name: 'agent_hub',
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: { bots: { valueSchema: botSchema }, state: { valueSchema: stateSchema } },
})

// 打开并挂上 close；already-open 时退避重试（禁用后马上启用时，旧实例可能还没 close 完）
export async function openHubDomain(ctx, log) {
  for (let attempt = 1; ; attempt++) {
    let domain
    try {
      domain = await ctx.storageDomain.open(HUB_DOMAIN)
    } catch (e) {
      if (e?.code !== 'already-open' || attempt >= 5) { log.error(`open agent_hub failed: ${e?.code ?? ''} ${e?.message ?? e}`); return undefined }
      try { await ctx.timeout(200 * attempt) } catch { return undefined }   // 插件已被卸载
      continue
    }
    try {
      ctx.effect(() => () => domain.close(), 'agent-hub.domain')         // 句柄不会随插件自动关闭
    } catch (e) {
      await domain.close()                                               // await 期间插件已被卸载：当场关掉，否则名字被永久占用
      throw e
    }
    return domain
  }
}
```

> 核查说明：原结论里的服务名、open 顺序与错误码、Domain/KvTable 方法、domain/changed 载荷、磁盘格式与权限、官方域名，都已核对无误。
更正1：原说「手写 spec 即可，后端仍会检查 name 和表名」，只说对了一半。open() 不调用 defineDomain，json 后端只校验 name 和表名（storage-json:589-592）。layout 拼错时，storage-json:575 的三元判断会把它静默当成 single；invalidRecords 拼错时，storage-domain:373 的严格比较会静默不备份；version、compatibleVersions、global 是否接受 null 也都不校验。
更正2：原说「所有错误都带稳定的 code 字段」，过度概括了。table() 或 global 未声明（:178、:189）、per-record 非法 key（storage-json:535）、后端同名单元已开（storage-json:564），抛的都是普通 Error，没有 code。
补充3：原示例在 await open 之后直接调 ctx.effect。如果 await 期间插件已被卸载，ctx.effect 会抛 INACTIVE_EFFECT（cordis:1169-1171），句柄泄露，名字一直留在 reserved 里（storage-domain:384-387）。官方 schedule 的写法见 dsh-schedule:2011-2022。

证据：说明：下文 dsh-src = /private/tmp/claude-501/-Users-bytedance-Documents-DSH-solo-AGENT/f397848d-6e8e-4ccc-baa6-3f4ad06eb7ba/scratchpad/dsh-src; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:46-48 domainTable 只返回 { valueSchema }；:61-76 defineDomain 的 6 项校验（open 不会调用它）；:82-91 descriptorOf 只透传 layout/compatibleVersions; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:561-568、589-592 kv.open → validateDescriptor 只校验 name 和表名（malformed-medium）；:564 同名单元已打开时抛普通 Error; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:575 只有 layout === 'per-record' 才走 per-record，其他任何值都走 single; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:355-398 open 的顺序与错误码；:359 routes[name] ?? backend；:373 invalidRecords 必须严格等于 'backup-and-skip' 且单元有 backupRecord；:383 global 只调 parse；:384-387 close 完成后才释放名字；:390-396 失败时关单元、释放名字; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:177-191 global/table 未声明时抛普通 Error；:198-229 close/enqueue/assertReadable；:232-297 KvTable 的 get/entries/keys/size/put/delete/update；:162-172 global.set 发出的 table/key 是 ''; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:405-416 get（诊断用）/closeAll；:438-452 apply：provide('storageDomain') 加 storage.mount('domain'); dsh-src/@deepseek-ai/dsh-storage/lib/index.js:57-61 backend-not-found；:80 UNIT_NAME_RE；:134-137 ctx.storage.domain; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:533-536 assertSafeKey 抛普通 Error（无 code）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:179-190 storage / storage-json（root: !!js dshHomePath('storages')）/ storage-domain（backend: json）; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:72-84、127-132、178-191、312-314、487-492（磁盘格式）；:25-41、396-399、511-520、570-573（文件 0o600、目录 0o700）; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1675-1690；dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:255-268；dsh-src/@deepseek-ai/dsh-session-projection-cache/lib/index.js:89-101（官方已占用的三个域）; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2008-2022 官方写法：ctx.effect 挂 close 失败时当场 domain.close() 再抛出; dsh-src/@deepseek-ai/cordis/lib/index.js:1131-1134、1169-1171 已释放的 fiber 上再 effect 会抛 INACTIVE_EFFECT; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:2910-2925 storageDomain 契约；:5311-5352 Domain / DomainChanged* / DomainGlobal / DomainSpec / DomainTableSpec；:5823-5824 KvTable; dsh-src/@deepseek-ai/dsh-storage-domain/README.zh.md:12、129 模型看不到这些数据

## [confirmed] 1) storageDomain 的并发与原子性

核对无误。

写入顺序：
- 同一进程内，每个域只有一条 Promise 写链；put、delete、update、global.set 全部排队，依次执行。
- 每次写：后端先持久化 → 再改内存 → 最后发 domain/changed。
- 后端写失败时内存不变。读是同步的、只读内存，永远和磁盘一致，不会被写入阻塞。
- 持久化的做法：同目录临时文件（open 'wx'，权限 0o600）→ fsync → rename 覆盖目标 → fsync 父目录（Windows 上跳过目录 fsync）。

原子性：
- update 的变换函数在写链上自己的槽位里同步执行，同一域内的读改写不会丢更新；先 get 再 put 不是原子的。
- 原子性只到单条记录：没有跨记录、跨表的事务，也没有二级索引。
- 进程崩溃时，只丢还没 resolve 的写。

写入成本：single 每次写都序列化并重写整个文件；per-record 每次只写一个文件，但每次两次 fsync。

close：立即拒绝新写，已排队的写照常执行完（事件照发），然后关闭存储单元、释放名字；之后读也抛 closed。

不跨进程：
- json 后端假设「每个进程一个写者，最后写的覆盖前面的」，没有跨进程锁。
- 同一个 DSH_HOME 下另一个 dsh 进程打开同名域，两边会互相覆盖，而且都看不到对方的修改。
- domain/changed 只在本进程内可见。

DSH 运行期间手工改 JSON 文件：single 会被下一次写覆盖（以单元的内存为准）；per-record 要到下次 open 才读得到，期间同一个 key 被写就会覆盖手改的内容。

引用语义：内存里存的就是 put 传入的那个对象，get 返回的也是同一个对象，两边都不能原地修改。

> 核查说明：证据行号逐条核对一致。补充一点：domain/changed 由 storage-domain 插件自己的 ctx 发出，不带作用域，任何插件 ctx.on('domain/changed') 都能收到所有域（包括 schedule、workspace、session_projcache）的变更。

证据：dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:221-226 enqueue：每个域一条 Promise 链（chain = result.then(noop, noop)）; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:257-287 put/delete/update：先 unit.putRecord/deleteRecord，再改 records，再 emitChanged；update 在链内同步调用 fn; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:198-208、221-229 close：disposing 后拒绝新写，排空链后关闭单元，之后读抛 closed; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:214-220 domain/changed 只隔离同步异常，记 warn; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:9-17 注释（one writer per process，last-write-wins）；:25-52 writeAtomic 与 fsyncDirectory; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:215-226、265-270 single 每次写都重新发布整个文件；:460-471 per-record 每次只写一份文档; dsh-src/@deepseek-ai/dsh-storage-domain/README.zh.md:89、146-148；dsh-src/@deepseek-ai/dsh-storage-json/README.zh.md:140-141

## [corrected] 1) storageDomain 的坑（版本、校验、键、重载）

核对后的完整列表：

① 改版本号，两种布局表现不同：
- single：存储的版本不等于 spec.version 时，open 直接抛 version-mismatch，compatibleVersions 对 single 无效。
- per-record：版本戳不在 [version, ...compatibleVersions] 里的记录，会被静默当作不存在；文件留在磁盘上，下次写同一个 key 时被覆盖。
- per-record 升版本却不写 compatibleVersions，等于旧数据全部「消失」。写了的话，旧记录要用当前的 valueSchema 校验，所以 schema 必须兼容旧形状；下次写入时会重新打上新版本戳。

② `invalidRecords: 'backup-and-skip'` 只在 per-record 下生效：
- 坏记录被改名成 `<key>.json.bak.<本地时间 YYYYMMDDHHmm>`（同一分钟内重复备份会覆盖），记一条 error 日志，然后跳过。
- single 没有 backupRecord：任何一条坏记录或坏的 global，都会让 open 抛 invalid-record，插件起不来。

③ schema 只在 open 时校验，put、update、global.set 写入时都不校验。

④ 值必须是纯 JSON：Date 会变成 ISO 字符串，Map/Set 变成 {}，值为 undefined 的属性被丢掉。内存里存的仍是原对象，要到重启后才变形。配合 backup-and-skip，一条「内存里合法、JSON 往返后不合法」的记录，会在下次启动时被整条隔离成 .bak。所以写之前先做一次 JSON 往返，再用 schema.parse 校验。

⑤ update 的变换函数必须是同步的：返回的 Promise 会被当成值写进去，落盘后变成 {}。

⑥ key 的规则：
- per-record 的 key 必须匹配 /^[a-zA-Z0-9_-]+$/，否则 put/update 被拒，抛的是普通 Error（没有 code）。
- 加载时，文件名不合规的记录被静默忽略。
- single 的 key 不受限制。
- 会话 UUID 合规，带中文的机器人名不合规。

⑦ 同名域同时只能打开一次；句柄不会随调用方插件自动关闭，只有 storage-domain 插件卸载时才统一 closeAll。所以必须用 ctx.effect 挂 close，并处理 INACTIVE_EFFECT（见第 1 条）。

⑧ per-record 域在磁盘上一份文档都没有时，会从同名的 `<root>/<name>.json` 导入旧数据（前提是文件头里 unit.name 一致，且版本在接受集合内）。所以不要自己往 storages/ 放同名文件。

⑨（补充）single 布局下，put/update/global.set 一个 JSON.stringify 会同步抛错的值（BigInt、循环引用、toJSON 抛错），会污染整个域：
- 存储单元先把值写进自己的内存表，再在 publish() 里同步序列化；
- 同步抛错绕过了 .catch 里的回滚，坏值永久留在单元状态里；
- 之后这个域的每一次写都会在序列化时失败，直到 DSH 重启。
per-record 在 async 函数里序列化，只会让这一次写 reject，不会污染。

⑩（补充）per-record 下 `put(key, undefined)`：文件里只剩 `{ version: N }`，重启后这条读作不存在，但当前内存里还有这个 key。

⑪（补充，推断）macOS 默认的 APFS 不区分大小写：per-record 的 key 'Bot' 和 'bot' 会落到同一个文件，内存里两条，重启后只剩一条。key 统一用小写。

> 核查说明：①–⑧ 核对无误。
补充⑨：single 布局被坏值污染（storage-json:215-226、265-270）。
补充⑩：put(undefined) 的后果（:127-132、:418-420）。
补充⑪：大小写冲突是按 macOS 默认 APFS 推断的，未实测。
修正措辞：原说「Map、Set、undefined 会丢失」，实际是 Map/Set 序列化成 {}、undefined 属性被丢弃；另外补充了它和 backup-and-skip 叠加后的后果。

证据：dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:91-102 single 的 parse：版本不等就抛 version-mismatch（不看 compatibleVersions）; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:146-157、352-355 per-record：版本不被接受的文档读作不存在；:418-420 record 为 undefined 时不放进表; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:371-376 只有 unit.backupRecord 存在时才走 backup-and-skip；dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:192-271 SingleJsonUnit 没有 backupRecord；:472-486 per-record 备份命名（本地时间，同一分钟覆盖）; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:257-263 put 不做 schema 校验；:278-287 update 同步调用 fn，缺 key 抛 missing-key; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:302、416、533-536 SAFE_KEY_RE；加载时跳过不合规文件名；assertSafeKey 抛普通 Error; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:215-226 single putRecord 先 records.set 再 this.publish().catch(回滚)；:265-270 publish() 内同步调用 serialize，同步抛错时 .catch 根本没挂上; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:127-132 serializeRecord（record 为 undefined 时该字段被 JSON.stringify 丢弃）; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:348-357、384-387 调用方持有句柄，close 完成后才释放名字；:414-416 closeAll 只在插件卸载时调用; dsh-src/@deepseek-ai/dsh-session-projection-cache/lib/index.js:150-153、dsh-src/@deepseek-ai/dsh-workspace/lib/index.js:379-381 官方写法：open 后立即 ctx.effect(() => () => domain.close()); dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:338-349、370-404 per-record 空树会从同名 <root>/<name>.json 导入（名字和版本要匹配）

## [confirmed] 1) storageDomain 与自己在目录里写 JSON/JSONL 的取舍

核对无误（取舍属于设计判断，medium）。

storageDomain：
- 优点：原子写加真正 fsync；同一进程内写入串行，update 不丢更新；启动时按 schema 校验，per-record 还能自动隔离坏记录；有变更事件；位置跟着 DSH_HOME 走。
- 缺点：没有追加写；没有查询、索引、事务；不跨进程；模型读不到；升版本语义苛刻；rc 版内部接口可能变；本版只有 json 后端，README 自己也说数据量大、写入频繁或要事务时不该用它。

自己写 JSON/JSONL：
- 优点：可以追加写；机器人能直接读；格式由自己控制。
- 缺点：原子性、串行化、崩溃留下的半行、文件轮转都要自己处理。可选用 @deepseek-ai/dsh-atomic-write 的 writeFileAtomic / withFileLock：带跨进程写锁，但不做 fsync，读方不取锁。

建议的分工：
1. 注册表、唤醒游标、预算计数、待处理审批：放 agent_hub 域，布局选 per-record。
2. 感知事件、唤醒决策、审计流水：放 dataRoot 下，按天一个 JSONL 文件。
3. 机器人自己读写的人设、记忆、收件箱、产出：放机器人的工作目录。workspace-write 档下，会话只能写自己的 workspaceRoot、/tmp 和 os.tmpdir()。
4. 高频变化的状态，学 session_projcache 先在内存里节流再写回：每 200 个事件或 5 秒写一次，另外每次 turn/end、会话创建、会话释放时各写一次。

> 核查说明：README 里「数据量大、写入频繁或需要事务时选 SQLite」在 dsh-storage-json/README.zh.md:32（以及 :12），调研员写的 28-30 行号略偏。308 个包里确实没有 storage-sqlite，只有 dsh-session-query-sqlite，和 storageDomain 无关。JSONL 示例可用。补充：JSON.stringify 遇到 BigInt 或循环引用，会在 append() 里同步抛出，调用方要自己 try/catch。

证据：dsh-src/@deepseek-ai/dsh-storage-json/README.zh.md:12、32（数据量大、写入频繁或需要事务时选 SQLite）；308 个包里没有 storage-sqlite 后端; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:192-200（writeEveryEvents 200 / writeIntervalMs 5000）；dsh-src/@deepseek-ai/dsh-session-projection-cache/lib/index.js:292-324（另有 turn/end、create、dispose 三个强制写点）; dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:166-173（workspace-write 可写根 = workspaceRoot、/tmp、os.tmpdir()）; dsh-src/@deepseek-ai/dsh-atomic-write/README.zh.md:12、28-57（writeFileAtomic / withFileLock；不 fsync；只有写方抢锁）; dsh-src/@deepseek-ai/dsh-storage-domain/README.zh.md:12、129（模型看不到 domain 数据）

## [corrected] 2) ctx.fs.watch 的签名与限制（只监听一层？递归？去抖？）

签名：`ctx.fs.watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>`。

target 不能直接传字符串，要先 `await ctx.fs.resolve(absPath, { cwd?, signal? })` 得到 `{ targetKey, displayPath }`。插件写 `inject: ['fs']`。桌面版的 ctx.fs 是 dsh-fs-sandbox（继承自 dsh-fs-local），沙箱只拦 writeText/editText，watch 不受限制。

实现：chokidar 5.0.0，参数 `depth: 0`、`ignoreInitial: true`；没有 awaitWriteFinish，不轮询，不递归。具体行为：

① 监听模式在启动时一次性决定：
- `stat(target)` 是目录：目录模式。报告直接子项的增、改、删，点文件和临时文件不过滤。
- 否则（文件，或路径不存在）：文件模式。监听父目录，只放行这个路径本身。
- 补充（关键）：要监听的目录如果在 watch 时还不存在，会进入文件模式。之后目录被创建只触发一次 changed()，目录里的新文件永远不会报告。所以必须先 `mkdir(dir, { recursive: true })` 再 watch。
- 父目录被删后重建的恢复：README 写明 Linux 上暂不支持，macOS 未实测。

② 不去抖：一次保存可能触发多次回调，要自己用 ctx.debounce。

③ 回调只是「有变化」的通知：
- 正常变化时调用 changed()，不带参数：没有路径，也没有事件类型。
- 出错时调用 changed(error)，就绪前后都可能发生。
- 想知道具体变了什么要自己查：`ctx.fs.stat(target)` 返回 `{ version, type: 'file'|'directory'|'other', size? }` 或 undefined；`ctx.fs.listDir(target)` 返回 `[{ name, type, target, version?, size? }]`，按名称 localeCompare 排序，size 只有文件才有，目录不存在时抛 FS_NOT_FOUND。拿 version 和之前存的值比对。

④ ignoreInitial：启动前、DSH 关闭期间的变化都不会触发回调，启动时要自己全量对账一次。

⑤ 生命周期：
- signal 只能取消初始化这一步。
- 就绪后拿到 close，必须挂 `ctx.effect(() => () => close())`。
- 补充：如果 await watch 期间插件已被卸载，ctx.effect 会抛 INACTIVE_EFFECT，这时要当场 `await close()`，否则 watcher 泄露。

⑥ 回调里漏出的异常会变成未捕获异常或未处理的拒绝，Host 会 exit(1)。

⑦ 机器人自己写文件也会触发 watch。模型通过 DSH 文件工具读写文件时，会发 `fs/observed(target, observation, actor)`，`actor?.agent?.id` 能认出是谁写的；用 bash 写文件不会触发。

⑧ 补充：`ctx.fs.resolve` 的相对路径以 Host 进程的 cwd 为基准，也就是 `$DSH_HOME/profiles/desktop`，所以一律传绝对路径。

需要递归监听、等写入稳定、目录重建后自动恢复时：
- 官方 dsh-skill-filesystem 是直接用 chokidar 写的：depth 1、atomic、awaitWriteFinish，目录被删（unlinkDir）后重建 watcher。
- 但 chokidar 不在桌面运行时的 sharedPackages 里，插件要么自带依赖，要么用 Node 自带的 `fs.watch(dir, { recursive: true, signal })`（desktop-runtime.json 记录 nodeVersion 24.21.0，macOS 支持递归），自己去抖，并在 ctx.effect 里关闭。

```
import { mkdir } from 'node:fs/promises'
export const inject = ['fs', 'timer']

// 监听某机器人 inbox 目录的直接子项；变化后去抖再处理（宿主半）
export async function watchDir(ctx, log, absDir, onChange) {
  await mkdir(absDir, { recursive: true })            // 关键：目录不存在时 watch 会退化成「文件模式」，以后目录里的新文件永远不报
  const target = await ctx.fs.resolve(absDir)          // 必须先 resolve 成 FsTarget（用绝对路径；相对路径基准是 $DSH_HOME/profiles/desktop）
  const fire = ctx.debounce(() => {
    try { onChange() } catch (e) { log.warn(`onChange: ${e?.message ?? e}`) }
  }, 800)                                              // DSH 不去抖；debounce 的定时器随插件 fiber 释放
  const init = new AbortController()                   // signal 只管初始化阶段
  const close = await ctx.fs.watch(target, (error) => {
    try {
      if (error) log.warn(`watch ${absDir}: ${error.message}`)
      else fire()                                      // 无参数、无路径、无事件类型
    } catch (e) { log.warn(String(e)) }                // 漏出的异常会让 Host exit(1)
  }, init.signal)
  try {
    ctx.effect(() => () => close(), `agent-hub.watch:${absDir}`)
  } catch (e) {                                        // await 期间插件已被卸载：ctx.effect 抛 INACTIVE_EFFECT
    await close()                                      // 当场关掉，避免 watcher 泄露
    throw e
  }
  return await ctx.fs.listDir(target)                  // ignoreInitial：启动时自己对账一次
}
```

> 核查说明：原结论核对无误。
补充1：目标在 watch 时不存在会退化成文件模式（dsh-fs-local:728-739，directory 只在启动时判定一次），所以监听目录前必须先建好目录。
补充2：原示例缺少 INACTIVE_EFFECT 竞态处理和建目录这一步，已在 code 里修正。
补充3：给出了相对路径基准、Node 版本、chokidar 不在 sharedPackages 的证据。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:1048 watch 签名；:1055 resolve；:1085 stat；:1121 listDir；:5459-5485 FsDirEntry / FsInfo / FsObservation / FsTarget; dsh-src/@deepseek-ai/dsh-fs/lib/index.js:62-73 契约：观察单个文件或目录的直接子项；signal 只取消初始化；不支持的提供方直接 reject; dsh-src/@deepseek-ai/dsh-fs-local/lib/index.js:3（import chokidar）、726-750（depth: 0、ignoreInitial: true；:729 只在启动时判定一次 directory；:731-739 非目录时监听父目录、只放行该路径本身；正常变化 changed() 不带参数，出错 changed(error)；ready 后返回 () => watcher.close()）; dsh-src/@deepseek-ai/dsh-fs-local/package.json：chokidar 5.0.0; dsh-src/@deepseek-ai/dsh-fs-local/lib/index.js:287-327 listDirectory（不存在抛 FS_NOT_FOUND、localeCompare 排序、size 只给文件）；:751-754 Config.cwd 默认 process.cwd()；:780-788 resolve; dsh-src/@deepseek-ai/dsh-fs-local/README.zh.md:57（不轮询、不递归）、95（就绪后调用方要等关闭函数完成）、132（Linux 父目录重建延期）; dsh-src/@deepseek-ai/dsh-fs-sandbox/lib/index.js:103-166 继承 LocalFileSystem，只给 writeText/editText 加围栏；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:516-519 桌面 ctx.fs 来自 fs-sandbox; dsh-src/_app/main.js:79-84、12051、12182、3794-3803 Host 子进程 cwd = $DSH_HOME/profiles/desktop; dsh-src/@deepseek-ai/dsh-api-workspace-files/lib/index.js:51-104 官方用法：resolve → stat → watch(target, (error) => …, signal)，自己负责 close; dsh-src/@deepseek-ai/dsh-skill-filesystem/lib/index.js:370-383、434-452 稳健监听：直接用 chokidar，depth 1、atomic、awaitWriteFinish，unlinkDir 后重建; dsh-src/_app/desktop-runtime.json：release.nodeVersion = 24.21.0；sharedPackages 全是 @deepseek-ai/*，不含 chokidar

## [confirmed] 2) cordis-plugin-timer 的 ctx.interval / ctx.timeout 与错误隔离

核对无误。cordis-plugin-timer 1.1.7 由 dsh-base 的 `id: timer` 行默认挂载，把 timeout、interval、throttle、debounce（以及已弃用的 setTimeout、setInterval）挂到 ctx 上。插件写 `inject: ['timer']` 后可用：
- `ctx.timeout(cb, ms)`：返回 dispose 函数，跑一次。
- `ctx.timeout(ms)`：返回 `Promise<void>`。插件卸载时这个 Promise 会以 `Error('Context has been disposed')` reject，必须接住。
- `ctx.interval(cb, ms)`：返回 dispose 函数，本质就是 setInterval。
- `ctx.interval(ms)`：返回异步迭代器。插件卸载时 next() 会 reject；循环体执行期间到来的 tick 会被丢弃，所以不会重入，也不会补发。
- `ctx.throttle(fn, ms, noTrailing?)` 和 `ctx.debounce(fn, ms)`：返回带 `.dispose()` 的函数。
以上都注册成当前插件生命周期上的副作用，插件卸载或重载时自动清掉；插件释放后再调用会抛 INACTIVE_EFFECT。

错误隔离：没有。
- 回调直接交给 Node 定时器，外面没有 try/catch，也不处理返回的 Promise；异步回调可能重叠执行。
- Host 装了 installFailLoud：任何未捕获异常或未处理的 Promise 拒绝，都会写一行诊断，然后 exit(1)。桌面版会弹恢复对话框，不会自动重启。
- 所以每个回调都要自己 try/catch，异步部分 .catch，还要自己防重入。

其他细节：
- Node 定时器的最大延迟是 2147483647 ms，超过会按 1 ms 立即触发。官方 schedule 把定时器钳在这个上限并调用 unref。中心插件改用 30–60 秒的短周期，每次比对墙钟。
- 在某个 agent 的调用链里临时创建的定时器或监听器，用 `ctx.agents.withoutInitiator(() => …)` 包住。
- 也可以直接用原生 setInterval，但要自己写 ctx.effect 清理。

> 核查说明：补充：fail-loud 不是立刻退出。它先写诊断，再最多等 2 秒（FAIL_LOUD_RELEASE_TIMEOUT_MS）让 app.current.fiber.dispose() 执行各插件的 effect 清理，然后 exit(1)。所以崩溃时插件的清理代码也可能被执行，但不保证跑完。调研员示例代码核对可用。

证据：dsh-src/@deepseek-ai/cordis-plugin-timer/lib/index.js:4-15（mixin 列表）、24-47（timeout；Promise 形式在释放时 reject 'Context has been disposed'）、48-116（interval；迭代器形式只保留一个 nextTask）、117-149（throttle/debounce）；package.json version 1.1.7; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:24-25（id: timer）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3260-3295 timer 服务契约; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4175（FAIL_LOUD_RELEASE_TIMEOUT_MS = 2e3）、4216-4254 installFailLoud; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:286-288 桌面 Host 走 runProfile，installFailLoud 的 release = app.current?.fiber.dispose(); dsh-src/@deepseek-ai/cordis/lib/index.js:1131-1134、1169-1171 INACTIVE_EFFECT; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1495、1524-1551、1636-1646（钳上限、unref、withoutInitiator、catch 后记日志）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:183-187 agents.withoutInitiator

## [corrected] 3) 宿主事件全集从哪里看、怎么安全订阅

事件全集：
- dsh-tool-cordis/lib/types/api-catalog.js 的 `EVENT_API`（3930 行起，82 个事件，每个都带 mode/signature/description）；载荷类型见同文件的 `TYPE_API`（4589 行起）。
- 让 DSH 自己写插件时，可以在 cordis preset 里用 `cordis_inspect_list` / `cordis_inspect_query` 工具，从运行中的 Host 读精确契约。

怎么订阅：
- 用 `ctx.on(name, listener)`，监听注册为当前插件生命周期上的副作用，随插件自动注销。
- 带 `this: Scoped<…>` 的事件按 dsh-scope 筛选；插件根 ctx 没有作用域标签，能收到所有会话和 agent 的事件。

各类事件的异常隔离情况（核对后的准确版本）：
- 普通 `ctx.emit` 事件：cordis 的 emit 只是逐个调用，不 catch、不处理返回的 Promise。同步抛错会冒泡回发事件的代码；async reject 是未处理的拒绝，Host exit(1)。
- `session/created`：同步抛错会否决并回滚会话创建；返回的 Promise 被 reject 时会被 catch，只记 warn。所以 async 监听器既不会崩 Host，也否决不了创建。
- `session/event`、`session/disposed`：逐个监听器 try/catch 加 Promise.catch，只记 warn。
- agent 的 emit 类事件（agent/status、agent/error、agent/disposed、agent/inbox/*、agent/assistant-stream）：同样，同步和异步异常都被隔离。
- `agent/created`（serial）：抛错或 reject 都会让这个 agent 创建失败，后面的监听器被跳过。
- `agent/turn-stopping`（serial），以及 `agent/pre-step` / `agent/request` / `agent/request-error`（waterfall）：抛错或 reject 不会崩 Host，会被 agent-loop 接住，但这个机器人这一轮会以 `turn/end { reason: { kind: 'error', error: { code: 'UNKNOWN', … } } }` 结束，并发出 agent/error。只观察的 waterfall 必须原样 `return next()`。
- `api-session/*`：session-controller 在 session/created、agent/created、agent/disposed、agent/status、agent/error、session/event、session/disposed 的监听器里用裸 ctx.emit 转发。api-session/added 的同步抛错会冒泡，否决会话创建，或让 agent 创建失败；任何 api-session/* 监听器的 async reject 都没人接，Host 会退出。
- jobs 事件、`domain/changed`、`schedule/changed`：只隔离同步异常，返回的 Promise 不管。
- `fs/observed`：监听必须是同步的，抛错会让模型的工具调用失败；返回的 Promise 不会被 await。
- `tools/result`：catalog 声明监听器失败会被隔离。

结论：
- emit 类监听一律用 safe 包一层（同步 try/catch，异步 .catch）。
- 只观察的 waterfall 原样 return next()。
- serial 类里不做慢操作，也不要抛错。
- 宿主转发给 GUI 的事件是 dsh-api-remotes 里的固定白名单，不含 domain/changed 和插件自定义事件；面板要实时数据，走插件自己的路由或轮询。

> 核查说明：更正：原证据写「announce：session/created 回调没有 catch」不准确。dsh-session:1913-1918 对每个回调的返回值做了 Promise.resolve(returned).catch(warn)，只有同步抛错不 catch，这正是否决机制。
补充：agent 的 serial/waterfall 监听失败会让机器人那一轮报错结束（dsh-agent-loop:1001-1004、1010-1026）；api-session/* 监听器的 async reject 会让 Host 崩溃。
调研员示例代码（safe 包装、waterfall 里 return next()）核对可用。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3930 EVENT_API（82 个）、4589 TYPE_API; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/index.js:38-57 cordis_inspect_list / cordis_inspect_query；dsh-src/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml:120-121; dsh-src/@deepseek-ai/cordis/lib/index.js:258-264（dispatch 筛选）、280-282（emit 不 catch）、289-294（serial 逐个 await）、317-325（waterfall）、371-380（ctx.on 注册为 effect）; dsh-src/@deepseek-ai/dsh-scope/lib/index.js:327-338、README.zh.md:75（无标签监听器放行）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:1231-1240（session/event、session/disposed 同步、异步都隔离）、1579-1598、1901-1923（announce：同步抛错不 catch 即否决，返回 Promise 的 reject 被 catch 只记 warn）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4364-4370 session/created（A returned-promise rejection is logged but cannot retroactively veto）; dsh-src/@deepseek-ai/dsh-agent/lib/index.js:242-273（agentEvents.emit 同步、异步都隔离；serial/waterfall 直接透传）、549-563、574-590（agent/created serial，失败即创建失败）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:777（dispatch = agentEvents）、1001-1006（turn-stopping）、1010-1026（失败时轮次结束为 error / UNKNOWN 并 throwError → agent/error）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:2980-3004 api-session/* 在其它监听器里用裸 ctx.emit 转发; dsh-src/@deepseek-ai/dsh-jobs-local/lib/index.js:72-89；dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:214-220；dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2231-2237（只隔离同步异常）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4244-4249（fs/observed：throws fail the tool call，promises not awaited）、4500-4505（tools/result：Listener failures are contained）; dsh-src/@deepseek-ai/dsh-api-remotes/lib/index.js:20-139 转发给 GUI 的事件白名单

## [confirmed] 3) 会话创建/结束/状态变化、某轮结束：事件名与载荷

核对无误。

【会话】
- `session/created (session)`：会话进入内存，新建和从磁盘恢复都算。`session.header = { version, id, createdAt, cwd?, parentSession?, isSeeded, origin?: 'subagent', delegationDepth?, agentPreset? }`。
- `session/disposed (session)`：会话离开内存（卸载、回滚、Host 关闭），不等于被删除。
- `session/event (session, event)`：会话日志每追加一条就发一次，提交后发出，不等待监听器。`event = { type, seq, time, data, ignorable? }`。
- `session/flush`：持久化检查点（parallel），不要用它来感知。

session/event 里常用的 type：
- `turn/start {turn}`
- `turn/end {turn, reason}`，reason.kind 取值：
  - `completed`：正常结束。
  - `aborted`：带 reason，kind 为 user / parent / hook（带 reason）/ disposed / legacy。
  - `blocked`：被拦下。
  - `error`：带 error = `{message, code, status?, providerRetryAfterMs?, requestId?, offloadImages?}`。
  - `max-tokens`：输出达到上限。
  - `interrupted`、`forked`：只出现在崩溃恢复或 fork 时合成的收尾事件里。
- `step/start`、`step/end`
- `user/message`：data 就是这条消息，带 source.kind。
- `assistant/message`
- `tool/call`、`tool/result`
- `approval/asked {id, toolName, callId?, reason?}`、`approval/decided {id, outcome}`
- `job/registered`、`job/settled`
- `agent/inbox/spliced`
- 全集见 dsh-session 的 KNOWN_SESSION_EVENT_TYPES。

【agent】agent.id 就是会话 id。
- `agent/created`（serial）`{agent, source: 'startup' | 'resume' | 'clear' | 'compact', signal?}`
- `agent/disposed {agent}`
- `agent/status {agent, status: 'idle' | 'running'}`：maintenance 阶段也报 idle；一次 running 可能连跑好几轮才回到 idle。
- `agent/error {agent, turn, step, error}`
- `agent/inbox/inserted`、`agent/inbox/claimed`（多带 turn）、`agent/inbox/discarded`
- `agent/turn-stopping`（serial）`{agent, turn, signal}`：监听里调用 `agent.steer(...)` 能让这一轮继续；它会拖住每一轮的结束。
- `agent/pre-step`（waterfall）：可以 `return { kind: 'reject' }`，这一轮就以 blocked 结束。
- `agent/request-error`（waterfall）`{agent, turn, step, provider, failure, retryPolicy, signal}`
- `agent/assistant-stream`：流式输出帧，非常高频，不要订阅。

【会话列表派生事件】参数都是纯 JSON：
- `api-session/added (summary)`：summary 为 `{sessionId, updatedAt, agentAvailable, running, blank, formatStatus?, parentSessionId?, origin?, cwd?, projections?}`。
- `api-session/removed (sessionId)`
- `api-session/status (sessionId, running)`
- `api-session/error (sessionId, message)`
- `api-session/activity (sessionId, updatedAt)`：只在 source.kind === 'user' 的 user/message 追加时发。

推荐用法：判断「某一轮结束」用 session/event 里的 turn/end；判断「机器人彻底停下」用 agent/status === 'idle'，或者 `await agent.whenIdle()`。

> 核查说明：补充两处小细节。第一，aborted 的 reason 类型是 TurnEndCancelCause = AgentCancelCause | { kind: 'legacy' }，老日志里可能出现 legacy。第二，agent.status 在 maintenance 阶段（比如压缩）也报 'idle'。

证据：dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4364-4394（session/created、disposed、event、flush）；3956-4041（agent/* 的 mode 与签名）；4044-4083（api-session/*）; dsh-src/@deepseek-ai/dsh-session/lib/index.js:79-141 KNOWN_SESSION_EVENT_TYPES；750-794、908、935（interrupted / forked 由 openTurnClosers 合成）; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:790-799（status；maintenance 也算 idle）、870（whenIdle）、877-886（agent/error）、940-1035（turn/start、turn/end 与 reason）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:1940-1953（SessionSummary）、2997-3004（api-session/activity 只对 source.kind === 'user' 发）、2508-2518（归档门：agent/pre-step reject）; dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:128-143 approval/asked、approval/decided; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4647-4648 AgentCancelCause；8303-8312 TurnEndCancelCause（含 legacy）/ TurnEndReasonMap；5863-5864 LlmFailure；7143-7144 SessionHeader；7391-7392 SessionStartSource；7399-7400 SessionSummary

## [corrected] 3) job/schedule 完成、子代理/workflow、目标、存储、文件变化等事件

【后台 job】
- 订阅方式：`ctx.jobs.events.subscribe(filter, listener)`，要 `inject: ['jobs']`，订阅随插件自动注销。
- filter 三种：`{ owners: 'all' }` 收全部；`{ owner: sessionId }` 收某个会话（注意：没有 owner 的 job 事件也会放行）；`{ owners: 'scope' }` 按作用域。
- 事件形状：`{ type: 'registered' | 'progress' | 'stopping' | 'removed', job }`、`{ type: 'settled', job, cause: 'producer' | 'kill' | 'teardown', awaited }`、`{ type: 'output', id, owner?, total }`。
- job 的字段：`{ id, kind, label, owner?, outputLimitBytes?, status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed', progress?, detail?, startedAt, finishedAt?, output: { total, earliest, spillPaths? } }`。
- 监听器只隔离同步异常。
- owner 会话的日志里同时追加 `job/registered { jobId, owner, kind, label, startedAt, toolCall? }` 和 `job/settled { 同上字段, finishedAt, status, cause, producerReported, detail? }`。

【schedule】
- `schedule/changed ()`：没有载荷；任务集有变化（新建、修改、删除、投递记账）后发；只隔离同步异常。
- 到点投递的真实顺序（更正）：
  1. schedule 先 `createUserMessage({ content, source: { kind: 'schedule' } })`，再调用 `agent.followup(message)`，并 flush 会话。
  2. followup 把消息放进 inbox 的 next-turn 队列并唤醒机器人：这时会话日志追加 `agent/inbox/spliced`，同时发 agent 事件 `agent/inbox/inserted { agent, message }`。
  3. `user/message`（source.kind === 'schedule'）要等这一轮真正开始处理这条消息时才追加；机器人正忙时，会晚于到点时刻。
  所以判断「提醒刚投进来」用 agent/inbox/inserted（或 session/event 里的 agent/inbox/spliced）；判断「机器人开始处理提醒」用 user/message。
- 想拿结构化记录有两种办法：
  - 监听 domain/changed，条件是 `c.domain === 'schedule' && c.table === 'tasks'`；`c.value = { sessionId, record, status: 'active' | 'inactive', lastDelivery?: { scheduledAt, deliveredAt, messageId }, deliveryHistory? }`。这是内部格式，可能随版本变化。
  - 调用 `await ctx.schedule.catalog()`。

【子代理与 workflow】
- `subagent/start { runId, provider, id, local }`
- `subagent/end { runId, provider, id, local, stopReason, lastAssistantMessage? }`
- `workflow/start (info)`、`workflow/end (info, { stopReason: 'completed' | 'cancelled' | 'error', error?, agentsStarted })`、`workflow/agent-start`、`workflow/agent-end`、`workflow/phase (info, title)`、`workflow/log (info, message)`

【目标】
- `goal/changed { agent, change: { operation: 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear', ref, goal? } }`
- `goal/activation-changed { sessionId, goal?: { id, revision, activation: 'armed' | 'disarmed' } }`

【存储】
- domain/changed 所有域都会发，包括 workspace 的归档和置顶（改它的 global）、schedule 的 tasks、session_projcache。
- session_projcache 除了每 200 个事件或每 5 秒写一次，每次 turn/end、session/created、session/disposed 也各写一次。务必先按 domain 过滤。

【文件】
- 外部程序造成的变化：只能靠 ctx.fs.watch。
- 模型通过 DSH 文件工具读写文件时，会发 `fs/observed (target, observation, actor)`：
  - observation 是 `{ kind: 'present', version }` 或 `{ kind: 'absent' }`。
  - actor 是工具执行上下文（ToolExecution，含 agent?），`actor?.agent?.id` 能告诉你是哪个机器人碰的这个文件。
  - 用 bash 写文件不会触发它；监听必须同步，而且不能抛错。
- `tools/result (exec, result)`：可以观察每次工具调用的结果。

【其他宿主事件】app-boot/config-reload、hmr/reload、plugin-manager/changed、settings/document-updated、llm/adapters-updated、deepseek-account/*、credentials/*、tools/change、commands/change、skills/change、system-prompt/change、agent-preset/selected，以及 approval/request、user-questions/request（waterfall，给 GUI 答题用）。webhookRuntime 只出现在 api-catalog 里，安装包里没有实现，桌面版用不了。

```
// 提醒「刚投递」：入队时就能看到（机器人可能还在忙）；「开始处理」：该轮追加 user/message 时
ctx.on('agent/inbox/inserted', ({ agent, message }) => {
  try {
    if (message?.source?.kind === 'schedule') { /* agent.id 的定时提醒已入队 */ }
  } catch (e) { log.warn(String(e)) }
})
ctx.on('session/event', (session, event) => {
  try {
    if (event.type === 'user/message' && event.data?.source?.kind === 'schedule') { /* session.id 开始处理这条提醒 */ }
  } catch (e) { log.warn(String(e)) }
})
```

> 核查说明：更正：原说「目标会话里追加一条 user/message…随后 agent.followup 开一轮」，顺序反了。dsh-schedule:1586-1596 是先建消息再 followup；inbox 插入（dsh-agent-loop:180-208）早于 user/message 追加（dsh-agent-loop:1061-1073）。
补充：jobs 的 owner 过滤会放行没有 owner 的 job（dsh-jobs-local:76）；projcache 有三个强制写点（dsh-session-projection-cache:292-324）。
其余事件名、载荷、证据行号核对无误。

证据：dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1586-1597 先 createUserMessage({ source: { kind: 'schedule' } })，再 resolved.agent.followup(message)，再 sessions.flush; dsh-src/@deepseek-ai/dsh-agent-loop/lib/index.js:800-807 followup = send(input, 'next-turn', true)；:180-208 mutate 追加 agent/inbox/spliced 并发 agent/inbox/inserted；:1061-1073 user/message 在该步开始时才追加; dsh-src/@deepseek-ai/dsh-jobs-local/lib/index.js:53-65（subscribe 是 effect）、72-82（:76 owner 过滤对没有 owner 的 job 放行）、83-89（只隔离同步异常）、348-350、408-411、604-625、769-795; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:1294 jobs；5703-5800 JobEvent / JobEventFilter / JobSettleCause / JobStatus / JobView; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1675-1690（tasks 记录结构）、2129（catalog()）、2231-2237（schedule/changed 无载荷、只隔离同步异常）; dsh-src/@deepseek-ai/dsh-session-projection-cache/lib/index.js:292-324（节流写之外，还有 turn/end、create、detach 三个强制写点）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4260-4273（goal 事件）、4412-4438（subagent）、4524-4566（workflow）、4220-4225（domain/changed）、4244-4249（fs/observed）、4500-4505（tools/result）；5515-5536、7815-7824、8643-8664（载荷类型）; dsh-src/@deepseek-ai/dsh-tool-fs/lib/index.js:195、350-353、492-497、1043-1046 fs/observed 的第三个参数是 exec；api-catalog.js:8167-8176 ToolExecutionInput 含 agent?; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3592 webhookRuntime；在 308 个包里 grep webhookRuntime 只有 api-catalog 命中

## [corrected] 3) 客户端是否在前台、主人是否活跃（有没有 presence/focus 信号）

结论：没有。宿主进程里没有任何「窗口在前台」「主人活跃」「空闲时长」之类的事件或服务。原因：
- Host 是用 ELECTRON_RUN_AS_NODE 启动的独立 Node 子进程。
- 主进程发给 Host 的控制消息只有 shutdown、quit-inspection、update-tasks 三种。
- 主进程监听窗口的 focus 和 show，只用来检查更新、清 sessionEnding 标志，不转发给 Host。
- 渲染进程能用的 IPC 频道清单里，也没有前台或电源相关的项。

能拼出来的代理信号：

(a) 宿主侧：主人刚在 DSH 里发过消息。
- 监听 api-session/activity (sessionId, updatedAt)；或者在 session/event 里看 user/message 且 source.kind === 'user'。
- 坑：`ctx.sessionController.prompt()` 发出的消息也会被标成 `{ kind: 'user', rpcId: requestId, clientTimeZone?, principal? }`。principal 对主人自己和进程内调用都是 undefined，区分不了。只能记下中心插件自己用过的 requestId，用 source.rpcId 排除掉；或者改用 agent.followup()，并给消息一个自定义的 source。
- 审批也要过滤：approval/decided 的 outcome 取值为 'allowed-once'、'rejected'、'cancelled'、'unavailable'。policy 为 never 时会自动 rejected，被中止时是 cancelled，没人应答时是 unavailable。只有 allowed-once（以及确实由人点出来的 rejected）才算主人在场。

(b) 客户端侧：窗口是否可见、有没有焦点、有没有网。
- 插件的客户端半运行在渲染进程里，可以监听 visibilitychange、window 的 focus/blur、online/offline，读 document.visibilityState、document.hasFocus()、navigator.onLine，有变化时上报给宿主路由。
- 点关闭窗口只是隐藏，渲染进程仍在运行。
- 窗口没有关掉 backgroundThrottling，所以隐藏时可见性应变为 hidden（按 Electron 默认行为推断，未实测）。
- 隐藏页面里的定时器会被节流，要靠事件上报，不要靠心跳。宿主侧把「很久没上报」当作「状态未知」。
- 页面地址是 dsh-app://app/。非静态路径会由 Electron 带上 Host 的 Cookie 转发给 Host，保留路径和查询参数；带了 Origin 但不是 dsh-app://app 的请求返回 403。所以客户端可以直接 fetch('/api/…') 用相对路径。

(c) 系统级空闲时间：Host 拿不到 powerMonitor.getSystemIdleTime。macOS 上只能自己起子进程读 `ioreg -c IOHIDSystem` 的 HIDIdleTime（未验证）。

(d) 网关内部的 remoteEventClients 是内部字段，而且窗口隐藏时连接还在，不能代表主人在场。

上报路由的注意事项：
- `webServer.register` 注册的原始前缀路由没有连接层认证。认证是在 /api 前缀路由的 handler 里调用 `connection.admit(req)` 做的；插件注册更长的 /api/agent-hub 前缀，会按最长前缀匹配绕过它。所以这种路由只适合无害的上报。
- handler 抛错会被 webserver 自己接住（记 warn、返回 400），不会让 Host 崩溃。

> 核查说明：原结论核对无误：没有 presence/focus 信号；控制消息只有三种；客户端上报方案和 dsh-app://app 转发都成立。
补充：approval/decided 要按 outcome 过滤（dsh-user-approval:30-35、172-189）；webserver 路由的异常处理和连接层认证的位置；principal 不能用来区分主人和插件发的消息。

证据：dsh-src/_app/main.js:3652（ELECTRON_RUN_AS_NODE: '1'）、3794-3811（spawn Host，stdio 含 ipc）; dsh-src/_app/main.js:3664-3701（Host→主进程 IPC 白名单）、3818-3822（不认识的 IPC → fail + SIGTERM）; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:268-327 Host 只处理 shutdown / quit-inspection / update-tasks / disconnect; dsh-src/_app/main.js:12893、12911-12916（focus/show 只触发 automaticCheck、清 sessionEnding）；6981-7007（渲染进程 IPC 频道清单）; dsh-src/_app/main.js:12894-12906（关窗只是 hide）；11935-11969（createWindow 没设 backgroundThrottling）; dsh-src/_app/main.js:12406-12413、8268-8291（dsh-app://app 非静态路径转发，注入 Host Cookie，Origin 不符返回 403）; dsh-src/@deepseek-ai/dsh-api-session-controller/lib/index.js:3218-3230（prompt 统一标 source.kind 'user' 和 rpcId）、2997-3004（api-session/activity 判定条件）；dsh-src/@deepseek-ai/dsh-typert-protocol/lib/index.js:294-297（principalOf 对 owner 和进程内调用都返回 undefined）; dsh-src/@deepseek-ai/dsh-user-approval/lib/index.js:30-35（OUTCOMES）、172-189（decide：never → rejected，abort → cancelled，无应答 → unavailable）; dsh-src/@deepseek-ai/dsh-host-webserver/lib/index.js:326-333（register）、378-405（路由分发没有认证；handler 抛错 → warn + 400）、494-504（最长前缀匹配）; dsh-src/@deepseek-ai/dsh-client-connection/lib/index.js:14（API_PATH = '/api'）、1044-1052（认证在路由 handler 里 connection.admit(req)）; dsh-src/@deepseek-ai/dsh-api-gateway/lib/index.js:757、1003-1013 remoteEventClients

## [confirmed] 3) 电脑睡眠/唤醒（能否拿到 Electron powerMonitor）、网络状态

核对无误。

睡眠和唤醒：拿不到 Electron powerMonitor。
- powerMonitor 只在 Electron 主进程里 import：resume 只用来检查更新，shutdown 只用来设 sessionEnding，都不转发给 Host。
- Host 是 Node 模式的子进程。
- 插件绝不能用 process.send() 自造 IPC：主进程收到不认识的消息会直接 SIGTERM 杀掉 Host。

可行做法：
- 宿主插件跑一个 30 秒左右的短周期 tick，记下上一次的墙钟时间。
- 如果 Date.now() 和上次的差远大于周期（例如超过 3 倍），就判定「刚从睡眠或挂起中恢复」，立刻全量对账一次：谁的唤醒时间已经过了、要不要补唤醒。
- 原因：官方 schedule 只靠单个长 setTimeout（钳在 2147483647 ms 并 unref）；macOS 睡眠时 libuv 定时器是否按「清醒时间」计时，没有实测（推断）。

网络状态：Host 里没有网络事件。可用的信号：
1. turn/end 的 reason.kind === 'error'，且 reason.error.code 是 'TRANSPORT' 或 'TIMEOUT'。默认可重试的错误码还有 RATE_LIMIT、SERVER 和空响应；默认最多重试 5 次，退避从 500 ms 到 10 s，抖动 0.1。
2. agent/request-error（waterfall）能看到每一次失败的 failure `{ message, code, status? }`；只观察的话必须 return next()。
3. 客户端半的 navigator.onLine 和 online/offline 事件，只能判断有没有网络连接。
4. 宿主自己低频探测：DNS 解析，或者带超时的 HEAD 请求。

> 核查说明：证据核对一致；关于 libuv 睡眠计时的部分仍是推断，已列入 open_questions。

证据：dsh-src/_app/main.js:5（powerMonitor 只在主进程 import）、12697-12708（resume → automaticCheck，只检查更新）、13066-13068（shutdown → sessionEnding = true）; dsh-src/_app/main.js:3818-3822 Host 发来不认识的 IPC 会被 SIGTERM; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:1495、1636-1646 只靠一个钳上限的 setTimeout(...).unref(); dsh-src/@deepseek-ai/dsh-llm/lib/index.js:247-257（DEFAULT_MAX_RETRIES 5、500 ms 到 10 s、抖动 0.1、可重试码 EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT）; dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4020-4025 agent/request-error；5863-5864 LlmFailure；8311-8312 TurnEndReasonMap; dsh-src/@deepseek-ai/dsh-client-connection/README.zh.md:62（浏览器 offline 时暂停重连，online 时恢复）; /Users/bytedance/Documents/DSH solo AGENT/agent-hub/docs/design/evidence/02-proactive-wakeup.md（308 个包里没有睡眠唤醒处理；定时器行为未实测）

## [corrected] 3) 应用即将退出、启动完成：能感知到什么

结论：没有「应用即将退出」的专门事件。插件能感知到的，只是自己被释放。

退出流程：
1. 用户退出，主进程收到 before-quit。
2. 主进程向 Host 发 quit-inspection，期限 2 秒。
3. 下面三种情况会弹确认框：有活跃任务；已加载的会话里有定时提醒；查询失败或超时（这时按「有活跃任务」处理）。
4. 用户确认后执行 finishQuit → backend.close() → 给 Host 发 `{ type: 'shutdown' }`。
5. Host 执行 `application.shutdown.shutdown(0)`，释放整棵插件树：所有插件的 ctx.effect 清理函数按逆序执行。

时间限制：
- Host 自己只给 5 秒宽限，超时强制退出。
- 主进程那边等 10 秒发 SIGTERM，再等 5 秒发 SIGKILL。
- Electron 主进程意外消失时，Host 收到 disconnect，走同样的停止流程。
- 系统关机或注销时，跳过确认框。
- Host 崩溃（fail-loud）时也会先尝试释放插件树，最多等 2 秒再 exit(1)。

所以：
- 收尾逻辑写成 `ctx.effect(() => () => {…})`，几秒内完成，不依赖网络。
- storageDomain 的写在 resolve 时已经落盘，不需要额外 flush。

区分「真的退出」和「插件重载」（私有协议，置信度低）：
- 可以只读监听 `process.on('message', m => m?.type === 'shutdown')`。
- Host 自己的 message 监听在任何插件加载之前就注册了，而它的 stop() 第一步就是 await，所以插件的监听会在清理开始前执行。

可选技巧：
- quit-inspection 会对每个活着的 agent 依次跑 workspace/session-activity 这个 waterfall；回答里有 kind: 'schedule' 的条目，确认框就会提示「定时任务不会运行」。中心插件可以对机器人会话追加 `{ kind: 'schedule', items: [{ id, label }] }`。
- 副作用一：同一个 waterfall 也决定能否归档，回答非空就拒绝归档。调用方带 stopActivity 时会并行发 workspace/session-stop，插件要配合停掉自己的调度。
- 副作用二：监听要快（整体 2 秒预算），而且绝不能抛错；抛错时 Host 会回 activeTasks: true，弹出「有任务在跑」的提示。

启动完成信号：
- `ctx.get('appReady')?.onReady(cb)`：整棵插件树加载完后回调一次，已经就绪则立即回调；返回取消函数。适合做启动后的第一次全量对账。
- `ctx.get('appExit')` 可以请求退出，插件不要调用。
- 这一版的 Cordis 没有 'ready' 和 'dispose' 事件，一律用 effect。

> 核查说明：原结论核对无误。补充三点：第一，quit-inspection 失败或超时也会弹框（main.js:11665-11673）；第二，参与 workspace/session-activity 的监听有 2 秒预算、不能抛错（desktop-host:274-297）；第三，崩溃路径也会尝试释放插件树，最多 2 秒（dsh-app-boot:4225-4238）。另外核实了 process.on('message') 技巧的执行时序（desktop-host:263-273）。

证据：dsh-src/_app/main.js:13094-13127（before-quit → confirm → finishQuit）、13069-13093（finishQuit → backend.close()）、13066-13068 与 13110（关机或注销跳过确认）; dsh-src/_app/main.js:3663（QUIT_INSPECTION_DEADLINE_MS = 2e3）、3870-3877、11625-11630（unknown → quitActiveTasks）、11665-11673（inspection 失败 → 'unknown' → 仍弹框）; dsh-src/_app/main.js:3910-3925 DesktopHostProcess.stop：发 shutdown，10 s 后 SIGTERM，再 5 s 后 SIGKILL; dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:160-181（quit-inspection 对每个 liveAgent 跑 workspace/session-activity）、263-273（shutdown → application.shutdown.shutdown(0)）、274-297（查询抛错时回 activeTasks: true）、325-327（disconnect → stop）; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:12（PROCESS_SHUTDOWN_TIMEOUT_MS = 5e3）、21-71、261-270（dispose = 根 fiber 释放）、286-288（fail-loud 的 release 也是根 fiber 释放）；dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4175、4225-4238（最多等 2 秒）; dsh-src/@deepseek-ai/dsh-cmdline/lib/index.js:27-32（provide appReady / appExit）；dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:87-108（onReady）、307-314（commit 时机）; dsh-src/@deepseek-ai/dsh-schedule/lib/index.js:2043-2062（schedule 如何回答 workspace/session-activity / session-stop）；dsh-src/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:4572-4586（Any non-empty result refuses the archive）; 在 dsh-src/@deepseek-ai/cordis/lib/index.js 中 grep emit 调用：只有 internal/dispatch、internal/plugin、internal/status，没有 ready / dispose 事件

## [confirmed] 4) DSH home 路径工具（dshHomePath 等）

核对无误。@deepseek-ai/dsh-home-paths 是一个普通的库包，不是插件。导出的函数：
- `resolveDshHome(configured?, env = process.env)`：优先级是 显式传参 > $DSH_HOME（空白视为没设）> ~/.dsh。展开 ~、~/ 以及 ~ 加反斜杠，返回规范化的绝对路径。
- `dshHomePath(...segments)`：等于 `join(resolveDshHome(), ...segments)`。
- `dshCachePath('x', …)` 或 `dshCachePath({ dshHome }, …)`：得到 $DSH_HOME/cache/…，不会创建目录。
- `defaultDshHome()`
- `dshHomeDisplay(resolved)`：只返回 '~/.dsh' 或 '$DSH_HOME'，不暴露绝对路径。
- `expandHomePath(p)`：只展开当前用户的 ~。
- `resolveAgentsHome()` / `agentsHomeDisplay()`：$DSH_AGENTS_HOME，没设时为 ~/.agents。
- `canonicalizeWatchPath(p)`
- 常量：DSH_HOME_ENV = 'DSH_HOME'、DSH_HOME_DIR_NAME = '.dsh'、AGENTS_HOME_ENV = 'DSH_AGENTS_HOME' 等。

插件里拿路径的方式，按推荐顺序：
1. 在自己的 cordis.patch.yml 里给 config 写 `dataRoot: !!js dshHomePath('agent-hub')`。Loader 用 `with (ctx) eval(expr)` 求值，启动时根 ctx 已经 provide 了 dshHomePath；官方语音输入 bundle 也是这么写的。
2. 代码里用 `ctx.get('dshHomePath')?.('agent-hub')`，ctx.get 读服务不需要 inject。
3. 用 `ctx.get('profileContext')?.home`。profileContext 还有 name、dir、patchPath、installAnchor、startedBundles、cwd、overlays、telemetryDisabledEnv 等字段。

也可以 `import { dshHomePath } from '@deepseek-ai/dsh-home-paths'`，它在桌面版的 sharedPackages 里，但能不能解析到没有实测。不要像旧插件那样硬编码 `homedir() + '/.dsh/...'`，那样会忽略 $DSH_HOME。

> 核查说明：调研员的三层兜底示例代码可用。和 resolveDshHome 的细微差别：示例先把 $DSH_HOME 去掉首尾空白再使用，而原函数只用去空白后的长度判断有没有设置，实际仍用原值。影响可以忽略。

证据：dsh-src/@deepseek-ai/dsh-home-paths/lib/index.js:11-21（常量）、35-50、55-57、70-74、83-86（空白环境变量视为未设）、109-111、124-126、132-134、141-144、153-155、168（导出列表）; dsh-src/@deepseek-ai/dsh-app-boot/lib/index.js:4526 启动时 ctx.provide('dshHomePath', dshHomePath); dsh-src/@deepseek-ai/cordis-plugin-loader/lib/index.js:233-240 !!js 用 with (ctx) { return eval(expr) } 求值; dsh-src/@deepseek-ai/cordis/lib/index.js:755-765 ctx.get(name) 不需要 inject; dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:290-301 profileContext 的字段（home: resolveDshHome()）; dsh-src/@deepseek-ai/dsh-experimental-voice-input-bundle/cordis.patch.yml:6-9 官方先例 dataRoot: !!js dshHomePath('speech-to-text', 'sensevoice'); dsh-src/_app/desktop-runtime.json sharedPackages 含 @deepseek-ai/dsh-home-paths 0.2.1-rc.5; /Users/bytedance/Documents/DSHarness Doc/dsh-auto-upgrade/plugin/lib/index.js:23-27 旧插件硬编码 HOME + '/.dsh/...'

## [corrected] 4) 插件该把自己的数据放在哪

DSH home 下已经有的东西（只根据源码列出，没有读取实际目录）：
- `sessions/`：会话日志。
- `storages/`：storageDomain 的根目录。
- `cache/`：缓存，里面有 cache/attachments。
- `profiles/<名字>/`：插件就安装在这里，桌面版是 profiles/desktop。
- home 级的 `cordis.patch.yml`。
- `.credentials.yaml`：凭据，绝对不要碰。
- `.anonymous-user-id`
- `llm-deepseek/files-v3.json`
- `dsh-runtimes/`
- `speech-to-text/`：启用语音时才有。

建议中心插件的数据分三处放：
1. 注册表和小状态：用 ctx.storageDomain 的 agent_hub 域，per-record 布局，落在 `$DSH_HOME/storages/agent_hub/<表>/<key>.json`。不要自己往 storages/ 写文件。
2. 插件自己的追加日志和快照：放 dataRoot，也就是 `$DSH_HOME/agent-hub/`，用 node:fs 写，按天一个 JSONL 文件。能重建的缓存放 `dshCachePath('agent-hub')`。
3. 机器人自己要读写的东西：放每个机器人的工作目录，位置在 DSH home 之外。原因有两个：会话在 workspace-write 档下只能写自己的 cwd、/tmp 和 os.tmpdir()；storageDomain 里的数据模型读不到。
不要把数据写进插件包目录，重装或升级会覆盖掉。

坐实（原为推断）：桌面 Host 子进程的 cwd 就是 `$DSH_HOME/profiles/desktop`。Electron 用 resolveDesktopPaths().profile 作为 projectDir，并把它当作 spawn 时的 cwd。所以：
- dsh-base 里 sandbox-policy 的 `workspaceRoot: !!js process.cwd()`，以及 fs-sandbox 默认的 `cwd`，都是这个目录。
- 插件调用 `ctx.fs.writeText` 时如果不带会话策略，只能写 `$DSH_HOME/profiles/desktop`、/tmp、os.tmpdir() 之下；写 `$DSH_HOME/agent-hub/…` 一定会被拒（FS_SANDBOX_DENIED），不再只是「大概率」。
- `ctx.fs.resolve` 的相对路径也以这个目录为基准。
- 插件写自己的文件，一律用 node:fs。

另外：Host 的环境变量取自用户登录 shell 的环境。用户在 shell 配置里设的 DSH_HOME / DSH_PERMISSION_MODE，会作用到 Host。

> 核查说明：更正：原说「往 DSH home 写大概率会被拒（FS_SANDBOX_DENIED），这是按源码推断的」，并把「桌面 Host 的 process.cwd() 具体是哪个目录」列为 open question。现已由 _app/main.js:79-84、12051、12182、3803 确认 cwd = $DSH_HOME/profiles/desktop，所以写 $DSH_HOME/agent-hub 一定被拒。
补充：Host 的环境变量来自登录 shell（main.js:12061-12063）。
其余目录清单和三处分工核对无误。

证据：dsh-src/_app/main.js:79-84 resolveDesktopPaths → <dshHome>/profiles/desktop；:12051 activeProject = paths.profile；:12182 new DesktopHostProcess(…, activeProject, …)；:3794-3803 spawn 的 cwd = this.projectDir; dsh-src/_app/main.js:12061-12063 hostEnvironment = await loginShell（Host 环境来自登录 shell）; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:243-247（sandbox-policy：mode = DSH_PERMISSION_MODE ?? 'workspace-write'，workspaceRoot: !!js process.cwd()）、516-519（fs-sandbox 不带 config，cwd 默认 process.cwd()）; dsh-src/@deepseek-ai/dsh-sandbox-policy/lib/index.js:141-147（没有会话时用 defaultMode 和配置的 workspaceRoot）；dsh-src/@deepseek-ai/dsh-fs-sandbox/lib/index.js:153-166（不在可写根下就 FS_SANDBOX_DENIED）；dsh-src/@deepseek-ai/dsh-sandbox/lib/index.js:166-173（可写根）; dsh-src/@deepseek-ai/dsh-experimental-voice-input-bundle/cordis.patch.yml:6-9；dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:113-116、138-141、182-185、210-211; dsh-src/@deepseek-ai/dsh-attachment-local/lib/index.js:997；dsh-src/@deepseek-ai/dsh-llm-deepseek/lib/index.js:824；dsh-src/@deepseek-ai/dsh-desktop-host/lib/index.js:334；dsh-src/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js:115-117; dsh-src/@deepseek-ai/dsh-storage-json/lib/index.js:370-404 per-record 空树会导入同名的旧整单元文件

## [corrected] （补充）插件重启、禁用再启用时，storageDomain 会不会撞 already-open

源码结论：分两种路径。

① 同一个插件因为配置更新而重启（fiber.update → restart）：
- cordis 的 `_unload` 会逐个 await 所有 effect 清理函数，包括返回 Promise 的 `() => domain.close()`；全部完成后才 `_reload`，重新执行 apply。
- 所以只要 close 挂在 ctx.effect 上，这条路径不会撞 already-open。

② Loader 禁用（disabled）或移除（remove）插件：
- 调用 `entry.fiber?.dispose()` 时不 await；之后重新启用，会立刻创建新的 fiber。
- 旧 fiber 的 domain.close() 要先排空写链，如果还没完成，新实例的 open 会报 already-open。
- 所以调研员示例里「遇到 already-open 就退避重试几次」是必要的兜底。

HMR 的模块级热重载（dsh-hmr；桌面默认 root: []，不监听模块）没有逐行核对。

> 核查说明：这是补充项，回答了调研员 open_questions 第 3 条的大部分（medium）：配置重启路径是安全的；禁用、移除再启用的路径可能出现短暂的 already-open。

证据：dsh-src/@deepseek-ai/cordis/lib/index.js:1372-1391 _unload：await 所有 disposer 后才转入 _reload；:1349-1371 _reload；:1410-1415 restart；:1427-1441 update → restart; dsh-src/@deepseek-ai/cordis/lib/index.js:1175-1185、1239-1246 effect 的 disposer 返回 Promise 时会被串起来等待; dsh-src/@deepseek-ai/cordis-plugin-loader/lib/index.js:70-77 remove：entry.fiber?.dispose() 不 await；:373-375 disabled 时 this.fiber?.dispose() 不 await；:438-465 init 立即创建新 fiber; dsh-src/@deepseek-ai/dsh-storage-domain/lib/index.js:356-357 reserved 检查；:202-208 runClose 先排空写链再关单元；:384-387 close 完成后才释放名字; dsh-src/@deepseek-ai/dsh-base/cordis.patch.yml:28-32（hmr 默认 root: []）

## 坑

- 宿主装了 installFailLoud：任何未捕获异常或未处理的 Promise 拒绝，都会写一行诊断，最多等 2 秒释放插件树，然后 exit(1)。下面这些都在此列：定时器回调、ctx.fs.watch 和 chokidar 的回调、普通 emit 事件上的 async 监听器、api-session/* 监听器的 async reject。
- session/created 的同步抛错会否决会话创建；async 监听器 reject 只记 warn，否决不了。api-session/added 的同步抛错同样会否决会话创建，或让 agent 创建失败。agent/created（serial）抛错或 reject 会让 agent 创建失败。fs/observed 抛错会让模型的工具调用失败。
- agent/turn-stopping、agent/pre-step、agent/request、agent/request-error 的监听抛错或 reject 不会崩 Host，但这个机器人这一轮会以 turn/end error（code UNKNOWN）结束。只观察的 waterfall 必须原样 return next()。
- ctx.timeout(ms) 返回的 Promise 和 ctx.interval(ms) 返回的迭代器，在插件卸载时会 reject 'Context has been disposed'，必须接住。
- 任何 await 之后再调 ctx.effect / ctx.on / ctx.timeout 都可能抛 INACTIVE_EFFECT。打开域、开 watcher 之后挂 effect 要包 try/catch，失败时当场关掉资源（官方 schedule 的写法）。否则句柄泄露：域名永久 already-open，watcher 一直挂着。
- 手写 storageDomain spec 时，open 不会跑 defineDomain：layout 拼错会被静默当成 single，invalidRecords 拼错会静默不备份，version 和 global 是否接受 null 也不检查。要在模块加载时自己复刻这 6 项校验。
- 域名和表名必须匹配 ^[a-z][a-z0-9_]*$，所以不能叫 agent-hub。per-record 的 key 必须匹配 ^[a-zA-Z0-9_-]+$，不合规时抛的是没有 code 的普通 Error。不能和官方的 schedule / workspace / session_projcache 重名。
- storageDomain 句柄必须在 ctx.effect 里 close。Loader 禁用或移除插件时不等旧实例清理完，快速禁用再启用可能短暂报 already-open，要退避重试。
- storageDomain 升版本：single 布局直接 version-mismatch，compatibleVersions 无效；per-record 布局里不在接受集合中的旧记录会静默消失，在接受集合中的旧记录必须能通过当前 schema。
- backup-and-skip 只在 per-record 布局生效；写入时不做 schema 校验。值必须是纯 JSON：Date 变字符串，Map/Set 变 {}，undefined 属性被丢弃。否则重启后整条记录可能被隔离成 .bak。写之前先做一次 JSON 往返，再用 schema.parse 校验。
- single 布局写入 BigInt 或循环引用会污染单元的内存状态，之后这个域的所有写入都会失败，直到重启。per-record 下 put(key, undefined) 的记录，重启后会消失。
- 不要原地修改 table.get() 返回的对象，也不要修改已经 put 进去的对象。update 的变换函数必须是同步的，返回 Promise 会被当成值写进去。
- storageDomain 和 domain/changed 都不跨进程。session_projcache 写得很频繁：节流写之外，每次 turn/end、会话创建、会话释放各写一次。订阅 domain/changed 先按 domain 过滤。
- ctx.fs.watch：参数要先 ctx.fs.resolve 成 FsTarget；只监听一层；不去抖；回调里没有路径也没有事件类型；ignoreInitial 导致启动前的变化收不到。目标在 watch 时不存在会退化成文件模式，目录里的新文件永远不报，所以要先 mkdir。就绪后的 close 必须挂到 ctx.effect。
- ctx.fs 的相对路径基准、不带会话时的沙箱可写根，都是 Host 的 cwd = $DSH_HOME/profiles/desktop。插件写自己的文件用 node:fs，不要用 ctx.fs.writeText，后者写 $DSH_HOME/agent-hub 会被 FS_SANDBOX_DENIED。
- ctx.sessionController.prompt() 会把消息标成 source.kind 'user'（带 rpcId），污染 api-session/activity 这类「主人活跃」信号；principal 区分不了，只能记下自己用过的 rpcId 排除。approval/decided 只有 outcome 为 allowed-once（以及确由人点的 rejected）才算主人在场。
- 定时提醒到点时先出现 agent/inbox/inserted（message.source.kind === 'schedule'）；user/message 要等这一轮真正开始处理时才追加，机器人正忙时会滞后。
- jobs.events.subscribe({ owner }) 也会收到没有 owner 的 job 事件，需要自己再检查 e.job?.owner / e.owner。
- 宿主进程里绝不要调用 process.send()：Electron 主进程收到不认识的 IPC 消息会直接 SIGTERM 杀掉 Host。
- Host 里没有前台、在场、睡眠唤醒、网络、即将退出这几类事件，也拿不到 powerMonitor。只能靠代理信号、客户端上报、墙钟跳变检测来拼。
- 退出时插件收尾只有约 5 秒（Host 的宽限）；主进程 10 秒后 SIGTERM，再 5 秒后 SIGKILL。quit-inspection 只有 2 秒，失败或超时会按「有活跃任务」弹框。插件如果参与 workspace/session-activity：监听要快、不能抛错，而且回答非空会阻止该会话归档。
- Node 定时器延迟超过 2147483647 ms 会立刻触发。不要设长定时器，用 30–60 秒的短 tick 比对墙钟。
- 插件自定义事件和 domain/changed 都不在转发给 GUI 的白名单里，面板要实时数据得走插件自己的路由或轮询。webServer.register 注册的原始前缀路由不经过连接层认证（认证在 /api 路由的 handler 里，更长的前缀会绕过它）；handler 抛错会被 webserver 接住，返回 400。
- 不要硬编码 ~/.dsh，用 dshHomePath 或 $DSH_HOME。webhookRuntime 在桌面版不可用。在某个 agent 调用链里创建共享定时器或 watcher 时，用 ctx.agents.withoutInitiator 包住。让 DSH 写插件时，先用 cordis_inspect_list / cordis_inspect_query 读运行中的契约。

## 未决

- macOS 睡眠后 Node（libuv）定时器的实际行为没有实测：醒来是立刻触发，还是按「清醒时间」顺延。这决定官方 schedule 醒后会不会晚投递，也决定中心插件 tick 周期取多短。
- 桌面窗口隐藏、最小化、被遮挡、锁屏时，document.visibilityState 和 hasFocus 的实际取值没有实测。目前按 Electron 默认 backgroundThrottling 推断，隐藏时为 hidden。
- HMR 模块级热重载、plugin-manager 重新安装插件时，新旧实例 open/close 的时序没有逐行核对。已确认：配置更新重启会先等清理完成（cordis:1372-1391）；Loader 禁用或移除插件时不等（cordis-plugin-loader:70-77、373-375）。
- 第三方插件能否 import zod、chokidar、@deepseek-ai/*：desktop-runtime.json 的 sharedPackages（305 个）全是 @deepseek-ai/* 包（含 dsh-storage-domain、dsh-home-paths、schemastery），没有 zod 和 chokidar。用 link: 方式安装的插件实际能解析到哪些包，没有实测。
- Host 运行期间会不会卸载空闲会话：源码里没找到相关逻辑。这决定 session/disposed 是否只在退出、回滚、归档时出现。
- ctx.fs.watch 在 macOS 上的两个行为没有实测：被监听目录自身被删除再重建后会怎样；chokidar 5 对编辑器「原子保存」会触发几次回调。
- 要不要用 workspace/session-activity 让退出确认框提示「机器人会停摆」，需要产品拍板。代价是：回答非空就会拦住机器人会话的归档，而且监听受 2 秒预算约束。
- 同一 DSH_HOME 下，如果 dsh CLI 或 headless 也装了中心插件，agent_hub 域会被两个进程同时写。需要约定这个插件只在 desktop profile 里启用。
- macOS 默认的 APFS 不区分大小写：per-record 下只有大小写不同的 key 会落到同一个文件。这是按文件系统常识推断的，未实测。
- Electron 主进程用自己的 process.env 计算 profile 路径（resolveDesktopPaths），Host 却使用登录 shell 的环境。如果用户只在 shell 配置里设了 DSH_HOME，两边的 DSH home 可能不一致，实际影响没有核实。
