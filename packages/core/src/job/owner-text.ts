/**
 * 给主人看的文字里，模型写的原文要过一遍内部名称的检查（P74f-2，补充要求第 3 节第 3 条）。
 *
 * 为什么需要：「待你处理」条目、总管私聊、卡片的正文有的取自模型写的话（受阻说明、说明卡在哪、办法的做法与代价……）。
 * 模型可能把工具名（hub_ 开头）、内部编号（b_、job_、agr_ 等）、mode 的英文名、参数名写进去，主人看不懂也不该看到。
 * 两种处理：模型现在写的话（escalate 的参数）直接拒绝，让它改成白话（internalNameIn）；
 * 记录里已有的原文要放进条目正文时，查到内部名称就换成中心的固定句（ownerSafe），不把内部名称带给主人。
 */

/** 内部名称的特征：工具名、记录编号、mode 的英文名、工具参数名。 */
/** 工具里真实存在的 mode 名（hub_job_manage、hub_job_work、hub_agreement_submit 等）：mode 后面跟着其中之一才算内部名称。 */
const MODE_NAMES = 'assign|reassign|answer|forward|stop|resume|reopen|escalate|submit|review|block|ask|launched|revise|amend|withdraw';

const INTERNAL_NAME = new RegExp([
  String.raw`hub_[a-z_]+`,
  // P74r6（N4）：内部编号是「前缀加下划线加 10 位小写字母或数字」（与记录编号的真实格式一致，普通单词如 ap_testing 不算）。
  // 前缀较长的（job、agr……）前面不要求边界，下划线、汉字、数字后面紧跟的也认出；只有一两个字母的前缀（b、ap、wk、rev）要求前面不是英文字母和数字，免得普通单词的结尾被当成前缀。
  String.raw`(?:job|agr|jsb|jrv|jev|prj|ptp)_[0-9a-z]{10}`,
  String.raw`(?<![a-z0-9])(?:b|ap|wk|rev)_[0-9a-z]{10}`,
  // P75r1（L2）：P75b 九张新表的编号前缀：记忆 mem，技能 sk、技能版本 skv、技能出处 ss、技能更新 su、技能运行 sr。
  // 按各表 id 的真实形状匹配（前缀加下划线加恰好 10 位小写字母或数字），前后都要求不是英文字母和数字，不用「两个字母加下划线」这种宽泛写法。
  String.raw`(?<![a-z0-9])(?:mem|skv|sk|ss|su|sr)_[0-9a-z]{10}(?![a-z0-9])`,
  // P75r5b（审查 M5）：技能类回合里模型写的话会给主人看，补三种写法：出处编号（src 加数字，如 src2）、
  // 更新编号（su_ 加字母数字；上面的「恰好 10 位」写法之外，写错位数的也认）、updateId 这个词（在下面的参数名一行里）。
  String.raw`(?<![a-z0-9])src\d+(?![a-z0-9])`,
  String.raw`(?<![a-z0-9])su_[0-9a-z]+`,
  // mode 只在后面跟着工具里真实存在的 mode 名时才算（「dark mode and light mode」不算）。
  String.raw`(?<![a-z0-9])mode\s*[:：=]?\s*(?:${MODE_NAMES})(?![a-z0-9])`,
  String.raw`\b(?:ownerQuestion|jobId|agreementId|stuckAt|stopsJob|answersAsk|deliveryItems|launchStep|updateId)\b`,
  String.raw`\b(?:awaiting_owner|turn_cap|review_limit|owner_hold|participant_off)\b`,
].join('|'), 'i');

/** 普通英文里也常见的单词：只在同一句里还出现 mode 或参数名时才算内部名称（「Reopen 按钮能用」「支持 followup 邮件」不算）。 */
const AMBIGUOUS_WORD = /\b(?:reassign|reopen|escalate|followUp)\b/i;
/** 同一句里出现这些，上面的单词才算内部名称。 */
const CONTEXT_WORD = /(?<![a-z0-9])mode(?![a-z0-9])|\b(?:jobId|agreementId|stuckAt|stopsJob|answersAsk|deliveryItems|launchStep|ownerQuestion)\b|hub_[a-z_]+/i;

/**
 * 看不见的字符（P74r6，N4）：按 Unicode 的「默认可忽略」一类整体处理（零宽字符、软连字符、字间连接符、文字方向控制字符、
 * 异体字选择符、标签字符、组合字素连接符等），再加上两个常用的空白填充字符 U+3164（韩文填充）和 U+FFA0（半角韩文填充）。
 * 为什么要认：它们插在内部名称中间（「hub」加零宽字符再加「_send」）能绕过检查；方向控制字符还能让主人看到的字符顺序与实际不同。
 */
const INVISIBLE_CHARS = /[\p{Default_Ignorable_Code_Point}ㅤﾠ]/u;

/**
 * P74r15：文字里有没有把「主人」当称呼写进去。
 * 约定内容里的「宠物主人」「女主人」「房主人」「店主人」「主人公」「主人翁」「原主人」「新主人」「失主人」这类词含有这两个字，
 * 但不是在称呼主人；总管照提示把它们改成「你」会改变约定的意思。所以「主人」前面紧挨
 * 宠物、女、男、房、屋、狗、猫、店、车、原、新、旧、物、失 之一，或后面紧跟「公」「翁」时，不算。
 */
