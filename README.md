# ac-launcher — AgileCampus 本地部署启动器

在仓库外运行的轻量部署控制台，用于管理和监视多个 AgileCampus 检出。运行时对源仓库只读，所有构建/运行数据写入运行目录（默认 %LOCALAPPDATA%\AgileCampus）。

主要特性

- 两种运行形态：
  - folder 模式（开发）：`start.cmd` / `node main.mjs`（需 Node ≥20，start.cmd 会在缺失时尝试下载便携 Node）
  - 单文件模式（便携）：`dist\\ac-launcher.exe`（内嵌 Node，双击即可）
- 仓库只读，构建与数据库都在运行目录内执行
- 停止面板不等于停止已启动的应用或数据库（面板主要为控制面）
- 面板仅依赖 Node 内置模块，可在 `npm ci` 之前运行，用于首次部署引导

快速开始

- 便携版（Windows）：双击 `dist\\ac-launcher.exe`。
- 开发 / 源码：在仓库外任意目录运行 `start.cmd` 或 `node main.mjs`。

常用命令

```
ac-launcher.exe                      # 打开中枢（管理登记的项目）
ac-launcher.exe <仓库目录>           # 打开该仓库的面板（或将文件夹拖入 exe）
ac-launcher.exe --repo <路径>        # 显式指定仓库目录
```

常用选项

- `--repo <路径>`：项目仓库目录（只读）
- `--runtime-dir <路径>`：运行目录，默认 `%LOCALAPPDATA%\\AgileCampus`
- `--node <路径>`：指定用于构建/启动的 Node
- `--port <n>`：中枢端口，默认 8788（被占用时顺延）
- `--no-open`：不自动打开浏览器
- `--selftest`：打印解析结果后退出，用于排查

运行目录（默认）

%LOCALAPPDATA%\\AgileCampus\\
- projects.json            注册表
- config\\hub.secret     监督令牌
- engine\\<hash>\\      exe 释放的源码副本（按内容哈希）
- projects\\<slug>\\    每个项目的运行目录（config、run、pgdata、logs 等）

构建（生成 exe）

```bat
npm i -D postject
node build\\build-sea.mjs
```

更多信息

仓库内保留了详细设计、已知限制与大量验证脚本（verify-*.mjs），用于端到端检查、端口分配、engine 清理、旧部署迁移与退出流程的回归测试。欢迎提交 issue / PR。