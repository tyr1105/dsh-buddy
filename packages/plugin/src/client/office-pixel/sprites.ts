/**
 * 像素办公室的字符画素材（P54）：盆栽、杯子、桌面电话、咖啡机、猫等小物件。
 *
 * 怎么读：每个字符串是一行像素，点号是透明，其他字符去画的时候传入的颜色表里查。
 * 比如 SPRITE_MUG 里的 o 是描边、W 是杯身。想改形状，直接改字符就行。
 *
 * 这些素材全部是这个项目自己原创绘制的，只负责「长什么样」，不知道颜色，也不知道摆在哪。
 */

/** 桌面小盆栽：d 叶子暗部、l 叶子、h 高光、o 描边、r 盆沿、p 盆身、P 盆身暗部。 */
export const SPRITE_DESK_PLANT: readonly string[] = [
  '...dd.dd...',
  '..dlldlld..',
  '.dlhlllhld.',
  '.dllllllld.',
  '..dlllhld..',
  '...dllld...',
  '....dld....',
  '..ooooooo..',
  '..orrrrro..',
  '..opppPPo..',
  '...opPPo...',
  '...ooooo...',
]

/** 带把手的杯子：W 杯身。 */
export const SPRITE_MUG: readonly string[] = [
  '.ooooo..',
  'oWWWWWoo',
  'oWWWWWo.o',
  'oWWWWWoo.',
  '.ooooo...',
]

/** 笔筒：r、b、y 是三支不同颜色的笔。 */
export const SPRITE_PENCIL_CUP: readonly string[] = [
  '.r...y.',
  '.r.b.y.',
  '.r.b.y.',
  'ooooooo',
  'oWWWWWo',
  'oWWWWWo',
  'oWWWWWo',
  '.ooooo.',
]

/** 咖啡机：M 机身、K 出水口的内腔、W 杯子、g 和 r 是指示灯、D 控制面板。 */
export const SPRITE_COFFEE_MACHINE: readonly string[] = [
  '.oooooooooooooo.',
  'oMMMMMMMMMMMMMMo',
  'oMDDDDDDDDDDMMMo',
  'oMDgDrDDDDDDMMMo',
  'oMDDDDDDDDDDMMMo',
  'oMMMMMMMMMMMMMMo',
  'oMMoooooooooMMMo',
  'oMMoKKKssKKoMMMo',
  'oMMoKKKssKKoMMMo',
  'oMMoKKWWWKKoMMMo',
  'oMMoKKWWWKKoMMMo',
  'oMMoooooooooMMMo',
  'oMMMMMMMMMMMMMMo',
  '.oooooooooooooo.',
]

/** 办公椅的靠背朝向观众：C 椅面、h 高光、D 暗部、l 支柱和五星脚。 */
export const SPRITE_OFFICE_CHAIR: readonly string[] = [
  '..oooooooooooo..',
  '.oChhhhhhhhhhCo.',
  '.oCCCCCCCCCCCCo.',
  '.oCCCCCCCCCCCCo.',
  '.oCCCCCCCCCCCCo.',
  '.oDDDDDDDDDDDDo.',
  '..oooooooooooo..',
  '.......ll.......',
  '.......ll.......',
  '...llllllllll...',
  '...l...ll...l...',
]

/** 桌面电话：H 听筒、B 机身、k 按键。 */
export const SPRITE_DESK_PHONE: readonly string[] = [
  'ooooooooo',
  'oHHHHHHHo',
  'ooooooooo',
  '.oBkBkBo.',
  '.oBBBBBo.',
  '.oBkBkBo.',
  '.ooooooo.',
]

/** 一摞文件夹：R、B、Y 是三份文件的颜色。 */
export const SPRITE_FOLDERS: readonly string[] = [
  'ooooooooo',
  'oRRRRRRRo',
  'ooooooooo',
  'oBBBBBBBo',
  'ooooooooo',
  'oYYYYYYYo',
  'ooooooooo',
]

