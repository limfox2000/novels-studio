/** 阅读器偏好存键。创作台大纲/正文管理器共用同一份主题偏好 */
export const READER_PREF_KEY = 'nc2-reader-v1';

export interface ReaderTheme {
  key: string;
  label: string;
  bg: string; // 页面背景（文字背景色）
  card: string; // 顶栏底色
  text: string; // 正文色
  sub: string; // 次要文字
  btn: string; // 按钮/控件底色
  btnHover: string;
  border: string;
  accent: string; // 主操作色（随主题取色，夜间用亮阶保证对比度）
  accentSoft: string; // 主操作浅底（徽标/激活态）
  accentInk: string; // 主操作实底上的文字色
  scroll: string; // 细滚动条滑块色
}

/** 四档阅读主题 */
export const READER_THEMES: ReaderTheme[] = [
  { key: 'sepia', label: '米黄', bg: '#f3e9d2', card: '#ece0c4', text: '#41341f', sub: '#8f7f5e', btn: '#e2d4b2', btnHover: '#d8c8a1', border: '#dccfae', accent: '#8a5a24', accentSoft: '#e6d3ac', accentInk: '#fffaf0', scroll: '#c9b689' },
  { key: 'paper', label: '纸白', bg: '#faf8f2', card: '#f1eee4', text: '#2b2a26', sub: '#8a8578', btn: '#eae5d8', btnHover: '#ded8c6', border: '#e2ddcc', accent: '#4f46e5', accentSoft: '#e0e7ff', accentInk: '#ffffff', scroll: '#cbc4b2' },
  { key: 'green', label: '护眼', bg: '#cfe6d0', card: '#c2ddc4', text: '#22382a', sub: '#5f7f68', btn: '#bcd8bf', btnHover: '#aacfae', border: '#a9ccae', accent: '#2f6b46', accentSoft: '#b6d7bd', accentInk: '#f5fbf6', scroll: '#9dc2a3' },
  { key: 'dark', label: '夜间', bg: '#14171b', card: '#1c2026', text: '#c6cbd3', sub: '#7a828d', btn: '#262c34', btnHover: '#303842', border: '#2a313a', accent: '#a5b4fc', accentSoft: '#2b3242', accentInk: '#14171b', scroll: '#3a424d' },
];
