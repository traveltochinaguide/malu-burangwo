# malu-board — 《不迟到算你赢》共享排行榜后端

Cloudflare Worker + D1，全网榜。**只写了代码，没有部署、没有建库**（按任务要求停在部署前）。

## 为什么选 D1 而不是 KV

榜单本质是“排序查询”：按连续准时局数 / 迟到局数 / 最早到达 / 最长迟到取前 N 名，
还要算“我排第几”。D1（SQLite）一条 `ORDER BY … LIMIT ?` 就解决，且每玩家一行、
`INSERT … ON CONFLICT` / 单行 `UPDATE` 是原子的，不会有并发写坏榜单的问题。
KV 只有按键读写，要做榜单得在 Worker 里手动维护排序列表（读-改-写），并发提交会丢
数据，还要自己处理分页和“我的排名”。D1 免费额度（每天 500 万行读、10 万行写）
对这个小游戏绰绰有余；KV 在这里没有成本优势。

## 文件

- `src/index.js` — Worker 全部逻辑（3 个端点，见下）
- `schema.sql` — D1 建表（`players` 一名玩家一行 + `ip_hits` 限流表）
- `wrangler.toml` — `database_id` 待填（建库后回填）

## 端点

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| GET | `/api/health` | — | `{ok:true}` |
| POST | `/api/submit` | JSON：`{playerId, nickname, date, onTime, arrivalSeconds, lateMinutes, score}` | `{ok, isNewDay, currentStreak, bestStreak, lateDays}`；非法 400，限流 429 |
| GET | `/api/board?tab=streak\|late\|arrival\|lateTime&limit=10&playerId=…` | — | `{ok, tab, rows:[{rank, nickname, value, date, best?, mine?}], mine:{rank, value, date, best?}\|null}` |

`value` 含义按 tab：连续准时榜 = 当前连续局数（`best` 为历史最长）；迟到榜 = 累计迟到局数；
到达时间榜 = 8:00 起的秒数（越小越早）；迟到时间榜 = 最长迟到分钟数。
`date` 是该数值对应的日期；`mine` 是请求玩家自己的名次（不在前 N 也返回）。

服务端 streak 规则（与前端本地规则一致）：每局都计，准时 → 当前连续 +1，
迟到 → 0 且迟到局数 +1；个人最佳（最早到达 / 最长迟到）每次提交都刷新。`games` 计总局数。

## 玩家身份（无登录）

- 每设备一个匿名 id：前端 `crypto.randomUUID()`，存 `localStorage malu-player-id`，
  每次提交带上。清浏览器数据 / 换设备 = 新玩家，旧 streak 找不回来（无账号可认领）。
- 昵称：玩家在排行榜面板里输一次，存 `localStorage malu-nickname`（1–12 字），
  每次提交带上；没填就是“匿名车手”。昵称不唯一、不预留，任何人都能用同名。
- 前端在每局结算后自动提交一次（`fetch` + `keepalive`，失败静默，不影响游戏和本地 streak）。

## 部署步骤（待用户拍板后执行，约 10 分钟）

```bash
cd ~/workspace/malu-burangwo/worker
export CLOUDFLARE_API_TOKEN="$(cat ~/.cloudflare-token-cf2)"   # cf2 账户
npx wrangler d1 create malu-board-db        # 把返回的 database_id 填进 wrangler.toml
npx wrangler d1 execute malu-board-db --remote --file=schema.sql
npx wrangler deploy                          # 得到 https://malu-board.<子域>.workers.dev
```

然后把 `index.html` 里的 `const BOARD_API=''` 改成部署后的 Worker 地址，
重新部署 Pages（`malu-burangwo` 项目）即可上线。部署前排行榜面板显示“即将上线”，
不发任何请求；部署后自动生效，无需改前端逻辑。
可选：绑自定义域名（如 `api.malu.aiarts.cc`）再填 `BOARD_API`，更稳、也更好看。

## 防刷：做了什么、没做什么（诚实版）

**做了：**
- 限流是主要防刷手段：同一玩家 20 秒内只能提交 1 次（每局至少 60 秒，正常游玩不受影响），重复 POST 会被 429 拦下。
- 数值合理性拦截：到达 8:00 起 3 小时内、迟到 0–180 分钟、得分 ≤100000，离谱值直接 400。
- 限流：同一玩家 20 秒内只能提交 1 次；同一 IP 每小时最多 120 次提交（D1 `ip_hits` 表）。
- 昵称清洗：去控制字符、最多 12 字；榜单渲染用 `textContent`，昵称里的 HTML 不会执行。
- CORS 只放行 `malu.aiarts.cc` 和 `malu-burangwo.pages.dev`（浏览器侧）。

**没做（公开端点 + 无登录，本质上防不住）：**
- 任何人都能用 `curl` 直接 POST 伪造战绩：换个 `playerId` 就是新玩家，
  编一个 8:00:01 到达、连续 365 局也能上榜。CORS 拦不住 curl。
- 昵称可冒充：没有“这个名字是我的”这种机制。
- 没有验证“这局真的玩了 60 秒”：服务端只收到一个结果数字。
- IP 限流在共用出口 IP / 代理面前会误伤或绕过。

**如果以后被刷了怎么办：** 先在 D1 里删记录
（`wrangler d1 execute malu-board-db --remote --command "DELETE FROM players WHERE id='…'"`），
再考虑升级：① 服务端发一次性对局 token，前端按局内事件签名提交（工作量大，
且纯前端仍可逆向）；② 接入 Turnstile / 账号登录（改动大，需用户拍板）。
目前的量级（小游戏、日活低）下，限流 + 合理性拦截 + 人工清理足够。

## 待用户拍板的点

1. **部署**：上面 5 条命令 + 回填 `BOARD_API`，是否现在做？（本次任务明确不部署。）
2. **昵称默认**：没填昵称显示“匿名车手”——是否接受同名匿名玩家并列？
3. **数据清理**：是否需要一个管理接口 / 定期清理脚本？目前只有手动 SQL。
4. **自定义域名**：用 `workers.dev` 直连，还是绑 `api.malu.aiarts.cc`？
