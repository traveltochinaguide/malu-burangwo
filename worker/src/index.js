// malu-board — 《不迟到算你赢》共享排行榜后端
// Cloudflare Worker + D1（免费套餐够用）。部署步骤见同目录 README.md。
// 设计要点：
// - 玩家无登录：每设备一个匿名 id（前端 crypto.randomUUID，存 localStorage）+ 自填昵称。
// - 每局都计：每次提交都计 streak / 迟到局数；防刷靠 20 秒限流（每局至少 60 秒）。
// - 榜单全部由 SQL 现算（ORDER BY + LIMIT），不维护手工排序列表，无读写竞态。
// - 防刷只做到“抬高门槛 + 限流”，公开端点无登录本质上防不住伪造，见 README.md。
'use strict';

const ALLOWED_ORIGINS = new Set([
  'https://malu.aiarts.cc',
  'https://malu-burangwo.pages.dev',
]);
const TABS = ['streak', 'late', 'arrival', 'lateTime'];
const LIMIT_MAX = 20;
const SUBMIT_MIN_INTERVAL_MS = 20_000; // 同一玩家两次提交至少间隔 20 秒
const IP_HOUR_LIMIT = 120;             // 同一 IP 每小时最多 120 次提交
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;


function corsHeaders(origin) {
  const headers = { vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['access-control-allow-origin'] = origin;
  }
  return headers;
}

function json(body, status = 200, origin = '') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders(origin) },
  });
}

function cleanNickname(raw) {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return s ? [...s].slice(0, 12).join('') : '匿名车手';
}

// 数值合理性上限：到达 8:00 起 3 小时内，迟到 0–180 分钟，得分 0–100000。
// 这些只是“离谱值拦截”，不是防作弊——前端算出的任何数都能被伪造后直发。
function validateSubmit(b) {
  if (!b || typeof b !== 'object') return 'bad body';
  if (typeof b.playerId !== 'string' || !PLAYER_ID_RE.test(b.playerId)) return 'bad playerId';
  if (typeof b.date !== 'string' || !DATE_RE.test(b.date)) return 'bad date';
  if (typeof b.onTime !== 'boolean') return 'bad onTime';
  if (b.onTime && (!Number.isSafeInteger(b.arrivalSeconds) || b.arrivalSeconds < 0 || b.arrivalSeconds > 10800)) return 'bad arrivalSeconds';
  if (!b.onTime && b.arrivalSeconds != null) return 'bad arrivalSeconds';
  if (typeof b.lateMinutes !== 'number' || !(b.lateMinutes >= 0) || b.lateMinutes > 180) return 'bad lateMinutes';
  if (b.score != null && (!Number.isSafeInteger(b.score) || b.score < 0 || b.score > 100000)) return 'bad score';
  return null;
}

async function checkIpLimit(db, ip) {
  const hour = new Date().toISOString().slice(0, 13); // UTC 小时
  const row = await db.prepare('SELECT n FROM ip_hits WHERE ip=? AND hour=?').bind(ip, hour).first();
  if (row && row.n >= IP_HOUR_LIMIT) return false;
  await db.prepare(
    'INSERT INTO ip_hits(ip,hour,n) VALUES(?,?,1) ON CONFLICT(ip,hour) DO UPDATE SET n=n+1'
  ).bind(ip, hour).run();
  return true;
}