/** 文件托盘：W 纸、L 纸上的字、T 托盘。 */
export const SPRITE_DOC_TRAY: readonly string[] = [
  '.WWWWWWW.',
  'oWLLLLLWo',
  'oWWWWWWWo',
  'ooooooooo',
  'oTTTTTTTo',
  'ooooooooo',
]

/** 一摞纸杯：W 杯身、R 杯口的色圈。 */
export const SPRITE_PAPER_CUPS: readonly string[] = [
  'oooooooo',
  'oRRRRRRo',
  '.oWWWWo.',
  '.oRRRRo.',
  '.oWWWWo.',
  '.oRRRRo.',
  '.oWWWWo.',
  '.oRRRRo.',
  '.oWWWWo.',
  '.oWWWWo.',
  '.oooooo.',
]

/** 落地大盆栽：一丛向外舒展的叶子，大小正好占满共享区的绿植位。 */
export const SPRITE_FLOOR_PLANT: readonly string[] = [
  '...........dd...........',
  '..........dlld....dd....',
  '....dd....dlhld..dlld...',
  '...dlld...dlhld.dlhld...',
  '...dlhld..dlhld.dlhld.d.',
  '...dlhld..dllld.dllld.ld',
  '.d..dllld.dllld.dlld.dld',
  'dld.dllld..dld.dlld.dlhd',
  'dlhd.dlld..dld.dld.dlhld',
  'dlhld.dld.dlld.dld.dlld.',
  '.dlhld.dldllld.dl.dlld..',
  '.dllld.dddllld.dddlld...',
  '..dllldllsdlld.ssdld....',
  '...dlldddssddd.sdld.....',
  '....ddd...ss...sdd......',
  '...........ss.s.........',
  '...........sss..........',
  '...........ss...........',
  '...........ss...........',
  '.....oooooooooooooo.....',
  '.....orrrrrrrrrrrro.....',
  '.....oooooooooooooo.....',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '.......opppppPPPo.......',
  '.......opppppPPPo.......',
  '.......oooooooooo.......',
]

/** 圆滚滚的落地绿植：叶子挤成一团，比细长的那盆更饱满，两种轮流摆。 */
export const SPRITE_BUSH_PLANT: readonly string[] = [
  '.........ddddd..........',
  '.......ddlllllddd.......',
  '.....ddlllhhllllldd.....',
  '....dllllhhllllllllld...',
  '...dlllhlllllddlllhlld..',
  '...dllhllllddllllhhlld..',
  '..ddlllllddllllllhlllld.',
  '.dlllddlllllllddlllllld.',
  '.dlhlllldlllhllldddllld.',
  '.dlhhllllllhhlllllllldd.',
  '..dlhlllllhllllllhlldd..',
  '..ddllllddlllllhhllld...',
  '...ddlllllllddlllldd....',
  '.....dddlllllllldd......',
  '........dddsddd.........',
  '..........ss............',
  '..........ss............',
  '..........ss............',
  '.....oooooooooooooo.....',
  '.....orrrrrrrrrrrro.....',
  '.....oooooooooooooo.....',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '......oppppppppPPo......',
  '.......opppppPPPo.......',
  '.......opppppPPPo.......',
  '.......oooooooooo.......',
]

/** 猫的颜色键：o 描边、O 毛色、S 花纹、W 肚皮、n 鼻子、e 眼睛、T 尾巴。 */
export const SPRITE_CAT_SLEEP: readonly string[] = [
  '...oo...oo..........',
  '..oOOo.oOOo.oooooo..',
  '..oOOOoOOOooOSOSOOo.',
  '.oOOOOOOOOOOOOOOOOOo',
  '.oOeeOOOeeOOOSOSOOOo',
  '.oOOOOnOOOOOOOOOOOOo',
  '..oWWWWWOOOOOOOOOTTo',
  '...ooooooooooooooooo',
]

