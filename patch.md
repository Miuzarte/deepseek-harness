# 这个 fork 改了什么

基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 fork，**不合并回上游**。改动是 `master` 上叠加的几个提交，上游每次更新由 `.github/workflows/sync-upstream.yml` 自动 rebase 后 force-push。

查看当前差异：

```sh
git fetch upstream
git diff upstream/master..master --stat
```

同步到上游 `0.2.1-rc.2` 时删掉了两处上游已经实现、本 fork 不再需要维护的补丁：

| 删掉的本地补丁 | 上游现在的实现 |
| :-- | :-- |
| 远程 authority 可读写 Host 设置 | 自 2026-09-15 起，所有通过浏览器认证的页面（包括 trusted remote 与 public URL）共用 Host 设置文档；`ui-settings` 的持久化不再按 loopback 页面选择。[上游说明](.agents/notes/implemented/bug-fix/2026-09-15-authenticated-browser-host-preferences.md) |
| `koffi` / `node-pty` / `sharp` 的惰性加载 | 上游新增 `@deepseek-ai/dsh-lazy-require`，`win32-process`、`subprocess-local`、`sandbox-windows-acl`、`attachment-local` 都改成首次使用时 `require`，ABI 尺寸断言也随结构体构建延后。本 fork 只保留没有上游等价物的 `lease.ts` 回退（见下文“会话锁”）。 |

## 1. 外观按浏览器本地持久化

**问题**：主题、字号、字体存在 `$DSH_HOME/settings.yaml` 的 `ui-theme` 段，所有浏览器共享一份，桌面和手机没法用不同字号。

**做法**：`ui-theme` 的实际值改存浏览器 `localStorage`（key `dsh.theme`）；Host 的 `ui-theme` 段降级为“新浏览器的默认值”。启动脚本改为**先读 localStorage、再回退到服务端注入值**——脚本在 `<body>` 开头同步执行，所以首屏不会闪烁。

持久化的字段覆盖 `preference`、三个角色的字号（`fontSize` / `codeFontSize` / `terminalFontSize`）与三个FontFamily 字段；字段级合并，localStorage 里只写用户改过的键，Host 的新默认值仍能落到未覆盖的字段。写失败（隐私模式、配额满）只丢持久化，当前页面继续用内存值。

涉及 `packages/client/ui-theme/`、`apps/web/tests/settings-chrome.e2e.ts`。

`localStorage` 按 origin 隔离：同一台设备用 LAN IP 和 ZeroTier IP 访问算两个站点，各存一份。想让一台设备只有一个字号，就固定用同一个域名访问。

## 2. 会话与附件发布在无硬链接的平台退化为独占拷贝

**问题**：会话持久化用 `fs.link()` 做**不覆盖**的原子发布（`link` 在目标已存在时返回 `EEXIST`），而安卓 10+ 在应用数据目录里**禁止硬链接**，于是每次创建会话、落盘附件或新建工作区文件都以 `EACCES` 结束。

**做法**：所有 `link()` 的“不覆盖发布”都有同一套退路：`link` 报 `EACCES` / `EPERM` / `ENOTSUP` / `ENOSYS` 时改用 `copyFile(..., COPYFILE_EXCL)`，`EEXIST` 仍按原逻辑当作“别人先发布”。

| 位置 | 作用 | 退路 |
| :-- | :-- | :-- |
| `session-persistence-jsonl/src/generation.ts` 的 `publishCurrentExclusive` | 发布 `session.v<版本>.jsonl.zstd` | 独占拷贝 + 目录 fsync |
| `session-persistence-jsonl/src/index.ts` 的 `materializePosix` | 发布会话日志 | 独占拷贝（整段本来就在 `/* v8 ignore */` 里，靠真机验证） |
| `fs-local/src/fsio.ts` 的 `writeFileAtomic` | 工具新建文件时用 link 保证“不覆盖” | 独占拷贝，并补一次 `open(target,'r+')` + `sync()`——link 的持久性继承自已 fsync 的暂存文件，copy 不继承 |
| `attachment-local/src/store.ts` 的 `publishImmutableAlias` / `publishStagedObject` | 附件内容寻址对象与别名 | 合并为 `publishExclusive`：link 被平台拒绝时独占拷贝；拷贝成功直接返回，撞车才校验摘要 |

