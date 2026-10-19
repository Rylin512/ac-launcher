// 分发入口。folder 模式（node main.mjs）与单文件 exe 模式跑的是**同一份代码**，
// 于是 folder 模式成为 exe 的忠实预览，而不是第二套实现。
//
//   --repo <路径>      为这个仓库起一个面板（等价于改造前的 panel.mjs）
//   （不给 --repo）    起中枢：列出并监视所有已登记的项目
//
// 用动态 import() 分发：panel.mjs 在模块顶层就会起一个 HTTP 服务，静态 import
// 会让中枢模式也把它一并拉起来。
import path from 'node:path';
import { PANEL_VERSION } from './lib/config.mjs';

const HELP = `
AgileCampus 部署控制台

  ac-launcher.exe <仓库目录>          为该仓库打开控制面板（也可以直接把文件夹拖上来）
  ac-launcher.exe --repo <路径>       同上，显式指定
  ac-launcher.exe                     打开中枢，管理并监视多个项目

选项
  --repo <路径>        项目仓库目录（只读，绝不写入）
  --runtime-dir <路径> 运行目录（默认 %LOCALAPPDATA%\\AgileCampus）
  --node <路径>        指定用于 npm / 构建 / 启动的 Node（默认自动查找）
  --port <n>           中枢端口（默认 8788，被占用时自动顺延）
  --no-open            不要自动打开浏览器
  --selftest           打印解析结果后退出，用于排查环境问题
  --help               显示本帮助
  --version            显示版本
`.trim();

/** 取值型选项，用来把它们的值从位置参数里排除掉。 */
const VALUE_OPTS = new Set(['--repo', '--runtime-dir', '--node', '--port']);

function positionalArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (VALUE_OPTS.has(a)) {
      i += 1;
      continue;
    }
    if (a.startsWith('-')) continue;
    return a;
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (argv.includes('--version')) {
    console.log(`ac-launcher ${PANEL_VERSION}`);
    return;
  }

  // 拖拽进来的目录：等价于 --repo <那个目录>。
  // 只有在用户没有显式给 --repo 时才补，避免覆盖明确意图。
  if (!argv.includes('--repo') && !argv.includes('--hub')) {
    const pos = positionalArg(argv);
    if (pos) {
      const p = path.resolve(pos);
      argv.push('--repo', p);
      process.argv = [...process.argv.slice(0, 2), ...argv];
    }
  }

  // --selftest 由各自那份实现自己处理（两者的报告内容不同：面板要报仓库与 UI，
  // 中枢要报注册表与引擎目录）。别在这里替它们决定——早先这里把中枢模式的
  // --selftest 转给了 panel.mjs，而面板在拿不到仓库时会 exit(2)，于是「自检」
  // 变成了一句「未指定项目仓库」，恰好是它本该回答的那个问题的反面。
  if (process.argv.slice(2).includes('--repo')) await import('./panel.mjs');
  else await import('./hub.mjs');
}

main().catch((e) => {
  console.error('启动失败：', e?.message || e);
  process.exit(1);
});