/** 睡觉时尾巴尖抬一下的那一帧：只改最后两行右端。 */
export const SPRITE_CAT_SLEEP_TAIL: readonly string[] = [
  '...oo...oo..........',
  '..oOOo.oOOo.oooooo..',
  '..oOOOoOOOooOSOSOOoo',
  '.oOOOOOOOOOOOOOOOOTo',
  '.oOeeOOOeeOOOSOSOOTo',
  '.oOOOOnOOOOOOOOOOOoo',
  '..oWWWWWOOOOOOOOOOo.',
  '...oooooooooooooooo.',
]

/** 坐着的猫，脸朝左。 */
export const SPRITE_CAT_SIT: readonly string[] = [
  '..o...o.......',
  '.oOo.oOo......',
  '.oOOoOOo......',
  'oOOOOOOOo.....',
  'oOeOOeOOo.....',
  'oOOnOOOOo.....',
  '.oOWWOOo......',
  '..oOOOOOo...oo',
  '..oWWOSOOo.oTo',
  '..oWWOSOOo.oTo',
  '..oWOOOOOo.oTo',
  '..oOOOOOOoooTo',
  '...oooooooTTo.',
  '.........ooo..',
]

/** 走路的猫（脸朝左）第一帧：前后腿分开。 */
export const SPRITE_CAT_WALK_A: readonly string[] = [
  '..o..o..............',
  '.oOooOo.............',
  '.oOOOOo..........oo.',
  'oOeOOeOo........oTo.',
  'oOOnOOOo........oTo.',
  '.ooOOOoooooooooooTo.',
  '...oOOOSSOSSOOOOOo..',
  '...oOOOOOOOOOOOOOo..',
  '...oOOoooooooooOOo..',
  '..oOOo.......oOOo...',
  '..ooo.........ooo...',
]

/** 走路的猫第二帧：四条腿收拢，和第一帧交替就走起来了。 */
export const SPRITE_CAT_WALK_B: readonly string[] = [
  '..o..o..............',
  '.oOooOo.............',
  '.oOOOOo.........oo..',
  'oOeOOeOo.......oTo..',
  'oOOnOOOo.......oTo..',
  '.ooOOOooooooooooTo..',
  '...oOOOSSOSSOOOOOo..',
  '...oOOOOOOOOOOOOOo..',
  '...oOOoooooooooOOo..',
  '....oOo.......oOo...',
  '....ooo.......ooo...',
]

/** 小字 z：睡觉的队友头顶飘的，3 乘 3。 */
export const SPRITE_Z: readonly string[] = ['ooo', '.o.', 'ooo']

/** 屏幕上的问号：waiting 用。 */
export const SPRITE_QUESTION: readonly string[] = ['ooo', '..o', '.oo', '...', '.o.']

/** 屏幕上的叹号：blocked 用。 */
export const SPRITE_ALERT: readonly string[] = ['o', 'o', 'o', '.', 'o']

/** 飘在窗外的云：C 云朵。两种形状轮流用，天上就不会一模一样。 */
export const SPRITE_CLOUD_A: readonly string[] = [
  '.....CCCC......',
  '...CCCCCCCC....',
  '.CCCCCCCCCCCCC.',
  'CCCCCCCCCCCCCCC',
  '.CCCCCCCCCCCCC.',
]

export const SPRITE_CLOUD_B: readonly string[] = [
  '...CCC....',
  '.CCCCCCCC.',
  'CCCCCCCCCC',
  '.CCCCCCC..',
]

/** 3 乘 5 的数字字形，1 表示有像素：日历上的日期用它拼。 */
export const PIXEL_DIGITS: Readonly<Record<string, readonly string[]>> = {
  0: ['111', '101', '101', '101', '111'],
  1: ['010', '110', '010', '010', '111'],
  2: ['111', '001', '111', '100', '111'],
  3: ['111', '001', '111', '001', '111'],
  4: ['101', '101', '111', '001', '001'],
  5: ['111', '100', '111', '001', '111'],
  6: ['111', '100', '111', '101', '111'],
  7: ['111', '001', '010', '010', '010'],
  8: ['111', '101', '111', '101', '111'],
  9: ['111', '101', '111', '001', '111'],
}
