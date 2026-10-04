/*
 * 首屏主题引导：在 React 挂载前同步读取已保存的主题，给 <html> 加主题 class 并设好背景色，
 * 避免加载页与主界面之间背景闪跳。
 * 必须是独立文件（不能写成 index.html 里的内联脚本）：生产构建的 CSP 只允许加载应用自身的脚本文件。
 */
(function () {
  var bgMap = { light: '#F7F9FC', galaxy: '#0A1628', paper: '#F5F0E8', dark: '#1E1E1E' };
  var theme = 'dark';
  try {
    var raw = localStorage.getItem('vela-theme');
    if (raw) {
      var state = JSON.parse(raw).state;
      theme = state.resolvedTheme || state.theme || 'dark';
      if (theme === 'night') theme = 'dark'; // 兼容旧版
    }
  } catch (e) { /* 读不到就用默认主题 */ }

  var bg = bgMap[theme] || bgMap.galaxy;

  // 提前给 html 注入主题 class，确保所有全局 CSS 变量立即生效
  document.documentElement.classList.remove('light', 'dark', 'galaxy', 'paper');
  document.documentElement.classList.add(theme);

  document.body.style.backgroundColor = bg;
  /* 将背景色注入 CSS 变量供 .vela-initial-loader 引用 */
  document.documentElement.style.setProperty('--loader-bg', bg);
})();
