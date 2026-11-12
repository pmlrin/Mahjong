# 一桌 · 好友立直麻将

前后端分开的四人网页麻将。React + TypeScript 前端，Express + Socket.IO 后端；生产使用 PostgreSQL，本地可直接用 SQLite。规则基线在 `docs/`。

当前源码为 **0.4.2**，实时协议仍为 2.0。新增快速出牌、自动摸切、不鸣牌和键盘操作；四项默认关闭，共用动作提交锁与回执恢复。保留 V4.1 头像、玩法说明、役图鉴及既有账号、好友和麻将玩法。

**V4.2 与新版界面已于 2026-11-12 正式上线。** 包含靛蓝配色、横屏 3D 牌桌及四项操作控制；竖屏或设备不支持时回退平面牌桌。167 项自动回归、17 组 Chrome 操作场景及 200 场模拟通过；停服备份恢复至隔离库，29 张表的行数与摘要一致。Safari、Windows 和手机真机仍待验证。见[上线记录](docs/第四版增量与界面美化上线记录-v4.2.md)、[操作说明](docs/第四版增量功能-v4.2.md)和[原本地验证记录](docs/第四版增量实现与验证记录-v4.2.md)。

**v4.1 已于 2026-11-02 更新正式站及隔离预览。** 124 项回归测试通过，收尾改动经定向复验；桌面与390像素窄屏、双库头像存储、29表备份恢复及公网整场脚本比赛通过。功能入口和验证边界见[第四版增量功能](docs/第四版增量功能-v4.1.md)及[实现与上线记录](docs/第四版增量实现与上线记录-v4.1.md)。

第四版已于 **2026-11-02 正式上线**至 [mahjong.yangjm.cn](https://mahjong.yangjm.cn/)。118 项自动测试、双库迁移恢复及两组十桌五分钟脚本负载通过；正式旧身份与历史保留，公网完整脚本比赛和牌谱通过，上线后 28 表一致快照备份恢复通过。用户要求直接上线，真实双账号与分项真机验收继续待补。见[第四版正式上线记录](docs/第四版正式上线记录-v4.0.md)、[实现与验收记录](docs/第四版实现与验收记录-v4.0.md)、[资料与好友接口](docs/账号资料与好友接口-v4.0.md)和[配置与迁移](docs/第四版配置与迁移-v4.0.md)。

前版第三版于 2026-11-01 上线，原 101 项测试、真实账号邮件与发布证据保留在[第三版实现与验收记录](docs/第三版实现与验收记录-v3.0.md)。正式与预览账号不互通；既有 V2／V3 未关闭的质量项继续追踪。

## 本地运行

需要 Node.js 24.7+（当前验证版本 24.22.1） 和 pnpm 11+。

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 `http://127.0.0.1:3000`。游客、房间和对局保存至 `data/mahjong.sqlite`，不要删除它来“刷新页面”。生产环境必须配置 `DATABASE_URL`、`PUBLIC_ORIGIN`、`SESSION_SECRET`。

界面开发时可分别运行 `pnpm dev` 和 `pnpm dev:ui`，通过 `http://127.0.0.1:5173` 访问，Vite 代理 API 和 Socket.IO；前端开发时将后端 PUBLIC_ORIGIN 设为 http://127.0.0.1:5173。

## 账号与邮件

默认保留游客，未配置 SMTP 时禁用注册和找回，已有账号的密码登录独立保留。配置示例为 [.env.auth.example](.env.auth.example)。

```sh
pnpm auth:configure
# 在生成的 .env.auth.local 中安全填写 SMTP_PASSWORD 和预览收件白名单。
# 不要发送密码到聊天，不要提交该文件。
node --env-file=.env.auth.local --import tsx backend/src/server.ts
```

个人入口可注册当前游客并保留原 userId；登录其他账号不合并游客记录。退出后返回未登录首页，选择游客试玩才创建新身份。正在控制牌局时先明确转托管；远端找回密码会撤销旧连接并保留原座位、点数和已提交动作。预览与正式账号分别保存。

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

- `frontend/`：首页、个人账号、房间、牌桌、操作、结算、规则、回放。
- `backend/src/engine.ts`：不依赖网络的规则状态机与结算。
- `backend/src/rules.ts`：计分／向听库适配、实体牌映射、立直后暗杠约束。
- `backend/src/server.ts`：身份、房间、实时同步、串行事务、回执与恢复。
- `backend/src/store.ts`：PostgreSQL 与本地 SQLite 存储。
- `backend/src/auth/`：认证、迁移、会话、验证码、发信队列与限流。
- `backend/src/social/`：资料、设备、好友、邀请、快照、事务与清理。
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

后续页面视觉改造见 [Claude 页面美化交接文档](docs/Claude页面美化交接.md)，包含源码入口、操作约束、本地预览与验收步骤。

独立预览（当前 V4.1）：[mahjong.yangjm.cn/preview/](https://mahjong.yangjm.cn/preview/)。它使用独立 Cookie 与数据库，账号、好友与成绩不跨环境同步。

离线迁移：`node --import tsx backend/src/migrate.ts`；重建摘要添加 `--rebuild`。先在备份副本演练，生产切换按维护流程执行，不能让两个进程同时写同一个库。
