# 一桌 · 好友立直麻将

前后端分开的四人网页麻将。React + TypeScript 前端，Express + Socket.IO 后端；生产使用 PostgreSQL，本地可直接用 SQLite。规则基线在 `docs/`。

当前源码为 **0.2.0 次版预览**，协议 2.0。增加半庄、双档 AI、同桌再战、历史战绩、统计、回放定位与观看位置、紧凑牌桌和诊断入口。正式站仍保留 0.1.1；次版使用独立预览入口及数据库。真实设备等验收未全部完成，不宣称 V2 正式交付；见 `docs/次版实现与验收记录-v2.0.md`。

## 本地运行

需要 Node.js 24+ 和 pnpm 11+。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 `http://127.0.0.1:3000`。游客、房间和对局保存至 `data/mahjong.sqlite`，不要删除它来“刷新页面”。生产环境必须配置 `DATABASE_URL`、`PUBLIC_ORIGIN`、`SESSION_SECRET`。

界面开发时可分别运行 `pnpm dev` 和 `pnpm dev:ui`，通过 `http://127.0.0.1:5173` 访问，Vite 代理 API 和 Socket.IO；前端开发时将后端 PUBLIC_ORIGIN 设为 http://127.0.0.1:5173。

## 验证

```sh
pnpm test
pnpm simulate 100 EAST_ONLY
pnpm simulate 100 HANCHAN
pnpm build
pnpm package
```

`pnpm test` 包含规则固定局面，以及启动独立本地服务的多客户端测试。测试临时数据库位于系统临时目录，不接触开发或生产数据。联机测试使用仅限 `NODE_ENV=test` 的加速局间展示，不改变生产的 15/8/8 秒时限。

模拟工具使用持久化的确定性种子覆盖整个比赛，逐次操作检查 136 张实体牌与 100,000 点守恒。报告保存在 `reports/`。

## 源码

- `frontend/`：首页、房间、牌桌、操作、结算、规则、回放。
- `backend/src/engine.ts`：不依赖网络的规则状态机与结算。
- `backend/src/rules.ts`：计分／向听库适配、实体牌映射、立直后暗杠约束。
- `backend/src/server.ts`：身份、房间、实时同步、串行事务、回执与恢复。
- `backend/src/store.ts`：PostgreSQL 与本地 SQLite 存储。
- `backend/src/bot.ts`：仅接收座位可见视图的 BASIC／STANDARD 策略。
- `backend/src/history.ts`、`migration.ts`、`lobby.ts`：摘要、迁移和准备轮次。
- `shared/`：前后端协议类型及实体牌编码。
- `tests/`、`scripts/`：固定测试、联机测试、模拟和打包工具。
- `deploy/`：独立服务、数据库、HTTPS、备份配置。

## 部署

生产地址：<https://mahjong.yangjm.cn/>。使用阿里云现有青岛实例；麻将运行在专用目录、服务和 PostgreSQL 容器中。凭据仅留在服务器权限受限文件，不进入仓库。

详细启动、更新、回滚、备份与恢复见 `docs/部署与运维.md`。Docker Compose 为替代部署方式；本次服务器实际采用独立 Node.js 运行包 + systemd，因为 Docker Hub 网络不可用。

会话有效期 30 天；正常成绩和完整牌谱至少保留 30 天。当前没有自动删除比赛的任务，进行中的比赛不会过期清理。完整牌谱必须是正常结束后由本场参与者读取。

素材与开源许可证见 `THIRD_PARTY_NOTICES.md`。

次版预览：https://mahjong.yangjm.cn/preview/ 。它使用独立游客 Cookie 与数据库，旧版成绩和身份不会被预览覆盖。

离线迁移：`node --import tsx backend/src/migrate.ts`；重建摘要添加 `--rebuild`。先在备份副本演练，生产切换按维护流程执行，不能让两个进程同时写同一个库。
