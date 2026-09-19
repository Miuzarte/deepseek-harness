# 这个 fork 改了什么

基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的个人 fork，**不合并回上游**。改动是 `master` 上叠加的几个提交，上游每次更新由 `.github/workflows/sync-upstream.yml` 自动 rebase 后 force-push。

查看当前差异：

```sh
git fetch upstream
git diff upstream/master..master --stat
```

## 1. 远程 authority 可读写 Host 设置

**问题**：`dsh-client-ui-settings` 按「页面是否 loopback」决定设置持久化到 Host 文档还是只留在内存。从手机经 ZeroTier / 局域网访问时页面不是 loopback，Settings → Models 页报 `settings are unavailable in this browser`。

**做法**：Connection 在 `trustedHosts` 非空时注入全局量 `__DSH_CONNECTION_SERVES_REMOTE__`；ui-settings 读它，把部署已声明、且已通过 Host/Origin 校验与浏览器认证的 authority 也当作有权拥有 Host 设置文档。

涉及 `packages/client/connection/`、`packages/client/ui-settings/`。

## 2. 外观按浏览器本地持久化

**问题**：主题和字号存在 `$DSH_HOME/settings.yaml` 的 `ui-theme` 段，所有浏览器共享一份，桌面和手机没法用不同字号。

**做法**：`ui-theme` 的实际值改存浏览器 `localStorage`（key `dsh.theme`）；Host 的 `ui-theme` 段降级为「新浏览器的默认值」。启动脚本改为**先读 localStorage、再回退到服务端注入值**——脚本在 `<body>` 开头同步执行，所以首屏不会闪烁。

涉及 `packages/client/ui-theme/`、`apps/web/tests/settings-chrome.e2e.ts`。

## 3. 上游同步工作流

`.github/workflows/sync-upstream.yml`：每天 06:00 和 18:00（CST）检查上游，有新提交就 rebase → host 侧全量构建 → 重建两个客户端产物 → 跑测试 → `--force-with-lease` 推送。冲突或闸门失败时整个 job 失败，不会推送半成品。

闸门第一条构建命令不能省：全新 checkout 里没有任何 `lib/`，客户端 tsc 要 `lib/typert.*.d.ts`（`/remote` 子路径指向它），两个 bundle 要 `lib/types/`。所以顺序是 `pnpm run build:lib:host` → `tsc -b` 两个包 → `bundle` 两个包 → 跑三个 client 套件。

推送用 secret `SYNC_TOKEN`，不用默认的 `GITHUB_TOKEN`：上游经常改 `.github/workflows/*`，而 GitHub 拒绝 App token（含 `GITHUB_TOKEN`）创建或更新 workflow 文件，闸门全过了也会在最后一步报 `refusing to allow a GitHub App to create or update workflow`。**一次性配置**：仓库 Settings → Secrets and variables → Actions 新建 `SYNC_TOKEN`，值取一个能写本 fork 的 PAT——细粒度要 `Contents: write` + `Workflows: write`，经典要 `repo` + `workflow`。没配这个 secret 时 job 在第一步就明确报错。

上游自带的其它 workflow 已在本 fork 全部禁用（**仓库状态，不是代码**，不受 rebase 影响）。要临时跑某个：`gh workflow enable <id> -R Miuzarte/deepseek-harness`。

**上游新增的 workflow 文件会跟着 sync 落到 fork 并以 enabled 状态出现**：disable 是仓库状态、绑定 workflow ID，上游新加文件就是新 ID，得再禁一次。同步后检查一遍：`gh workflow list --all -R Miuzarte/deepseek-harness`，除 `sync-upstream` 外都应是 `disabled_manually`；有漏的就 `gh workflow disable <name> -R Miuzarte/deepseek-harness`。

## 4. 原生依赖惰性化（给没有预编译产物的平台）

**问题**：Android 上没有 `koffi` / `node-pty` / `sharp` / `@deepseek-ai/node-addon-system` 的预编译产物，而引用它们的地方是**模块顶层**的 `import` —— 所以「这个功能先不启用」救不了：只要 profile 树里有那条 row，import 就会执行，整棵 profile 跟着一起挂（实测 152 条 entry 里挂掉的正是 `subprocess` 和 `sandbox` 两条）。