const OWNER_WORD = /(?<![女男房屋狗猫店车原新旧物失])主人(?![公翁])/u;

/** 文字里有「主人」这个称呼吗（不含上面那些普通词）。 */
export function mentionsOwnerWord(text: string): boolean {
  return OWNER_WORD.test(text);
}

/** 称呼检查的拒绝文字（逐字固定）：后半句给「说的不是主人」的情形留了出路，免得总管把「宠物主人」改成「你」。 */
export function ownerWordRefusal(field: string): string {
  return `${field}：这句话是给主人看的，称呼写「你」，不写「主人」；如果这里说的不是你的主人，换一个不含这两个字的说法`;
}

/** 文字里有看不见的字符吗（零宽字符、文字方向控制字符）。 */
export function hasInvisibleChars(text: string): boolean {
  return INVISIBLE_CHARS.test(text);
}

/** 检查之前先规范化：统一全角半角（NFKC）、去掉零宽字符和文字方向控制字符；匹配本身不区分大小写。 */
function normalizeForCheck(text: string): string {
  const strip = (value: string): string => value.replace(new RegExp(INVISIBLE_CHARS.source, 'gu'), '');
  // NFKC 之前先去一次（U+FFA0 规范化后会变成另一个填充字符），之后再去一次。
  return strip(strip(text).normalize('NFKC'));
}

/** 文字里有内部名称时返回命中的那一段（规范化之后的写法），没有返回 null。 */
export function internalNameIn(text: string): string | null {
  const normalized = normalizeForCheck(text);
  const hit = INTERNAL_NAME.exec(normalized);
  if (hit !== null) return hit[0];
  // 容易与普通英文混淆的单词：按句子判断，同一句里有 mode 或参数名才算。
  for (const sentence of normalized.split(/[。！？.!?\n;；]/)) {
    const word = AMBIGUOUS_WORD.exec(sentence);
    if (word !== null && CONTEXT_WORD.test(sentence)) return word[0];
  }
  return null;
}

/**
 * 给主人看的模型原文的统一检查：含看不见的字符时返回中文提示（字段名放在最前），含内部名称时返回内部名称的提示，都没有返回 null。
 * 先查看不见的字符：它们本身就不该出现，不用再往下说内部名称。
 */
export function ownerTextProblem(field: string, text: string, options: { noOwnerWord?: boolean } = {}): string | null {
  if (hasInvisibleChars(text)) return `${field}：含有看不见的字符，请删掉后重写。`;
  // P74r14：总管填的、会显示给主人看的文字（只在总管两个工具的对应参数上打开）：称呼写「你」，出现「主人」就拒绝。
  // P74r15：「宠物主人」「主人公」这类含有这两个字的普通词不算（见 mentionsOwnerWord）。
  if (options.noOwnerWord === true && mentionsOwnerWord(text)) return ownerWordRefusal(field);
  const hit = internalNameIn(text);
  return hit === null ? null : `${field}：「${hit}」是内部名称，主人看不懂，请改成白话`;
}

/**
 * P74r14：核对人、执行者的话里不许出现的本工具（hub_job_work）的参数名，按整词匹配。
 * 主会话裁定：mode、items 是普通英文词（「dark mode」「list items」），不放进名单。
 * P74r15：名单只留不会与普通英文相同的三个（去掉 rechecked：普通英文词；去掉 jobId：页面源码里常见的变量名），
 * 并且区分大小写（只认工具里的原样写法，「Rechecked the layout」不拦）。
 */
const WORK_PARAM_NAMES = /(?<![A-Za-z0-9_])(?:fixTo|carriedNote|spotChecked)(?![A-Za-z0-9_])/;

/**
 * P74r14：员工用 hub_job_work 写的话（核对说明、退回的改法、沿用说明、交回的说明、做不下去的原因）会在主题的工作往来里显示给主人，
 * 里面不能带本工具的参数名。含参数名时返回中文提示（字段名放在最前），否则返回 null。
 * 页面源码里的标识符（例如常量名）是证据的一部分，不在此列：这个检查只用在上面那几项说明文字上，不用在证据上。
 */
export function paramNameProblem(field: string, text: string): string | null {
  const hit = WORK_PARAM_NAMES.exec(normalizeForCheck(text));
  return hit === null ? null : `${field}：不要写参数名（${hit[0]}），用白话写`;
}

/**
 * P75r5b（审查 M5）：技能类回合（复盘、核对、改写、学习、整理）里模型写的话（check 与 tidy 的 note、交账的 reply）会以工作往来、
 * 核对卡、活动流给主人看。写入之前用 internalNameIn 查一遍，查到就拒绝这次调用，文字如下（给模型看，逐字）。
 */
export const SKILL_OWNER_VISIBLE_REFUSAL = '这句话主人会看到，不能出现工具名和内部编号。用「第几句」指句子，用技能的名字指技能，改成白话再提交。';

/** 核对段、改写段、整理段的调用写法里加的一句（给模型看，逐字）。 */
export const SKILL_NOTE_HINT = 'note 里用「第几句」指句子，不写编号和工具名。';

/** 放进给主人看的正文之前：有内部名称就换成固定句 fallback，否则原样返回。 */
export function ownerSafe(text: string, fallback: string): string {
  return internalNameIn(text) === null ? text : fallback;
}

/** 把多行文字压成一行，超过 max 个字截断并加「…」。 */
export function oneLineClip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}
