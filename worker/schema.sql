-- malu-board D1 schema（Cloudflare D1 = SQLite）
-- 一名玩家一行：streak / 迟到天数 / 个人最佳到达 / 个人最长迟到全在一行里，
-- 榜单由 SQL 现算，不维护手工排序列表。
CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,                    -- 前端匿名设备 id（localStorage malu-player-id）
  nickname TEXT NOT NULL DEFAULT '匿名车手',
  current_streak INTEGER NOT NULL DEFAULT 0,  -- 当前连续准时天数
  best_streak INTEGER NOT NULL DEFAULT 0,     -- 历史最长连续准时天数
  late_days INTEGER NOT NULL DEFAULT 0,       -- 累计迟到天数
  last_played_date TEXT NOT NULL DEFAULT '',  -- 最近一次计入的日期 YYYY-MM-DD
  best_arrival_seconds INTEGER,               -- 准时日的最早到达（8:00 起的秒数）
  best_arrival_date TEXT,
  worst_late_minutes REAL,                    -- 最长迟到分钟数
  worst_late_date TEXT,
  games INTEGER NOT NULL DEFAULT 0,           -- 计入的天数（每天最多 1）
  last_submit_at INTEGER NOT NULL DEFAULT 0,  -- 上次提交毫秒时间戳（20 秒节流）
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_players_streak ON players(current_streak DESC, best_streak DESC);
CREATE INDEX IF NOT EXISTS idx_players_late ON players(late_days DESC);
CREATE INDEX IF NOT EXISTS idx_players_arrival ON players(best_arrival_seconds ASC);
CREATE INDEX IF NOT EXISTS idx_players_late_time ON players(worst_late_minutes DESC);

-- 简易 IP 限流：每小时计数，Worker 代码里查。
CREATE TABLE IF NOT EXISTS ip_hits (
  ip TEXT NOT NULL,
  hour TEXT NOT NULL,   -- UTC 小时，形如 2026-11-12T19
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, hour)
);