`packages/attachment/attachment-local` 的 `image.ts` / `normalization.ts` / `request-image.ts` 顶层 import `sharp`，`packages/subprocess/subprocess-local/src/index.ts` 顶层 import `node-pty`，`packages/sandbox/sandbox-windows-acl/src/ffi.ts` 与 `packages/subprocess/win32-process/src/ffi.ts` 顶层 import `koffi`。运行期替身包救不了 `subprocess` / `sandbox`：`win32-process` 在**模块顶层**断言 struct 尺寸（`STARTUPINFOW layout mismatch: koffi computed 0, expected 104`），假 koffi 一读属性就露馅。

顺带一条平台限制，给安卓编原生依赖也躲不开：**`.node` 放在 app data 目录里大概率 dlopen 不了**（linker namespace 只认系统库和 APK 自己的 `nativeLibraryDir`），所以惰性化 + 降级才是正解。

**做法**：原生 import 换成**首次使用时才 require** 的访问器，用 `createRequire(import.meta.url)` 而不是 `await import()` —— 有两处调用方是同步的（`node-pty` 的 spawn 靠同步抛错，sharp 的图像流水线是同步函数），`await import` 会把错误抛到调用方的 `try/catch` 之外。

| 文件 | 改法 |
| :-- | :-- |
| `win32-process/src/ffi.ts` | `import koffi` → 包内唯一的惰性访问器 `koffi()`，两个 struct 与两条 ABI 尺寸断言改成首次使用时构建（导出从常量 `STARTUPINFOW` / `PROCESS_INFORMATION` 改成 `startupInfoStruct()` / `processInfoStruct()`） |
| `win32-process/src/process.ts` | 复用 `./ffi.ts` 的 `koffi()`，3 处 `koffi.free` 跟着改 |
| `subprocess-local/src/windows-inspector.ts` | 同上，惰性 `pvoid()` |
| `subprocess-local/src/linux-execve.ts` | 惰性 `koffi()` |
| `subprocess-local/src/index.ts` | `node-pty` → 惰性 `nodePty()`，`IPty` 走 `import type` 保持类型 |
| `sandbox-windows-acl/src/ffi.ts` | 惰性 `koffi()` + `pvoid()` / `ppvoid()` |
| `attachment-local/src/image.ts` `normalization.ts` `request-image.ts` | 惰性 `loadSharp()` |
| `session-persistence-jsonl/src/lease.ts` | `ERR_FLOCK_UNSUPPORTED_PLATFORM` 视作获取成功（单进程假设，与模块注释里给浏览器 worker 的 stub 同理由），争用与其它错误照旧 |

**对其它平台无行为变化**：惰性访问器缓存首次结果，ABI 断言从模块顶层挪到首次使用、但仍排在任何真实调用之前。`win32-process/src/ffi.ts` 的 default export 回退臂加了 `/* v8 ignore next */` —— 那条路取决于 koffi 的 CJS 桥长什么样、与输入无关，不加会挂掉仓库的 per-file 100% 分支覆盖门。

验证（在开发克隆里跑过）：`tsc -b tsconfig.host.json` 0 错，`build:lib:host` 成功，**产物里 eager 的 `koffi` / `node-pty` / `sharp` 共 0 处**，`vitest run packages/subprocess packages/sandbox packages/attachment packages/session` 2368 个测试通过，web profile 回归能起。

**和本 fork 的部署无关的部分**：fork 自己的服务器上 host 侧是**源码启动**（tsx 直接读 `src/`），这些改动不用重新构建；但把 host 侧打成构建产物分发时（例如 `scripts/release/pack.ts` 出的 tarball），改完必须重新构建。**pack 之前要先删 `packages/*/*/lib` / `apps/*/lib` / `vendor/*/lib` / `native/system/packages/*/lib`**：tsdown 是 `clean: false`，改完源码后带 eager `import koffi` 的陈旧 chunk 会留在 `lib/` 里，而各包 `files` 正好 glob `lib/runner-*.js` / `lib/types-*.js`，会被一起打进 tarball。

