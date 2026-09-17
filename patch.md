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

判据是**错误码而不是平台**（`EACCES` / `EPERM` / `ENOTSUP` / `ENOSYS`）：link 能用的平台上行为一个字节都不变，只有拒绝 link 的沙盒才降级，所以 `generation.ts` 那段能在 Linux / macOS 上用注入的假 `link` 完整测到。`materializePosix` 整段本来就在 `/* v8 ignore start */` 里（原注释写着 link 失败是测试不可达的 TOCTOU 竞态），所以那边只做真机验证。

代价要写清楚：独占性还在（`O_CREAT|O_EXCL`，`EEXIST` 仍然是「别人先发布了」），但目录项不再原子 —— 崩在拷贝中间会留下半截 `current`，而任何后续读取都要先过 `verifyCurrentFile`，所以结果是 fail-closed 而不是静默损坏。

**同一类还没补的洞**（记录在此，别忘）：`packages/attachment/attachment-local/src/store.ts` 也靠 `link()` 做内容寻址对象的发布与别名（L283 别名、L359 首次发布）。附件存储是纯内容寻址 + 摘要校验，硬链接只是省空间的优化，所以退路同样可以是一次拷贝 —— 但那条链路在安卓上还没验证过，等用到附件（图片 / `present`）时再补，补的时候照这里的形状来。

**新增测试** 3 条（`tests/generation.spec.ts`）：拒绝 link 时靠拷贝发布成功、拷贝拿到 `EEXIST` 时接受已有的同一份目标、拷贝失败的 errno 原样抛出。

验证：`vitest run packages/session/session-persistence-jsonl` 463 通过（13 个文件），`generation.ts` 行/分支/函数覆盖仍 100%，`tsc -b tsconfig.host.json` 0 错；真机上 `link` 的两条路径都验过（会话会话创建 + 一轮完整对话）。

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
