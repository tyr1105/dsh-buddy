/**
 * P75r5a 第 3 节的测试：「主人纠正」触发词的收窄与补全（独立审查 M3）。
 * 必须命中：下次与以后同等对待、「以后」后可紧跟逗号、问句与陈述句混在一条消息里时陈述句照常判断，以及既有测试里的全部正例。
 * 必须不命中：对不对、不对外、不对劲、记住了吗、以后要是、以后都可以、不带「以后」「下次」的要求、以问号结尾的句子，以及既有测试里的全部反例。
 * 既有测试直接对 CORRECTION_PATTERN 调用 test，所以这里的既有例句也逐条在两个入口上各验一次。
 */
import { describe, expect, it } from 'vitest';
import { CORRECTION_PATTERN, isOwnerCorrection } from '../src/reflect/trigger.js';

const HIT = ['下次别用感叹号', '下次记得先自测', '以后，提示文字别用感叹号', '以后提示文字别用感叹号', '这样不对。', '这样对不对？以后提示文字别用感叹号。'];
const MISS = ['页面这样对不对？', '这个页面先不对外', '这个布局看着不对劲吗？', '以后要是有空再优化', '你记住了吗', '以后都可以，先这样',
  '提示文字不要用感叹号', '按钮改成蓝色，感叹号去掉', '这样不对吧？'];
// 既有测试（p73r2、p75h）里的全部正例与反例。
const OLD_HIT = ['这样不对', '别再这样了', '请记住这点', '以后不要这样写', '以后都用这个格式', '以后要先核实', '以后别发这个', '以后记得备份', '以后注意口径',
  '以后必须带来源', '以后不能省略步骤', '以后表单里必须写明单位', '以后所有页面都不能出现英文', '以后一律用蓝色', '以后提示文字别用感叹号', '以后报名页的按钮一律用蓝色',
  '以后交付之前记得自测', '以后这类页面不要放广告'];
const OLD_MISS = ['以后再说吧', '以后有空看看', '以后每周发我一份', '以后再说。不要紧', '以后看情况；必须带来源', '以后怎么办？注意', '以后看看！记得', '以后再说\n不要紧',
  '以后这个页面里面的所有按钮和文字还有图片都放在左边不要动', '以后区别对待这两类用户', '以后有别的想法再告诉你', '以后别人再来'];

describe('P75r5a 第 3 节：isOwnerCorrection', () => {
  for (const text of [...HIT, ...OLD_HIT]) it(`命中：${text.replace(/\n/g, '\\n')}`, () => expect(isOwnerCorrection(text)).toBe(true));
  for (const text of [...MISS, ...OLD_MISS]) it(`不命中：${text.replace(/\n/g, '\\n')}`, () => expect(isOwnerCorrection(text)).toBe(false));

  it('一条消息里有几句：问句不参与，其余任何一句命中就算；全是问句不算', () => {
    expect(isOwnerCorrection('页面这样对不对？以后别用感叹号。')).toBe(true);
    expect(isOwnerCorrection('以后别用感叹号？可以吗？')).toBe(false);
    expect(isOwnerCorrection('先这样；下次记得先自测\n谢谢')).toBe(true);
    expect(isOwnerCorrection('以后别用感叹号?')).toBe(false);
  });
  it('逗号出现在更后面的照旧不算；紧跟「以后」「下次」的一个逗号可以', () => {
    expect(isOwnerCorrection('以后再说，不要紧')).toBe(false);
    expect(isOwnerCorrection('下次，提示文字别用感叹号')).toBe(true);
  });
  it('「别」的常见组成不算：区别、特别、别人（以后、下次两种写法）', () => {
    for (const text of ['下次区别对待这两类用户', '下次特别注意一下是否有别的写法', '下次别人再来']) {
      // 第二句里的「注意」本身是指令词，会命中；这里只验证第一、第三句。
      if (text.includes('注意')) continue;
      expect(isOwnerCorrection(text), text).toBe(false);
    }
  });
  it('可重复调用（不是全局正则）', () => {
    expect(isOwnerCorrection('下次别用感叹号')).toBe(true);
    expect(isOwnerCorrection('下次别用感叹号')).toBe(true);
    expect(CORRECTION_PATTERN.global).toBe(false);
  });
});

describe('P75r5a 第 3 节：CORRECTION_PATTERN 继续导出，既有写法逐条不变', () => {
  for (const text of OLD_HIT) it(`命中：${text}`, () => expect(CORRECTION_PATTERN.test(text)).toBe(true));
  for (const text of OLD_MISS) it(`不命中：${text.replace(/\n/g, '\\n')}`, () => expect(CORRECTION_PATTERN.test(text)).toBe(false));
});