rebase 上游时如果上游动了这几个文件要重跑上面那套验证，尤其是那两个 ABI 尺寸断言的位置。

## 5. 会话持久化的独占发布在安卓上退化成独占拷贝

**问题**：会话持久化用 `fs.link()` 做**不覆盖**的原子发布（`link` 在目标已存在时返回 `EEXIST`），而安卓 10+ 在应用数据目录里**禁止硬链接**，于是每次创建会话都以这条错误结束：

```
EACCES: permission denied, link '.../sessions/<session>/session.v3.jsonl.zstd.<token>.tmp'
  -> '.../sessions/<session>/session.v3.jsonl.zstd'
```

实测确认过这不是我们自己的路径问题：`run-as <pkg> sh -c 'cd files && ln a b'` 同样 `Permission denied`（`context=u:r:runas_app:s0`），硬链接在 app data 里就是被平台挡掉的。

**做法**：这个包里**有两处** `link()` 发布，两处都要有退路。

| 位置 | 作用 | 退路 |
| :-- | :-- | :-- |
| `generation.ts` 的 `publishCurrentExclusive` | 发布 `session.v<版本>.jsonl.zstd` | `GenerationFileSystem` 加 `copyFile`，`isLinkUnavailable(error)` 时 `fs.copyFile(staged, currentPath, COPYFILE_EXCL)` |
| `index.ts` 的 `materializePosix` | 发布会话日志（`writeSyncedTempFile` 写 `<log>.<hex12>.tmp` 再 link） | 同一个 `isLinkUnavailable`（从 `generation.ts` 导出），改成 `copyFile(tmp, finalPath, COPYFILE_EXCL)` |
| `fs-local` 的 `writeFileAtomic` | 工具写新文件（`createIfAbsent`）时用 link 保证「不覆盖」 | 本包内自带一个同形的 `isLinkUnavailable`，改成 `copyFile(tempPath, absolutePath, COPYFILE_EXCL)`，**并补一次 `open(target,'r+')` + `sync()`** —— link 的持久性继承自已 fsync 的暂存文件，copy 不继承 |
| `attachment-local` 的 `publishImmutableAlias` / `publishStagedObject` | 附件（内容寻址对象与别名）的「不覆盖」发布 | 两处合成一个 `publishExclusive(source, target, sha256)`：link 失败且是平台拒绝时 `copyFile(..., COPYFILE_EXCL)`，`EEXIST` 仍走原来的摘要校验；拷贝成功即返回，拷贝撞车才去比摘要 |

`fs-local` 那条是写工作区文件时踩到的：暂存目录在 `/sdcard`（FUSE）上，`link` 同样被拒，于是模型连"新建一个文件"都做不到，报 `cannot write "...": EACCES ... link '...tmpdir/x.tmp' -> '.../x'`。它原有的 `throwGuardedCreateFailure` 已经会 inspect 目标来区分「撞车」和「没有硬链接支持」，所以退路只需在 `isLinkUnavailable` 为真时补一次拷贝，其余 errno 仍走原路。

判据是**错误码而不是平台**（`EACCES` / `EPERM` / `ENOTSUP` / `ENOSYS`）：link 能用的平台上行为一个字节都不变，只有拒绝 link 的沙盒才降级，所以 `generation.ts` 那段能在 Linux / macOS 上用注入的假 `link` 完整测到。`materializePosix` 整段本来就在 `/* v8 ignore start */` 里（原注释写着 link 失败是测试不可达的 TOCTOU 竞态），所以那边只做真机验证。

代价要写清楚：独占性还在（`O_CREAT|O_EXCL`，`EEXIST` 仍然是「别人先发布了」），但目录项不再原子 —— 崩在拷贝中间会留下半截 `current`，而任何后续读取都要先过 `verifyCurrentFile`，所以结果是 fail-closed 而不是静默损坏。