判据是**错误码而不是平台**：link 能用的平台上行为不变，只有拒绝 link 的沙盒才降级。代价是目录项不再原子——崩在拷贝中间会留下半截 `current`，但后续读取都要先过 `verifyCurrentFile` / 摘要校验，所以是 fail-closed。

测试：`generation.spec.ts` 3 条、`fsio.spec.ts` 2 条、`store.spec.ts` 5 条。

## 3. 没有 flock 的平台把会话锁当作获取成功

**问题**：`SessionWriteLease.acquire` 依赖 `@deepseek-ai/node-addon-system/flock`。Android 没有该原生绑定，`tryLockExclusive` 抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`，会话一创建就失败。

**做法**：把 `ERR_FLOCK_UNSUPPORTED_PLATFORM` 视作获取成功（单进程假设，与模块注释里给浏览器 worker 的 stub 同理由）；争用与其它错误照旧抛出，持有的文件描述符仍在 `release()` 关闭。

涉及 `session-persistence-jsonl/src/lease.ts`，新增 `lease.spec.ts` 一条。

## 4. 部署方指定 bash 与 ripgrep 的可执行文件

**问题**：安卓上这两样都没有，而两处调用点都写死了查找方式：`bash-local` 写死 argv `['bash', '-c', …]` 靠 PATH；`tool-fs-search` 的 `resolveRgPath()` 取 pkg sidecar 或 `@vscode/ripgrep`，而后者没有 android-arm64 变体。

**做法**：调用点各加一个“部署方指定”的环境变量入口，判据是环境变量而不是平台；两个变量都不设时，行为与上游逐字一致。

| 环境变量 | 谁读 | 语义 |
| :-- | :-- | :-- |
| `DSH_BASH` | `bash-local/src/index.ts` 的 `shellExecutable()` | 设了且非空就用它，否则回退 PATH 上的 `bash` |
| `DSH_RG_PATH` | `tool-fs-search/src/search-core.ts` 的 `resolveRgPath()` | 设了且非空就用它，否则走原来的 pkg sidecar / `@vscode/ripgrep` |

安卓侧由 app 把变量指进 `nativeLibraryDir`（bash 与 rg 当 jniLibs 发）。Ubuntu 部署不需要设置这两个变量。

新增测试：`bash-local/tests/executor.spec.ts` 两条（`DSH_BASH` 指向替身脚本、`DSH_BASH=''` 视同没配），`tool-fs-search/tests/rg-sidecar.spec.ts` 两条（`DSH_RG_PATH` 优先、空值回退）。bash-local 的测试在 Windows 上被 `vitest.config.ts` 排除，只在 Linux / macOS 跑。

## 5. 全接口监听改成显式开关

**问题**：`--host 0.0.0.0` 被硬拒。部署方需要把 Web GUI 暴露给同一网络里的另一台设备，而绑具体网卡 IP 会随 DHCP 变化；同时 `connection` 的 Host/Origin 栅栏只接受 loopback、绑定 IP 字面量和 `--trusted-host`，通配绑定下远端浏览器用 LAN IP 访问仍然会被 403。

**做法**：把“一律拒绝”改成“要第二个旗标才放行”，并让这个旗标顺手接管 LAN authority：

| 旗标 | 语义 |
| :-- | :-- |
| `--host 0.0.0.0` | 单独用仍然报错，错误信息说明会暴露远程代码执行 |
| `--host 0.0.0.0 --allow-lan` | 放行；启动时枚举本机非 loopback IPv4 地址，加入 `webStartup.trustedHosts`（即 `/api` 的 browser-trust 栅栏），并在就绪行旁为每个地址打印一条带 token 的 `dsh web (LAN): …` URL |

`webserver` 的 `Config` 新增 `allowWildcard`（默认 `false`），schema 仍按解析后的地址值识别所有通配写法；`web-app` 的 `webserver` 行把 `allowWildcard` 接到 `ctx.webStartup.allowLan`。安全默认没变：不显式接管的部署仍然拿不到全接口绑定。

涉及 `packages/bundle/web-app/src/startup.ts`、`src/index.ts`、`cordis.patch.yml`、`packages/host/webserver/src/index.ts` 及其测试。

## 6. 附件落盘的祖先 fsync 在安卓上会撞 `/data/user/0`

**问题**：`read_image` 在 Android 上对任何 PNG 都失败，报 `EACCES: permission denied, open '/data/user/0'`。`ensureDurableDirectory` 为了让新建目录项落盘，会从 DSH_HOME 一路 fsync 到文件系统根；`/data/user/0` 是 `0711`，应用能穿过、不能读，而 `open(dir, O_RDONLY)` 要的正是读权限。

**做法**：`syncDirectory()` 遇到 `EACCES` / `EPERM` 的打不开目录就跳过，而不是让整个落盘失败。判据仍是错误码而不是平台；那些层属于平台（安装时就建好、早已落盘），能打开的那些层照样 fsync。

这条分支在开发机上不可达（`syncDirectory` 开头就 `process.platform === 'win32'` 返回，而 POSIX 桌面上每一级祖先都读得开），所以只能真机验证，代码在既有 `/* v8 ignore */` 段内。

## 7. 上游同步工作流

`.github/workflows/sync-upstream.yml`：每天 06:00 和 18:00（CST）检查上游，有新提交就 rebase → host 侧全量构建 → 重建 `ui-theme` 客户端产物 → 跑本 fork 改过的包测试 → `--force-with-lease` 推送。冲突或闸门失败时整个 job 失败，不会推送半成品。

闸门第一条构建命令不能省：全新 checkout 里没有任何 `lib/`，客户端 tsc 要 `lib/typert.*.d.ts`，bundle 要 `lib/types/`。所以顺序是 `pnpm run build:lib:host` → `tsc -b` → `bundle` → 跑测试。

推送用 secret `SYNC_TOKEN`，不用默认的 `GITHUB_TOKEN`：上游经常改 `.github/workflows/*`，而 GitHub 拒绝 App token 创建或更新 workflow 文件。**一次性配置**：仓库 Settings → Secrets and variables → Actions 新建 `SYNC_TOKEN`，值取一个能写本 fork 的 PAT——细粒度要 `Contents: write` + `Workflows: write`，经典要 `repo` + `workflow`。没配这个 secret 时 job 在第一步就明确报错。

上游自带的其它 workflow 已在本 fork 全部禁用（**仓库状态，不是代码**，不受 rebase 影响）。要临时跑某个：`gh workflow enable <id> -R Miuzarte/deepseek-harness`。

**上游新增的 workflow 文件会跟着 sync 落到 fork 并以 enabled 状态出现**：disable 是仓库状态、绑定 workflow ID，上游新加文件就是新 ID，得再禁一次。同步后检查一遍：`gh workflow list --all -R Miuzarte/deepseek-harness`，除 `sync-upstream` 外都应是 `disabled_manually`；有漏的就 `gh workflow disable <name> -R Miuzarte/deepseek-harness`。

## 8. Windows 桌面端改用 Git Bash（纯配置，不在仓库里）

**问题**：Windows 上 shipped profile 挂的是 `pwsh-sandbox` + `tool-pwsh`。Git Bash 的 MSYS 运行时在受限令牌沙箱里起不来（`couldn't create signal pipe` → `0xC0000142`），所以 bash 只在 `danger-full-access` 下可用——切到 `workspace-write` / `read-only` 时 shell 工具和持久终端会一起失效。

**做法**：全部落在 `$DSH_HOME`，不进仓库，因此不受上面的 rebase / 同步流程影响。

| 文件 | 改动 |
| :-- | :-- |
| `profiles/desktop/cordis.patch.yml` | `bash-sandbox` 开、`pwsh-sandbox` 关；`preset-standard` 整段覆盖（`tool-bash` 开、`tool-pwsh` 关）；`preset-ptc` / `preset-cordis` 停用；`optional-terminal-bash` 的 `shellPath` 指向 Git Bash |
| `cordis.patch.yml` + `plugins/dsh-shell-executable/` | 插件把 Git 的 `bin` 插到宿主 `PATH` 最前，并导出 `DSH_BASH` |

**为什么是 PATH 而不是 `DSH_BASH`**：从上游 release 装的桌面端，其 `dsh-bash-local` 不含 §4 的补丁（`grep -c DSH_BASH app.asar` → 0），变量没人读。而 `scrubbedParentEnv()` 每次 spawn 重新读 `process.env`、且只剥 `DSH_*` 与凭据形状的变量，`PATH` 保留——所以改“`bash` 这个名字解析到谁”对任何构建都成立。改用源码构建后 §4 生效，两条路指向同一文件，PATH 插件可以留着也可以删。

**代价**：`preset-standard` 那份拷贝和 app 版本强绑定。

踩过一次真事故：拷贝取自安装的 rc.2，而跑的是 rc.3 构建。rc.2 的 preset 比 rc.3 多一行 `tool-subagent-list-agents`（该子路径在 rc.3 已删除），于是 agent preset 导入失败——新会话只写出一个 175 字节的会话头，界面显示「会话不可用」、设置一直转圈，而旧会话（复用旧 revision）照常可用，很容易误判成启动器坏了。换版本时用当前构建的 `app.asar` 重新抽一次，判据是行数：rc.2 33 行、rc.3 32 行。

## 9. 桌面端宿主可绑定全部网卡（同一实例多前端）

**问题**：桌面端是「Electron 外壳 + 一个 host 进程」，窗口只是这个 host 的一个前端，托盘驻留也属于外壳。但 `apps/desktop-host/src/index.ts` 把绑定写死成 `--host 127.0.0.1 --port 0`，于是同一个实例无法从别的设备（家庭 LAN / ZeroTier）接入，端口还每次随机。

**做法**：三处改动，默认行为逐字不变。

| 位置 | 改动 |
| :-- | :-- |
| 启动参数 | `--host` / `--port` 改读 `DSH_DESKTOP_HOST` / `DSH_DESKTOP_PORT`，缺省仍是 `127.0.0.1` / `0` |
| 通配绑定 | `DSH_DESKTOP_HOST` 是通配地址时自动追加 `--allow-lan`，一个监听器同时覆盖回环、LAN 与 VPN |
| 窗口 URL | 保持回环 `//127.0.0.1:<端口>`；通配监听同样应答回环，具体网卡地址则在启动时直接报错退出 |

用法（回环给桌面窗口，LAN 与 ZeroTier 用浏览器打开）。**持久化写在 `%USERPROFILE%\.dsh\desktop.yml`**，不用每次开终端：

```yaml
# %USERPROFILE%\.dsh\desktop.yml
bind: 0.0.0.0
port: 3080
```

```powershell
& 'B:\Git\deepseek-harness\apps\desktop\.desktop-build\targets\win-x64\unsigned-artifacts\win-unpacked\DeepSeek Harness.exe'
```

读取顺序是环境变量 → `desktop.yml` → 默认值（`127.0.0.1` / 随机端口），所以临时覆盖仍然可以 `$env:DSH_DESKTOP_HOST=…` 再启动。文件里出现未知键、或 `port` 不是 0–65535 的整数，会在启动时直接报错，不会静默回退。

**为什么需要单独一个文件**：`.env` 这条路走不通——harness 把 `DSH_` 前缀列为引导保留名，任何 `.env` 里出现 `DSH_*` 都会被拒绝（防止克隆来的项目劫持启动环境）。而这两个值要在 profile 组合之前就读到，所以放在 home 目录下的 `desktop.yml`。

宿主启动时打印 `dsh web: …`（回环）和每个网卡一条 `dsh web (LAN): http://<ip>:3080/?token=…`；首次访问换 cookie，之后干净 URL 可长期收藏（secret 持久化在 credentials 里）。

**为什么不绑具体网卡地址**：窗口是 `dsh-app://app` 文档，它的 API 请求打到非回环地址就成了跨源请求，browser-trust 栅栏对 `Origin: dsh-app://app` 一律 403。实测同一请求：带浏览器源 → 401（通过栅栏，仅缺凭证），带桌面源 → 403。表现就是网页端正常、桌面端一直「正在加载设置」。通配绑定保留回环路由，两端才都成立，所以具体地址现在直接启动报错，而不是静默进入半可用状态。

**代价**：`--allow-lan` 会把本机每个非回环 IPv4 纳入 browser-trust 并打印——这台机器上就是 `192.168.1.100` 和 `192.168.168.100`。想只暴露 ZeroTier，需在防火墙上把端口限制到该网卡。

**实测**（2026-10-25，rc.3 构建）：无 token → 401；带 token → 303 换 cookie；带 cookie → 200（40 KB index）；伪造 `Host` → 拒绝；桌面源 → 403。按上面的方式启动后，桌面窗口与 `192.168.1.100` / `192.168.168.100` 两个浏览器前端**同时可用**，会话与后台任务共享同一个实例。

**注意**：只对源码构建生效，打包版要重新 `pnpm run package:desktop:win:x64:unsigned`（在 PowerShell 里跑；Git Bash 的 GNU tar 会把 `B:\` 当远程主机）。打包前必须清掉 `DSH_DESKTOP_HOST` / `DSH_DESKTOP_PORT`：`prepare:dsh` 会真的启动一次桌面宿主做冒烟测试，残留的变量会让它撞上上面那条守卫而失败。桌面端有 single-instance lock，测试前先退出已安装的实例。

## 服务器 / 新机器上同步

```sh
cd ~/git/deepseek-harness
git fetch origin
git reset --hard origin/master        # 不要用 git pull：上游 rebase 会重写历史
pnpm install --frozen-lockfile
pnpm run build
# 重启 dsh
```

**跨上游版本同步必须全量构建**。host 侧是源码启动（tsx 直接读 `src/`），改源码不用编译；但浏览器侧全是构建产物——每个 client 包的 `lib/client.js`，以及 `dsh web` 直接提供的 `@deepseek-ai/dsh-web-frontend/dist`。上游一次发布可能动几十个 client 包，只重建自己改过的包会留下旧 UI。`pnpm run build` 还会重写 `.dsh-build/client-build-environment.json`；漏掉它，`test:web` 会报产物与记录不一致。

**上游没动、只有 fork 自己的提交变了时**，可以只重建改过的包：

```sh
pnpm --filter @deepseek-ai/dsh-client-ui-theme bundle   # 漏掉 → 字号/主题不跟随浏览器
```

## Ubuntu 服务器远程使用

以源码方式部署（host 走 tsx，浏览器产物走 `pnpm run build`）：

```sh
sudo apt-get update
sudo apt-get install -y git curl build-essential python3
# Node ^22.19 或 >=24；示例用 NodeSource 24.x
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pnpm@11.28.5

git clone https://github.com/Miuzarte/deepseek-harness.git ~/git/deepseek-harness
cd ~/git/deepseek-harness
pnpm install --frozen-lockfile
pnpm run build

# 只监听局域网 + 自动接纳本机 LAN 地址
pnpm dsh web --host 0.0.0.0 --allow-lan --port 3080 --no-open
```

启动行会打印 `dsh web: …` 和若干 `dsh web (LAN): …`；用后者在手机/另一台电脑打开。容器网桥（`docker0`、`br-<id>`）不会进入 LAN trust 或打印列表。

**更安全的做法**：如果服务器在 ZeroTier 上，直接绑 ZeroTier 地址（例如 `192.168.168.10`），只对该虚拟网络开放，也不需要 `--allow-lan`：

```sh
pnpm dsh web --host 192.168.168.10 --port 3080 --no-open
```

需要长期运行就套 systemd 或 tmux，并把 `DEEPSEEK_API_KEY` 放进 `~/.dsh/.credentials.yaml` 或环境变量。

**注意**：`--allow-lan` 把 GUI 暴露给整个可达网络；只应在家用/ZeroTier 等可信网络使用，或在前面加 TLS 反向代理并只用 `--trusted-host` 声明 authority。
