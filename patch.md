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