**附件那两处也补上了**：`attachment-local/src/store.ts` 的 `publishImmutableAlias` 与 `publishStagedObject` 同样用 `link()` 保「不覆盖」，现在合并成一个 `publishExclusive(source, target, sha256)`：平台拒绝 link 时退化成独占拷贝，拷贝自己成功就返回，`EEXIST`（无论是 link 还是 copy 报的）才去做摘要校验。内容寻址对象是只读且按摘要命名的，所以多一份字节换掉原子目录项可以接受。**新增测试** 3 条（`tests/generation.spec.ts`）+ 2 条（`tests/fsio.spec.ts`，其中一个把原来那条用 `EACCES` 断言 `FS_IO_ERROR` 的用例改成 `EIO`，因为 `EACCES` 现在会走退路）：拒绝 link 时靠拷贝发布成功、拷贝拿到 `EEXIST` 时接受已有目标 / 保留竞争者、拷贝失败的 errno 原样抛出。

验证：`vitest run packages/session/session-persistence-jsonl` 463 通过（13 个文件），`generation.ts` 行/分支/函数覆盖仍 100%；`vitest run packages/fs/fs-local` 151 通过，`fsio.ts` 新分支全覆盖；`tsc -b tsconfig.host.json` 0 错。真机上 `link` 的三条路径都验过（会话创建 + 一轮完整对话 + 写工作区新文件）。

## 6. 让部署方指定 bash 与 ripgrep 的可执行文件

**问题**：安卓上这两样都没有，而两处调用点都写死了查找方式：

| 调用点 | 找法 | 安卓上的结果 |
| :-- | :-- | :-- |
| `packages/shell/bash-local` | argv 写死 `['bash', '-c', …]`，靠 PATH | PATH 的七个目录里没有 bash（系统 shell 是 mksh），工具直接报 `spawn bash EACCES` |
| `packages/fs/tool-fs-search` 的 `resolveRgPath()` | `pkg` 单文件运行时取 `<execPath>-rg` sidecar，否则解析 `@vscode/ripgrep` 的平台包 | `@vscode/ripgrep` 没有 android-arm64 变体，工具报 `ripgrep launch failed` |

**不选 mksh 兜底**：`/system/bin/sh` 是 mksh（ksh 子集），`${v^^}` / `local -n` / `mapfile` / 花括号展开这些 bash 扩展没有，而模型是按 bash 写命令的 —— 那种「命令看着对、行为不对」的失败比直接报错更难查。工具链的缺口（只有 toybox 一套）换 shell 也治不了，那是另一场仗。

**做法**：真 bash 与真 rg 都**当 jniLibs 发**（和 Node 完全同一套：名字以 `.so` 结尾、SONAME/NEEDED 归一成 `liblw*`、每个对象带 `$ORIGIN`、16 KB 对齐），调用点只加一个「部署方指定」的入口：

| 环境变量 | 谁读 | 语义 |
| :-- | :-- | :-- |
| `DSH_BASH` | `bash-local/src/index.ts` 的 `shellExecutable()` | 设了且非空就用它，否则回退 PATH 上的 `bash` |
| `DSH_RG_PATH` | `tool-fs-search/src/search-core.ts` 的 `resolveRgPath()` | 设了且非空就用它，否则走原来的 pkg sidecar / `@vscode/ripgrep` |

判据是**环境变量而不是平台判断**：别的平台上两个变量都不设，行为与上游逐字一致；安卓这边由 app 把变量指进 `nativeLibraryDir`。

**产物（Termux 编的 bionic 二进制，已 patchelf）**：

| 对象 | 归一后 | 字节 |
| :-- | :-- | :-- |
| bash 5.3.15 | `liblwbash.so` | 1,132,857（patch 前 880,368） |
| libandroid-support | `liblwandroidsupport.so` | 67,865 |
| libreadline 8 | `liblwreadline.so` | 476,529 |
| libncursesw 6 | `liblwncursesw.so` | 405,537 |
| libiconv | `liblwiconv.so` | 1,116,049 |
| ripgrep 15.2.0 (+pcre2) | `liblwrg.so` | 4,918,377 |
| libpcre2-8 | `liblwpcre2.so` | 528,449 |

合计 +8.2 MiB（jniLibs 105,944,793 → 114,590,456）。注意 patchelf 会让文件变大（bash +29%），和当年 Node 那批一样。

