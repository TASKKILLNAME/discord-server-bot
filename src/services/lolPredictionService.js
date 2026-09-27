const { EmbedBuilder, escapeMarkdown } = require('discord.js');
const {
  getAccountByRiotId,
  getRecentMatchIds,
  getMatchDetail,
} = require('./riotService');
const { SPY_CONFIG, calculateSpyPrediction } = require('./spyPrediction');

// ============================================
// ⚙️ 설정 (공식 API 규칙이 아닌 이 기능의 설계값)
// ============================================
const PREDICTION_CONFIG = Object.freeze({
  queueId: 420, // 개인/2인 랭크 게임
  platformId: 'KR',
  lookbackDays: 90,
  sampleSize: 20,
  maxMatchIds: 40,
  minGameDurationSec: 300, // 이 기능의 표본 제외 기준 (Riot 공식 다시하기 판정 아님)
  minSampleForEstimate: 5,
  priorWins: 10,
  priorLosses: 10,
  modelVersion: 'history-prior-v1',
  deadlineMs: 60 * 1000,
  resultCacheTtlMs: 3 * 60 * 1000,
  matchCacheTtlMs: 6 * 60 * 60 * 1000,
  resultCacheMaxEntries: 500,
  matchCacheMaxEntries: 2000,
  cooldownMs: 15 * 1000,
});

const ERROR_MESSAGES = {
  USAGE: '입력 방법이 올바르지 않습니다.',
  NO_API_KEY: 'Riot API 키가 설정되지 않아 승부예측을 사용할 수 없습니다. 관리자에게 문의해주세요.',
  ACCOUNT_NOT_FOUND: '소환사를 찾을 수 없습니다. 게임이름과 태그를 확인해주세요.',
  MATCH_LIST_NOT_FOUND: '전적 목록을 찾지 못했습니다. 잠시 후 다시 시도해주세요.',
  INVALID_MATCH_LIST: '전적 목록 형식이 예상과 달라 조회를 중단했습니다.',
  MATCH_NOT_FOUND: '일부 경기 상세 정보를 찾지 못해 이번 조회를 중단했습니다. 잠시 후 다시 시도해주세요.',
  INVALID_MATCH_DATA: '경기 데이터 형식이 예상과 달라 이번 조회를 중단했습니다.',
  TIMEOUT: '조회 시간(60초)을 초과했습니다. 잠시 후 다시 시도해주세요.',
  AUTH: 'Riot API 인증 또는 권한 문제로 조회하지 못했습니다. 관리자에게 API 키·제품 설정 확인을 요청해주세요.',
  RATE_LIMITED: 'Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.',
  UPSTREAM: 'Riot 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.',
  NETWORK: 'Riot 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',
  UNKNOWN: '승부예측 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
};

const USAGE_TEXT = [
  '**사용법**',
  '• `/전적 승부예측` — 내 등록 계정',
  '• `/전적 승부예측 멤버:@친구` — 멤버의 등록 계정',
  '• `/전적 승부예측 소환사명:게임이름 태그:KR1` — 직접 입력',
  '멤버와 소환사명·태그는 함께 쓸 수 없고, 소환사명과 태그는 둘 다 입력해야 합니다.',
].join('\n');

class PredictionError extends Error {
  constructor(code, detail) {
    super(detail || ERROR_MESSAGES[code] || code);
    this.name = 'PredictionError';
    this.code = code;
    this.userMessage = ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN;
  }
}

let now = () => Date.now();

// ============================================
// 🗃️ 크기·TTL 제한 인메모리 캐시
// ============================================
class BoundedTtlCache {
  constructor(ttlMs, maxEntries) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key, value) {
    this.map.delete(key);
    while (this.map.size >= this.maxEntries) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, { value, expiresAt: now() + this.ttlMs });
  }

  clear() {
    this.map.clear();
  }

  get size() {
    return this.map.size;
  }
}

const resultCache = new BoundedTtlCache(PREDICTION_CONFIG.resultCacheTtlMs, PREDICTION_CONFIG.resultCacheMaxEntries);
const matchCache = new BoundedTtlCache(PREDICTION_CONFIG.matchCacheTtlMs, PREDICTION_CONFIG.matchCacheMaxEntries);
const inflight = new Map();
const cooldowns = new Map();

// ============================================
// 🧮 계산 (순수 함수)
// ============================================

