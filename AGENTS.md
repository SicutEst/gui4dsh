# AGENTS.md — gui4dsh 开发指南

面向在本仓库工作的 AI 协作者（以及新加入的人类开发者）。遵守根目录 `.zcode/AGENTS.md`（或 `~/.zcode/AGENTS.md`）中的全局规则；本文件只写本项目的事。

## 这是什么产品

为 **dsh（DeepSeek Harness，`@deepseek-ai/dsh`）** 打造的 Web 前端 + 网关，核心差异化是**手机远程访问**（配对、推送、公网穿透向导）。定位是"dsh Web 底座 + 手机远程 + 增量功能"，不是 dsh 的替代品。

- 仓库：https://github.com/SicutEst/gui4dsh
- npm：`gui4dsh`（`npx gui4dsh` 即用，Node ≥ 20）
- 协议：MIT

## 项目结构与构建

```
server/   Node 网关（Fastify）：dsh 进程管理、Typert RPC 客户端适配、事件桥、
          推送/FRP/DDNS/ACME/闲时队列/浏览器 MCP/回收站/Desktop 同步
web/      React 18 + Vite 前端：zustand + immer 事件折叠、i18n（中/英双语，两处都要加 key）
pack.mjs  npm 包组装（bin + server/dist + web/dist → release/）
```

```bash
npm install
npm run build        # server (tsc) + web (vite) 各自 build，都在各自目录下
npm start            # http://127.0.0.1:7420
```

**发布流程**：改版本号（根/server/web 三处 package.json + api.ts 硬编码）→ 双端 build → `node pack.mjs` → 烟测（干净目录装 tarball、隔离端口启动、验证 /api/fe/verify）→ npm publish。

## 开发约定（重要）

### 文档同步（全局规则，本项目严格执行）
- 每次功能/修复合入前更新 **CHANGELOG.md**；README 受影响时同步。
- 发版时 CHANGELOG 按版本分组完整整理，README 全量对齐。

### dsh 适配铁律
- dsh 是外部依赖（`@deepseek-ai/dsh`，当前 0.1.7-rc.2，npm `next` 标签）。加功能前先读 `node_modules/@deepseek-ai/dsh-*` 对应包的 README.zh.md 和 `.d.ts`，确认协议形状；不够就对运行中的 dsh 发探测请求实证——**不要猜端点**。
- 参数包装阶梯（`server/src/dsh/client.ts` unary）：`{_request}` → `{request}` → 平铺 → `{}`；0.1.7 的校验错误码是 `gateway/input-invalid`（旧版是 `arguments-invalid`），两种都要重试。
- dsh 会话日志是 zstd 多帧 JSON 行；**日志头绑定原始存储路径**，移动/恢复必须放回 header 记录的目录，放错会导致 workspace registry 起不来、全列表瘫痪。
- dsh 没有删除/编辑 API——回收站与编辑重答在网关存储层实现（见 trash.ts / editor.ts），必须走"备份 → 改写 → 重启 dsh → 验证 → 失败自动还原"的安全链。

### 部署形态红线
- 生产实例跑在 **Windows 服务（WinSW）+ SYSTEM 账户**下：任何"打开桌面窗口"类功能都会失败或挂起（会话 0 隔离），必须带超时 + 降级路径。
- **绝对禁止**重启/关机宿主机（全局规则）；网关自身的 `/api/fe/gateway/restart` 和 dsh 进程回收是允许的（不碰系统网络栈）。
- 不碰系统网络配置（网卡/路由/防火墙/DNS）——用户经 RDP 使用本机，断联即事故。

### 功能边界
- 只做用户点名的功能；"顺手值得加"的想法先列出等确认。
- dsh 已有的引擎能力不重做；dsh 自带 Web 端的界面功能在 gui 复刻属于"对齐底座"，是正当工作。

## 常用调试入口

- 网关健康：`GET /api/fe/health`；dsh 透传：`POST /api/dsh/<ns>.<method>`（白名单见 api.ts 的 DSH_METHOD_RE）
- 服务日志：`service/logs/gui4dsh-service.{out,err}.log`（dsh 子进程输出在 err.log）
- 凭证：`~/.dsh/.credentials.yaml`（version 必须是数字 `1`）
- 数据目录：网关 `~/.gui4dsh/store.json`；dsh `~/.dsh/`（sessions/、storages/workspace.json、trash/、quarantine-*/）