**新增测试**：`bash-local/tests/executor.spec.ts` 两条（`DSH_BASH` 指向一个替身脚本时命令确实交给它跑、`DSH_BASH=''` 视同没配），`tool-fs-search/tests/rg-sidecar.spec.ts` 一条（`DSH_RG_PATH` 优先于任何打包产物）。**注意 bash-local 的测试在 Windows 上被 `vitest.config.ts` 排除**（没有 POSIX shell），所以这两条只在 Linux / macOS 上跑，安卓侧靠真机验证。

验证：`vitest run packages/attachment/attachment-local` 93 通过且 `store.ts` 覆盖 100%；`vitest run packages/fs/tool-fs-search` 覆盖 `search-core.ts` 100%；`tsc -b tsconfig.host.json` 0 错；`run-oxlint` 0 错；真机上 bash 与 rg 都跑通（见下）。

## 7. 全接口监听改成显式开关

**问题**：`--host` 本来就有，但 `--host 0.0.0.0` 被一条硬拒的安全闸挡下（`packages/bundle/web-app/src/startup.ts`）。部署方需要把 Web GUI 暴露给同一网络里的另一台设备，而绑具体网卡 IP 会随 DHCP 变化，绑 `0.0.0.0` 才是稳定写法；而且 `resolveLanTrust()` 与就绪行的 `(LAN: …)` 后缀本来就只对全接口绑定生效。

**做法**：不删那道闸，把它从「一律拒绝」改成「要第二个旗标才放行」：

| 旗标 | 语义 |
| :-- | :-- |
| `--host 0.0.0.0` | 单独用仍然报错，错误信息说明这会把 GUI 连同远程代码执行暴露给整个网络 |
| `--host 0.0.0.0 --allow-lan` | 放行，并按既有逻辑把 LAN 地址算进 `/api` 的 browser-trust 栅栏、在就绪行打印 `(LAN: <url>?token=…)` |

安全默认没变（不显式接管的部署仍然拿不到全接口绑定），而接管它的部署不必再改 dsh 源码。回环地址在 `0.0.0.0` 绑定下照旧可用，所以打印出的第一个 URL 与 `DSH_WEB_URL` 都不用动。

涉及 `packages/bundle/web-app/src/startup.ts`、`packages/bundle/web-app/tests/startup.spec.ts`（改写那条拒绝用例、新增一条放行用例、help 断言里加 `--allow-lan`）。

验证：`vitest run packages/bundle/web-app` 22 通过。

## 服务器 / 新机器上同步

```sh
cd ~/git/deepseek-harness
git fetch origin
git reset --hard origin/master        # 不要用 git pull：上游 rebase 会重写历史
pnpm install --frozen-lockfile
pnpm run build
# 重启 dsh
```

**跨上游版本同步必须全量构建**。host 侧是源码启动（tsx 直接读 `src/`），改源码不用编译；但浏览器侧全是构建产物——每个 client 包的 `lib/client.js`，以及 `dsh web` 直接提供的 `@deepseek-ai/dsh-web-frontend/dist`。上游一次发布可能动几十个 client 包，只重建自己改过的两个包会留下旧 UI（侧边栏、文件预览等）。`pnpm run build` 还会重写 `.dsh-build/client-build-environment.json`；漏掉它，`test:web` 会报产物与记录不一致。

**上游没动、只有 fork 自己的提交变了时**，可以只重建改过的包：

```sh
pnpm --filter @deepseek-ai/dsh-client-ui-settings bundle   # 漏掉 → 远程模型页报 unavailable
pnpm --filter @deepseek-ai/dsh-client-ui-theme bundle      # 漏掉 → 字号不跟随浏览器
```

## 注意

- **`localStorage` 按 origin 隔离**：同一台设备用 LAN IP 和 ZeroTier IP 访问算两个站点，各存一份字号。想让一台设备只有一个字号，就用同一个域名访问。
- **两个改动互不依赖**，可以只保留其一。
- 改动的包和要重建的包是两两对应的，别只重建一个；但只要这次同步跨了上游版本，就直接全量 `pnpm run build`。
