# ac-launcher — AgileCampus 本地部署启动器（中文版）

ac-launcher 是一个轻量的、本地运行的「部署中枢 / 启动器」，用于管理与监视多个 AgileCampus 源代码仓库的本地运行实例。它有两种主要运行形态：便携单文件可执行程序（Windows 下双击即可），以及面向开发者的 folder 模式（在源码外运行，读取仓库但不改写源）。

---

## 主要特性

- 两种运行形态：
  - folder（开发）模式：通过 `start.cmd` 或 `node main.mjs` 启动，适合调试与本地开发使用。
  - 单文件（便携）模式：编译为单个可执行文件（例如 `dist\\ac-launcher.exe`），可直接分发并运行。
- 启动器对源仓库保持只读；构建、数据库与运行数据保存在运行目录下，不污染源代码。
- 面板实现依赖 Node 内置模块，旨在能在执行 `npm ci` 之前就能运行以完成首次部署引导。
- 提供一系列验证脚本（verify-*.mjs）用于端到端检查：端口分配、引擎清理、旧部署迁移、退出流程回归等。

---

## 快速开始

1. 便携版（Windows）
   - 双击 `dist\\ac-launcher.exe`（若已存在），或把需要打开的仓库目录拖到 exe 上。
2. 开发 / 源码运行（推荐用于修改或调试）
   - 在仓库外任意目录运行（仓库目录作为参数或由 UI 注册）：
     - Windows：双击或运行 `start.cmd`
     - 直接用 Node：`node main.mjs` （需要 Node ≥20）

---

## 要求

- Node.js：建议 Node 20 或更高（仅在 folder 开发模式 / 打包时需要；便携 exe 内嵌 Node）
- Windows 优先（提供 start.cmd / dist 可执行），在类 Unix 系统上可用 Node 运行源码但部分便携打包流程/脚本以 Windows 为主

---

## 常用命令示例

命令行启动示例：
```
ac-launcher.exe                      # 打开中枢（显示已注册的项目）
ac-launcher.exe <仓库目录>           # 打开指定仓库的面板（或拖入仓库文件夹）
ac-launcher.exe --repo <路径>        # 显式指定仓库目录
```

常用选项：
- `--repo <路径>`：项目仓库目录（只读）
- `--runtime-dir <路径>`：运行目录（默认：%LOCALAPPDATA%\\AgileCampus）
- `--node <路径>`：指定用于构建/启��的 Node 可执行文件
- `--port <n>`：中枢端口，默认 8788（若被占用会顺延）
- `--no-open`：不自动打开浏览器
- `--selftest`：解析并打印配置后退出（用于排查）

---

## 运行目录结构（默认）

默认运行目录：%LOCALAPPDATA%\\AgileCampus\\
- projects.json            — 注册表（已登记的项目元数据）
- config\\hub.secret        — 监督令牌与密钥
- engine\\<hash>\\           — exe 释放的源码副本（按内容哈希）
- projects\\<slug>\\         — 每个项目的运行目录（包含 config、run、pgdata、logs 等）

运行时对源仓库保持只读，所有写入（数据库、构建缓存、日志等）都写到运行目录中，便于卸载与迁移。

---

## 构建（生成单文件 exe）

仓库中包含用于将 Node 与应用打包为单文件 exe 的流程，主要用于生成便携版：

示例（本地构建）：
```bat
npm i -D postject
npm run build
# 或直接：node build/build-sea.mjs
```

说明：
- 打包流程使用 `postject`（devDependency），负责将编译好的 SEA blob 注入 node.exe。注意：这些依赖仅在打包时使用；面板运行本身不依赖额外 npm 包。
- 生成产物通常放在 `dist\\` 下（示例：`dist\\ac-launcher.exe`）。

---

## 验证与自检脚本

仓库内留有多份 verify 脚本，用于在不同阶段执行自动检测与回归测试，包括：
- verify-preflight.mjs    — 启动前检查（端口、环境等）
- verify-ports.mjs        — 端口分配与冲突检测
- verify-realloc.mjs      — 资源重新分配与清理策略
- verify-shutdown.mjs     — 退出流程验证
- verify-hub-render.mjs   — 中枢渲染/界面检查
- verify-panelstate.mjs   — 面板状态一致性检查
- verify-legacypurge.mjs  — 旧部署与数据迁移回归测试
- verify-repo.mjs, verify-ui.mjs 等