async function handleSubmit(env, req, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'bad json' }, 400, origin); }
  const err = validateSubmit(body);
  if (err) return json({ ok: false, error: err }, 400, origin);
  const db = env.DB;
  const ip = req.headers.get('cf-connecting-ip') || 'unknown';
  if (!(await checkIpLimit(db, ip))) return json({ ok: false, error: 'rate limited' }, 429, origin);

  const now = Date.now();
  const nickname = cleanNickname(body.nickname);
  const row = await db.prepare('SELECT * FROM players WHERE id=?').bind(body.playerId).first();
  if (row && now - (row.last_submit_at || 0) < SUBMIT_MIN_INTERVAL_MS) {
    return json({ ok: false, error: 'too fast' }, 429, origin);
  }

  let currentStreak, bestStreak, lateDays, lastPlayedDate;
  let bestArrivalSeconds, bestArrivalDate, worstLateMinutes, worstLateDate, games;
  if (!row) {
    currentStreak = body.onTime ? 1 : 0;
    bestStreak = currentStreak;
    lateDays = body.onTime ? 0 : 1;
    lastPlayedDate = body.date;
    bestArrivalSeconds = body.onTime ? body.arrivalSeconds : null;
    bestArrivalDate = body.onTime ? body.date : null;
    worstLateMinutes = body.onTime ? null : body.lateMinutes;
    worstLateDate = body.onTime ? null : body.date;
    games = 1;
    await db.prepare(
      `INSERT INTO players(id,nickname,current_streak,best_streak,late_days,last_played_date,
        best_arrival_seconds,best_arrival_date,worst_late_minutes,worst_late_date,games,last_submit_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(body.playerId, nickname, currentStreak, bestStreak, lateDays, lastPlayedDate,
      bestArrivalSeconds, bestArrivalDate, worstLateMinutes, worstLateDate, games, now, now).run();
  } else {
    currentStreak = row.current_streak;
    bestStreak = row.best_streak;
    lateDays = row.late_days;
    lastPlayedDate = row.last_played_date;
    bestArrivalSeconds = row.best_arrival_seconds;
    bestArrivalDate = row.best_arrival_date;
    worstLateMinutes = row.worst_late_minutes;
    worstLateDate = row.worst_late_date;
    games = row.games;
    if (body.onTime) {
      currentStreak = row.current_streak + 1;
    } else {
      currentStreak = 0;
      lateDays = row.late_days + 1;
    }
    lastPlayedDate = body.date;
    games = row.games + 1;
    if (currentStreak > bestStreak) bestStreak = currentStreak;
    if (body.onTime && (bestArrivalSeconds == null || body.arrivalSeconds < bestArrivalSeconds)) {
      bestArrivalSeconds = body.arrivalSeconds;
      bestArrivalDate = body.date;
    }
    if (!body.onTime && (worstLateMinutes == null || body.lateMinutes > worstLateMinutes)) {
      worstLateMinutes = body.lateMinutes;
      worstLateDate = body.date;
    }
    await db.prepare(
      `UPDATE players SET nickname=?,current_streak=?,best_streak=?,late_days=?,last_played_date=?,
        best_arrival_seconds=?,best_arrival_date=?,worst_late_minutes=?,worst_late_date=?,games=?,
        last_submit_at=?,updated_at=? WHERE id=?`
    ).bind(nickname, currentStreak, bestStreak, lateDays, lastPlayedDate,
      bestArrivalSeconds, bestArrivalDate, worstLateMinutes, worstLateDate, games, now, now,
      body.playerId).run();
  }
  return json({ ok: true, currentStreak, bestStreak, lateDays }, 200, origin);
}

const BOARD_QUERIES = {
  streak: {
    sql: `SELECT id,nickname,current_streak AS value,best_streak AS best,last_played_date AS date
          FROM players WHERE current_streak>0 ORDER BY current_streak DESC,best_streak DESC,updated_at ASC LIMIT ?`,
    rankSql: 'SELECT COUNT(*)+1 AS rank FROM players WHERE current_streak>?',
  },
  late: {
    sql: `SELECT id,nickname,late_days AS value,last_played_date AS date
          FROM players WHERE late_days>0 ORDER BY late_days DESC,updated_at ASC LIMIT ?`,
    rankSql: 'SELECT COUNT(*)+1 AS rank FROM players WHERE late_days>?',
  },
  arrival: {
    sql: `SELECT id,nickname,best_arrival_seconds AS value,best_arrival_date AS date
          FROM players WHERE best_arrival_seconds IS NOT NULL ORDER BY best_arrival_seconds ASC,updated_at ASC LIMIT ?`,
    rankSql: 'SELECT COUNT(*)+1 AS rank FROM players WHERE best_arrival_seconds IS NOT NULL AND best_arrival_seconds<?',
  },
  lateTime: {
    sql: `SELECT id,nickname,worst_late_minutes AS value,worst_late_date AS date
          FROM players WHERE worst_late_minutes IS NOT NULL ORDER BY worst_late_minutes DESC,updated_at ASC LIMIT ?`,
    rankSql: 'SELECT COUNT(*)+1 AS rank FROM players WHERE worst_late_minutes IS NOT NULL AND worst_late_minutes>?',
  },
};

const MINE_QUERIES = {
  streak: 'SELECT current_streak AS value,best_streak AS best,last_played_date AS date FROM players WHERE id=?',
  late: 'SELECT late_days AS value,last_played_date AS date FROM players WHERE id=?',
  arrival: 'SELECT best_arrival_seconds AS value,best_arrival_date AS date FROM players WHERE id=?',
  lateTime: 'SELECT worst_late_minutes AS value,worst_late_date AS date FROM players WHERE id=?',
};

async function handleBoard(env, url, origin) {
  const tab = url.searchParams.get('tab') || 'streak';
  if (!TABS.includes(tab)) return json({ ok: false, error: 'bad tab' }, 400, origin);
  const limit = Math.max(1, Math.min(LIMIT_MAX, Number(url.searchParams.get('limit')) || 10));
  const playerId = url.searchParams.get('playerId') || '';
  const q = BOARD_QUERIES[tab];
  const db = env.DB;
  const { results } = await db.prepare(q.sql).bind(limit).all();
  const rows = results.map((r, i) => ({
    rank: i + 1,
    nickname: r.nickname,
    value: r.value,
    date: r.date || '',
    ...(r.best != null ? { best: r.best } : {}),
    ...(playerId && r.id === playerId ? { mine: true } : {}),
  }));
  let mine = null;
  if (playerId) {
    const me = await db.prepare(MINE_QUERIES[tab]).bind(playerId).first();
    if (me && me.value != null && me.value > 0) {
      const r = await db.prepare(q.rankSql).bind(me.value).first();
      mine = { rank: r ? r.rank : null, value: me.value, date: me.date || '', ...(me.best != null ? { best: me.best } : {}) };
    }
  }
  return json({ ok: true, tab, rows, mine }, 200, origin);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin') || '';
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(origin),
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        },
      });
    }
    try {
      if (url.pathname === '/api/health' && req.method === 'GET') return json({ ok: true }, 200, origin);
      if (url.pathname === '/api/submit' && req.method === 'POST') return await handleSubmit(env, req, origin);
      if (url.pathname === '/api/board' && req.method === 'GET') return await handleBoard(env, url, origin);
      return json({ ok: false, error: 'not found' }, 404, origin);
    } catch (e) {
      return json({ ok: false, error: 'server error' }, 500, origin);
    }
  },
};