/**
 * 승리 참고 추정값 p = (w + 10) / (n + 20). n < 5이면 null.
 * winTenths/lossTenths는 표시용 0.1% 단위 정수이며 합은 항상 1000이다.
 */
function computeEstimate(sampleSize, wins) {
  const { minSampleForEstimate, priorWins, priorLosses } = PREDICTION_CONFIG;
  if (!Number.isInteger(sampleSize) || !Number.isInteger(wins) || wins < 0 || wins > sampleSize) {
    throw new RangeError('잘못된 표본 값');
  }
  if (sampleSize < minSampleForEstimate) return null;

  const numerator = wins + priorWins;
  const denominator = sampleSize + priorWins + priorLosses;
  const winTenths = Math.round((numerator * 1000) / denominator);
  return {
    winProbability: numerator / denominator,
    lossProbability: 1 - numerator / denominator,
    winTenths,
    lossTenths: 1000 - winTenths,
  };
}

function formatTenths(tenths) {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function formatWinRate(wins, total) {
  return formatTenths(Math.round((wins * 1000) / total));
}

/**
 * results: 최신순 승패(boolean) 배열
 */
function summarizeResults(results) {
  const n = results.length;
  const wins = results.filter(Boolean).length;
  const recent = results.slice(0, 5);
  const recentWins = recent.filter(Boolean).length;

  let streak = null;
  if (n > 0) {
    let count = 0;
    while (count < n && results[count] === results[0]) count++;
    streak = { win: results[0], count, atLeast: count === n };
  }

  return {
    sampleSize: n,
    wins,
    losses: n - wins,
    recent: { games: recent.length, wins: recentWins, losses: recent.length - recentWins },
    streak,
  };
}

// ============================================
// 🔎 매치 검증
// ============================================

/** 매치 상세를 판정에 필요한 필드만 남긴 형태로 줄인다. 구조가 깨졌으면 예외. */
function compactMatch(detail, expectedMatchId) {
  const info = detail?.info;
  if (!info || typeof info !== 'object' || !Array.isArray(info.participants)) {
    throw new PredictionError('INVALID_MATCH_DATA', `${expectedMatchId}: info/participants 없음`);
  }
  if (expectedMatchId && detail.metadata?.matchId && detail.metadata.matchId !== expectedMatchId) {
    throw new PredictionError('INVALID_MATCH_DATA', `${expectedMatchId}: matchId 불일치`);
  }
  if (!Number.isFinite(info.queueId) || !Number.isFinite(info.gameDuration) || typeof info.platformId !== 'string') {
    throw new PredictionError('INVALID_MATCH_DATA', `${expectedMatchId}: queueId/gameDuration/platformId 오류`);
  }

  const results = {};
  const players = [];
  for (const p of info.participants) {
    if (!p || typeof p.puuid !== 'string') continue;
    results[p.puuid] = p.win;
    // 첩자 계산용 (값 검증은 spyPrediction에서 하고, 이상하면 그 경기만 첩자 표본에서 빠진다)
    players.push({
      puuid: p.puuid,
      teamId: p.teamId,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      goldEarned: p.goldEarned,
      teamPosition: typeof p.teamPosition === 'string' && p.teamPosition ? p.teamPosition : null,
    });
  }

  return {
    matchId: expectedMatchId,
    platformId: info.platformId,
    queueId: info.queueId,
    gameDuration: info.gameDuration,
    gameEndTimestamp: Number.isFinite(info.gameEndTimestamp) ? info.gameEndTimestamp : null,
    endOfGameResult: typeof info.endOfGameResult === 'string' ? info.endOfGameResult : null,
    results,
    players,
  };
}

/**
 * 표본 포함 여부 판정. 제외는 { included: false, reason }, 데이터 오류는 예외.
 */
function evaluateMatch(match, puuid, cutoffMs) {
  const { queueId, platformId, minGameDurationSec } = PREDICTION_CONFIG;

  if (match.queueId !== queueId) return { included: false, reason: 'queue' };
  if (match.platformId.toUpperCase() !== platformId) return { included: false, reason: 'platform' };
  if (match.endOfGameResult && match.endOfGameResult !== 'GameComplete') {
    return { included: false, reason: 'notCompleted' };
  }
  if (match.gameEndTimestamp === null) {
    throw new PredictionError('INVALID_MATCH_DATA', `${match.matchId}: gameEndTimestamp 없음`);
  }
  if (match.gameEndTimestamp < cutoffMs) return { included: false, reason: 'period' };
  if (match.gameDuration < minGameDurationSec) return { included: false, reason: 'short' };

  if (!Object.prototype.hasOwnProperty.call(match.results, puuid)) {
    throw new PredictionError('INVALID_MATCH_DATA', `${match.matchId}: 대상 참가자 없음`);
  }
  const win = match.results[puuid];
  if (typeof win !== 'boolean') {
    throw new PredictionError('INVALID_MATCH_DATA', `${match.matchId}: win 필드 오류`);
  }
  return { included: true, win };
}

// ============================================
// 📥 수집
// ============================================
function throwIfAborted(signal) {
  if (signal?.aborted) throw new PredictionError('TIMEOUT');
}

async function loadMatch(matchId, signal) {
  const cached = matchCache.get(matchId);
  if (cached) return cached;

  const detail = await getMatchDetail(matchId, { signal });
  if (!detail) throw new PredictionError('MATCH_NOT_FOUND', `${matchId}: 404`);

  const match = compactMatch(detail, matchId);
  // 종료 시각이 있는 완료 경기만 캐시한다
  if (match.gameEndTimestamp !== null) matchCache.set(matchId, match);
  return match;
}

async function collectRecentGames(puuid, { signal } = {}) {
  const { queueId, lookbackDays, sampleSize, maxMatchIds } = PREDICTION_CONFIG;
  const cutoffMs = now() - lookbackDays * 24 * 60 * 60 * 1000;

  let ids;
  try {
    ids = await getRecentMatchIds(puuid, maxMatchIds, {
      queue: queueId,
      startTime: Math.floor(cutoffMs / 1000),
      signal,
      throwOnNotFound: true,
    });
  } catch (err) {
    if (err.notFound) throw new PredictionError('MATCH_LIST_NOT_FOUND');
    throw err;
  }
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new PredictionError('INVALID_MATCH_LIST');
  }

  const uniqueIds = [...new Set(ids)].slice(0, maxMatchIds);
  const games = [];
  const excluded = { queue: 0, platform: 0, notCompleted: 0, period: 0, short: 0 };

  for (const matchId of uniqueIds) {
    if (games.length >= sampleSize) break;
    throwIfAborted(signal);
    const match = await loadMatch(matchId, signal);
    const outcome = evaluateMatch(match, puuid, cutoffMs);
    if (outcome.included) {
      games.push({ matchId, win: outcome.win, endMs: match.gameEndTimestamp, match });
    } else {
      excluded[outcome.reason]++;
    }
  }

  games.sort((a, b) => b.endMs - a.endMs);
  return { games, excluded };
}

