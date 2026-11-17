/**
 * 性格四句话（P73e）：四行「字母　一句话」，说明这个性格在做事时的实际表现。
 *
 * 为什么单独一个组件：组队卡、模板库详情（P73e），员工侧边栏和编辑弹窗（P73f）都要显示同样的四行，
 * 只改这一处，各处同步。文字由 core 的性格四句话总表给出（视图里的 lines），这里只管排版，不改写文字。
 * 用定义列表（dl）：字母是术语、句子是说明，读屏能按「字母、句子」成对读出。
 */
import type { ReactNode } from 'react'

export function PersonalityLines(props: {
  /** 四句话：code 是字母，text 是那一句；顺序由 core 保证（E/I、S/N、T/F、J/P）。 */
  lines: ReadonlyArray<{ code: string; text: string }>
  /** 整组的可访问名，例如「性格 ISTJ 的实际行为」；不传则不命名。 */
  label?: string
}): ReactNode {
  return (
    <dl className="ah-personality" aria-label={props.label}>
      {props.lines.map(line => (
        <div key={line.code} className="ah-personality-row">
          <dt>{line.code}</dt>
          <dd>{line.text}</dd>
        </div>
      ))}
    </dl>
  )
}
