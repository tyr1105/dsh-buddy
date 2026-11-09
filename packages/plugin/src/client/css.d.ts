/** CSS 文件经 esbuild text loader 当字符串导入（见 build.mjs）。 */
declare module '*.css' {
  const content: string
  export default content
}