function buildPrediction(games, excluded, puuid) {
  const summary = summarizeResults(games.map((g) => g.win));
  return {
    modelVersion: PREDICTION_CONFIG.modelVersion,
    targetSampleSize: PREDICTION_CONFIG.sampleSize,
    ...summary,
    estimate: computeEstimate(summary.sampleSize, summary.wins),
    // 승부예측과 같은 경기 상세를 재사용하므로 추가 API 호출이 없다
    spy: calculateSpyPrediction(games, puuid),
    excluded,
  };
}

// ============================================
// ⏱️ 기한·공유·캐시
// ============================================
async function runWithDeadline(task, ms) {
  const controller = new AbortController();
  const timeoutError = new PredictionError('TIMEOUT');
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, Math.max(0, ms));
  });
  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 같은 PUUID·큐·모델 요청은 수집 작업 하나를 공유하고 결과를 3분간 캐시한다.
 */
async function getPrediction(puuid, { deadlineAt = Date.now() + PREDICTION_CONFIG.deadlineMs } = {}) {
  const key = `${puuid}:${PREDICTION_CONFIG.queueId}:${PREDICTION_CONFIG.modelVersion}:${SPY_CONFIG.modelVersion}`;

  const cached = resultCache.get(key);
  if (cached) return { ...cached, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const job = runWithDeadline((signal) => collectRecentGames(puuid, { signal }), deadlineAt - Date.now())
    .then(({ games, excluded }) => {
      const result = { ...buildPrediction(games, excluded, puuid), fetchedAt: now() };
      resultCache.set(key, result);
      return { ...result, cached: false };
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}

/**
 * target: { puuid?, gameName, tagLine } — puuid가 없으면 Riot ID로 조회한다.
 * 계정 조회·큐 대기·재시도를 포함한 전체 처리 기한은 60초.
 */
async function predictForTarget(target, { deadlineMs = PREDICTION_CONFIG.deadlineMs } = {}) {
  const deadlineAt = Date.now() + deadlineMs;
  return runWithDeadline(async (signal) => {
    let { puuid, gameName, tagLine } = target;
    if (!puuid) {
      let account;
      try {
        account = await getAccountByRiotId(gameName, tagLine, { signal });
      } catch (err) {
        if (err.notFound) throw new PredictionError('ACCOUNT_NOT_FOUND');
        throw err;
      }
      if (!account?.puuid) throw new PredictionError('ACCOUNT_NOT_FOUND');
      puuid = account.puuid;
      gameName = account.gameName || gameName;
      tagLine = account.tagLine || tagLine;
    }
    throwIfAborted(signal);
    const prediction = await getPrediction(puuid, { deadlineAt });
    return { ...prediction, gameName, tagLine };
  }, deadlineMs);
}

/** 같은 서버·사용자 반복 요청 제한. 사용 가능하면 0을 반환하고 시각을 기록한다. */
function tryAcquireCooldown(guildId, userId) {
  const current = now();
  for (const [key, at] of cooldowns) {
    if (current - at >= PREDICTION_CONFIG.cooldownMs) cooldowns.delete(key);
  }
  const key = `${guildId}:${userId}`;
  const last = cooldowns.get(key);
  if (last !== undefined) return PREDICTION_CONFIG.cooldownMs - (current - last);
  cooldowns.set(key, current);
  return 0;
}

function isRiotApiConfigured() {
  return Boolean(process.env.RIOT_API_KEY && process.env.RIOT_API_KEY.trim());
}

// ============================================
// 🧾 입력·오류·출력
// ============================================

/**
 * 멤버 / 소환사명+태그 / 없음(본인) 중 하나만 허용한다. 충돌 시 임의 우선순위 없이 사용법 안내.
 */
function parsePredictionOptions({ member = null, gameName = null, tagLine = null }) {
  const hasName = gameName !== null && gameName !== undefined;
  const hasTag = tagLine !== null && tagLine !== undefined;

  if (member && (hasName || hasTag)) {
    return { error: '멤버와 소환사명·태그는 함께 입력할 수 없습니다.' };
  }
  if (hasName !== hasTag) {
    return { error: '직접 입력하려면 소환사명과 태그를 모두 입력해주세요.' };
  }
  if (hasName) {
    const name = String(gameName).trim();
    const tag = String(tagLine).trim();
    if (!name || !tag) return { error: '소환사명과 태그가 비어 있습니다.' };
    return { mode: 'direct', gameName: name, tagLine: tag };
  }
  if (member) return { mode: 'member', member };
  return { mode: 'self' };
}

function classifyPredictionError(err) {
  if (err instanceof PredictionError) return { code: err.code, message: err.userMessage };
  if (err?.name === 'AbortError' || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') {
    return { code: 'TIMEOUT', message: ERROR_MESSAGES.TIMEOUT };
  }
  const status = err?.response?.status;
  if (status === 401 || status === 403) return { code: 'AUTH', message: ERROR_MESSAGES.AUTH };
  if (status === 429) return { code: 'RATE_LIMITED', message: ERROR_MESSAGES.RATE_LIMITED };
  if (status >= 500) return { code: 'UPSTREAM', message: ERROR_MESSAGES.UPSTREAM };
  if (!status && (err?.isAxiosError || err?.code)) return { code: 'NETWORK', message: ERROR_MESSAGES.NETWORK };
  return { code: 'UNKNOWN', message: ERROR_MESSAGES.UNKNOWN };
}

/** 로그용 요약. Axios 오류 객체 전체(요청 헤더의 API 키 포함)를 남기지 않는다. */
function describeErrorForLog(err) {
  const { code } = classifyPredictionError(err);
  const status = err?.response?.status ? ` status=${err.response.status}` : '';
  return `${code}${status} ${err?.name || 'Error'}: ${err?.message || ''}`.trim();
}

function formatStreak(streak) {
  if (!streak) return '-';
  const label = `${streak.count}${streak.win ? '연승' : '연패'}`;
  return streak.atLeast ? `최소 ${label}` : label;
}

function formatSpySection(spy) {
  if (!spy || spy.insufficient) {
    return '아직 예측에 필요한 경기 데이터가 부족합니다.\n조금 더 플레이한 뒤 다시 확인해주세요.';
  }
  const [p0, p1, p2, p3] = spy.percents;
  return [
    `첩자 존재 확률 \`${spy.existPercent}%\``,
    `예상 인원 \`0명 ${p0}% · 1명 ${p1}% · 2명 ${p2}% · 3명+ ${p3}%\``,
    `예상 첩자 수 \`${spy.expectedCount.toFixed(1)}명\``,
    `기준: ${spy.condition} ${spy.sampleSize}판 · 아군의 그 경기 KDA·킬관여·데스·라인 골드로 판정`,
    '※ 최근 매칭 기록을 기반으로 한 재미용 통계 예측입니다. 실제 매치메이킹 의도를 의미하지 않습니다.',
  ].join('\n');
}

function buildPredictionEmbed(result) {
  const { lookbackDays, minGameDurationSec } = PREDICTION_CONFIG;
  const name = escapeMarkdown(`${result.gameName}#${result.tagLine}`);
  const lines = [`**${name}**`, ''];

  if (result.sampleSize === 0) {
    lines.push(`최근 ${lookbackDays}일 개인/2인전에서 분석할 수 있는 경기가 없습니다.`);
  } else {
    const { sampleSize: n, wins, losses, recent } = result;
    lines.push(`최근 ${n}경기: ${wins}승 ${losses}패 · 승률 ${formatWinRate(wins, n)}%`);
    lines.push(`최근 ${recent.games}경기: ${recent.wins}승 ${recent.losses}패`);
    lines.push(`현재 기록: ${formatStreak(result.streak)}`);
    if (n < result.targetSampleSize) {
      lines.push(`⚠️ 목표 ${result.targetSampleSize}경기 중 ${n}경기만 확보되어 자료가 적습니다.`);
    }
    lines.push('');
    if (result.estimate) {
      lines.push(`승리 참고 추정: **${formatTenths(result.estimate.winTenths)}%**`);
      lines.push(`패배 참고 추정: **${formatTenths(result.estimate.lossTenths)}%**`);
    } else {
      lines.push(`유효 경기가 ${PREDICTION_CONFIG.minSampleForEstimate}경기 미만이라 승리·패배 추정치를 표시하지 않습니다.`);
    }
  }

  const shortExcluded = result.excluded?.short ? ` (${result.excluded.short}경기)` : '';
  lines.push(
    '',
    `최근 ${lookbackDays}일 개인/2인전 기준 · ${minGameDurationSec / 60}분 미만 경기 제외${shortExcluded}`,
    '종료된 전적만 사용 · 현재 진행 중인 경기 분석 아님',
    '',
    '※ 과거 전적 기반 참고값입니다.',
    '다음 경기의 팀 구성·챔피언 등은 반영하지 않았습니다.',
    '실제 예측 정확도는 아직 검증되지 않았습니다.'
  );

  return new EmbedBuilder()
    .setTitle('🎮 다음 솔랭 승부 예측')
    .setDescription(lines.join('\n'))
    .addFields({ name: '🕵️ 메튜렁의 첩자', value: formatSpySection(result.spy) })
    .setColor(0x5865f2)
    .setFooter({
      text: `모델 ${result.modelVersion}${result.cached ? ' · 캐시된 결과 (최대 3분)' : ''} · 데이터 갱신 시각`,
    })
    .setTimestamp(new Date(result.fetchedAt));
}

module.exports = {
  PREDICTION_CONFIG,
  USAGE_TEXT,
  PredictionError,
  computeEstimate,
  formatTenths,
  summarizeResults,
  compactMatch,
  evaluateMatch,
  collectRecentGames,
  getPrediction,
  predictForTarget,
  tryAcquireCooldown,
  isRiotApiConfigured,
  parsePredictionOptions,
  classifyPredictionError,
  describeErrorForLog,
  buildPredictionEmbed,
  __testing: {
    setNow(fn) {
      now = fn;
    },
    reset() {
      now = () => Date.now();
      resultCache.clear();
      matchCache.clear();
      inflight.clear();
      cooldowns.clear();
    },
    caches: { resultCache, matchCache, inflight, cooldowns },
  },
};