可通过 npm 脚本运行部分校验：
```bash
npm run selftest
npm run verify:repo
npm run verify:ui
```

---

## 开发者说明

- 入口文件：`main.mjs`（启动逻辑）；`hub.mjs`（中枢逻辑）；`panel.mjs`（面板渲染/交互）
- Windows 启动脚本：`start.cmd`
- 打包构建脚本位于 `build\\`（例如 `build/build-sea.mjs`）
- 面板设计目标是“零 npm 运行时依赖”，以便在尚未执行 `npm ci` 的干净环境中也能运行并引导安装。

调试建议：
- 使用 `node main.mjs --selftest` 查看解析与配置输出
- 检查 `%LOCALAPPDATA%\\AgileCampus\\projects.json` 与运行目录中的日志（logs）获取问题线索

---

## 常见问题（FAQ）

Q：启动时报端口被占用怎么办？
A：Launcher 会尝试顺延端口。若你需要固定端口，请使用 `--port <n>` 并确保防火墙允许。

Q：面板会修改我的源码仓库吗？
A：不会。ac-launcher 对源仓库只读，所有构建/数据库/日志都写在运行目录里。

Q：更新源码后数据库报「列不存在 / 表不存在」，又不想丢数据怎么办？
A：点操作栏的「修复表结构（保留数据）」。它只把运行目录里那份源码的 `schema.ts` 推到数据库，不做构建、也不清空数据。遇到 `DROP TABLE` / `TRUNCATE` 这类会丢数据的变更时它会先停下来，把变更计划打在任务日志里；确认无误后再点一次「确认执行」才会真正执行。若仓库刚拉过新提交，先点「仅同步源码」，再修复表结构。

Q：换一台电脑部署时报 initdb 失败、数据库起不来，怎么排查？
A：先点「检修数据库」。它会逐项检查部署环境，并对常见失败给出可直接点的修复项：

- **initdb 一启动就退出，退出码 0xC0000135 / 0xC000007B / 0xC0000142**：目标电脑缺少 Microsoft Visual C++ 运行库（PostgreSQL 免安装包不自带）。安装 [VC++ 2015-2022 Redistributable (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) 后重试，装完不用重启。
- **提示「以管理员身份运行」**：PostgreSQL 明确拒绝管理员/root 身份启动。请关闭面板，用普通用户双击启动，不要右键「以管理员身份运行」。
- **上一次 initdb 没做完，`pgdata` 里有文件但没有 `PG_VERSION`**：面板会自动把这个目录原样改名到 `pgdata.broken-<时间>`（不删除，保留最近两份），然后重新初始化；检修里的「初始化数据簇并启动数据库（不删除现有文件）」也能做同样的事。
- **路径问题**：运行目录含非 ASCII 字符或路径接近 260 字符上限时，用 `--runtime-dir D:\ac-runtime` 换到更短的纯英文路径。
- **权限 / 杀毒软件**：把运行目录加入杀毒软件白名单，确认没有开启 Defender 的「受控文件夹访问」。
- **磁盘空间**：初始化数据簇与构建需要数百 MB，检修会显示运行目录所在磁盘的剩余空间。

启动数据库失败时，任务日志会带出运行目录 `logs\pg.log` 的末尾内容；原始错误比「60s 内没有起来」有用得多。

Q：目标电脑不能联网，或者下载 PostgreSQL 总是失败怎么办？
A：在任意能联网的电脑上下载 `https://get.enterprisedb.com/postgresql/postgresql-16.13-1-windows-x64-binaries.zip`，把 zip 原样放进运行目录的 `tmp\`（路径可在「设置」里看到，默认是 `%LOCALAPPDATA%\AgileCampus\projects\<slug>\tmp`），回到面板重新部署即可。版本号可以换成别的 16.x / 17.x，文件名必须保持 `postgresql-<版本>-windows-x64-binaries.zip` 的格式。

Q：如何手动清理旧 engine / 部署？
A：请参考运行目录下的 `engine\\<hash>` 子目录，或使用 verify-legacypurge 脚本进行受控清理（注意备份重要数据）。

---
