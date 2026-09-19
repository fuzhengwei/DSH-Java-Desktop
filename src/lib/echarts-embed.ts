// echarts 完整构建的源码文本（vite ?raw 内联），供 HTML 文件预览时替换 CDN 引用。
// 独立成模块以便代码分割：只有预览到引用 echarts CDN 的 HTML 时才动态加载。
import source from "echarts/dist/echarts.min.js?raw";

export default source;
