const riotService = require('./riotService');
const championKnowledge = require('./championKnowledgeService');
const {
  BRIEFING_CONFIG,
  SMITE_SPELL_ID,
  compactMatch,
  evaluateMatchFor,
  aggregateHistory,
  buildPerspective,
  isHistoryQueue,
  rankQueueTypeFor,
  MatchDataError,
} = require('./liveBriefingAnalysis');
const { BoundedTtlCache } = require('../utils/boundedTtlCache');

// ============================================
// 🎮 /전적 실시간 게임 시작 브리핑 — 수집 (Riot·Data Dragon)
//
// 모든 Riot 호출은 riotService의 공통 큐(요청 간격·429 Retry-After 대기)를 거친다.
// 여기서는 그 위에 요청당 예산·기한·중복 제거·캐시를 둔다.
// 규칙 설명: LIVE_BRIEFING.md
// ============================================

const LIVE_CONFIG = Object.freeze({
  platformId: 'KR',
  regionalRoute: 'asia',
  maxNewMatchDetails: 80, // 한 요청이 새로 가져오는 경기 상세 상한 (Riot 보장 한도가 아니라 봇 자체 상한)
  maxRiotCalls: 140, // 한 요청의 전체 Riot 호출 상한 (ID·랭크·숙련도·상세 포함, 공유 요청 합류는 제외)
  concurrency: 3, // 공통 큐를 다른 기능과 나눠 쓰도록 동시에 넣는 요청 수 제한
  deadlineMs: 45 * 1000, // 계정·현재 게임 조회부터 수집 종료까지 전체 기한
  quickPhaseMs: 20 * 1000, // 1차(랭크·경기 ID·빠른 표본) 기한
  reserveMs: 3 * 1000, // 기한 직전 보강을 멈추고 결과를 정리할 여유
  gameCacheTtlMs: 3 * 60 * 1000,
  gameCacheMaxEntries: 50,
  matchCacheTtlMs: 6 * 60 * 60 * 1000,
  matchCacheMaxEntries: 3000,
  idsCacheTtlMs: 3 * 60 * 1000,
  idsCacheMaxEntries: 500,
  rankCacheTtlMs: 5 * 60 * 1000,
  rankCacheMaxEntries: 1000,
  masteryCacheTtlMs: 30 * 60 * 1000,
  masteryCacheMaxEntries: 1000,
  cooldownMs: 15 * 1000,
});

const ERROR_MESSAGES = {
  NO_API_KEY: 'Riot API 키가 설정되지 않아 조회할 수 없습니다. 관리자에게 문의해주세요.',
  ACCOUNT_NOT_FOUND: '소환사를 찾을 수 없습니다. 게임이름과 태그를 확인해주세요.',
  INVALID_LIVE_GAME: '현재 게임 정보의 형식이 예상과 달라 조회를 중단했습니다.',
  TIMEOUT: '조회 시간을 초과했습니다. 잠시 후 다시 시도해주세요.',
  AUTH: 'Riot API 인증 또는 권한 문제로 조회하지 못했습니다. 관리자에게 API 키 확인을 요청해주세요.',
  RATE_LIMITED: 'Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해주세요.',
  UPSTREAM: 'Riot 서버가 일시적으로 응답하지 않습니다. 잠시 후 다시 시도해주세요.',
  NETWORK: 'Riot 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.',
  UNKNOWN: '실시간 게임 조회 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.',
};

class BriefingError extends Error {
  constructor(code, detail) {
    super(detail || ERROR_MESSAGES[code] || code);
    this.name = 'BriefingError';
    this.code = code;
    this.userMessage = ERROR_MESSAGES[code] || ERROR_MESSAGES.UNKNOWN;
  }
}

let now = () => Date.now();

const gameCache = new BoundedTtlCache(LIVE_CONFIG.gameCacheTtlMs, LIVE_CONFIG.gameCacheMaxEntries, () => now());
const matchCache = new BoundedTtlCache(LIVE_CONFIG.matchCacheTtlMs, LIVE_CONFIG.matchCacheMaxEntries, () => now());
const idsCache = new BoundedTtlCache(LIVE_CONFIG.idsCacheTtlMs, LIVE_CONFIG.idsCacheMaxEntries, () => now());
const rankCache = new BoundedTtlCache(LIVE_CONFIG.rankCacheTtlMs, LIVE_CONFIG.rankCacheMaxEntries, () => now());
const masteryCache = new BoundedTtlCache(LIVE_CONFIG.masteryCacheTtlMs, LIVE_CONFIG.masteryCacheMaxEntries, () => now());
const inflight = { match: new Map(), ids: new Map(), rank: new Map(), mastery: new Map() };
const cooldowns = new Map();

/** 기간·표본 수는 환경변수로 바꿀 수 있다 (범위 밖이면 기본값) */
function historySettings() {
  const read = (name, fallback, min, max) => {
    const value = Number.parseInt(process.env[name], 10);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
  };
  return {
    lookbackDays: read('LIVE_BRIEFING_LOOKBACK_DAYS', BRIEFING_CONFIG.lookbackDays, 1, 365),
    maxGames: read('LIVE_BRIEFING_MAX_GAMES', BRIEFING_CONFIG.maxGames, BRIEFING_CONFIG.quickGames, 100),
    quickGames: BRIEFING_CONFIG.quickGames,
  };
}

// ============================================
// ⚠️ 실패 분류
// ============================================
function abortError(reason = '기한 종료') {
  const err = new Error(reason);
  err.name = 'AbortError';
  return err;
}

function budgetError() {
  const err = new Error('요청 예산 소진');
  err.code = 'BUDGET';
  return err;
}

/** 조회 실패 사유. 'skipped'는 기한·예산으로 시도하지 않은 것 (실패가 아니다) */
function classifyFailure(err) {
  if (err?.code === 'BUDGET') return 'skipped';
  if (err?.name === 'AbortError' || err?.name === 'CanceledError' || err?.code === 'ERR_CANCELED') return 'skipped';
  if (err instanceof MatchDataError) return 'invalid';
  if (err?.notFound) return 'notFound';
  const status = err?.response?.status;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rateLimited';
  if (status >= 500) return 'upstream';
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') return 'timeout';
  if (!status && (err?.isAxiosError || typeof err?.code === 'string')) return 'network';
  return 'unknown';
}

function toBriefingError(err) {
  if (err instanceof BriefingError) return err;
  const reason = classifyFailure(err);
  const code = {
    skipped: 'TIMEOUT',
    timeout: 'TIMEOUT',
    auth: 'AUTH',
    rateLimited: 'RATE_LIMITED',
    upstream: 'UPSTREAM',
    network: 'NETWORK',
    notFound: 'ACCOUNT_NOT_FOUND',
  }[reason] || 'UNKNOWN';
  return new BriefingError(code, err?.message);
}

/** 로그용 요약. Axios 오류 전체(요청 헤더의 API 키 포함)를 남기지 않는다. */
function describeErrorForLog(err) {
  const status = err?.response?.status ? ` status=${err.response.status}` : '';
  return `${err?.code || classifyFailure(err)}${status} ${err?.name || 'Error'}: ${err?.message || ''}`.trim();
}

// ============================================
// ⏱️ 요청 컨텍스트 · 공유 요청
// ============================================
function createContext(deadlineMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(abortError()), deadlineMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    deadlineAt: Date.now() + deadlineMs,
    // 기한 직전 여유: 기본 3초, 짧은 기한이면 기한의 10%
    reserveMs: Math.min(LIVE_CONFIG.reserveMs, Math.floor(deadlineMs / 10)),
    riotCalls: 0,
    newDetails: 0,
    budgetHit: false,
    dispose() {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort(abortError('요청 종료'));
    },
  };
}

/** parent가 끝나거나 ms가 지나면 끝나는 하위 signal */
function phaseSignal(parent, ms) {
  const controller = new AbortController();
  const abort = () => controller.abort(abortError());
  const timer = setTimeout(abort, Math.max(0, ms));
  timer.unref?.();
  if (parent.aborted) abort();
  else parent.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener('abort', abort);
    },
  };
}

/**
 * 같은 key의 진행 중 요청을 여러 호출자가 공유한다.
 * 한 호출자가 기한으로 빠져도 다른 호출자의 요청은 취소하지 않고, 모든 구독자가 빠졌을 때만 취소한다.
 */
function sharedFetch(map, key, fetcher, signal) {
  let entry = map.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, subscribers: 0 };
    entry.promise = Promise.resolve()
      .then(() => fetcher(controller.signal))
      .finally(() => {
        if (map.get(key) === entry) map.delete(key);
      });
    entry.promise.catch(() => {});
    map.set(key, entry);
  }
  const shared = entry;
  shared.subscribers++;

  return new Promise((resolve, reject) => {
    let settled = false;
    const leave = () => {
      shared.subscribers--;
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      leave();
      if (shared.subscribers <= 0) shared.controller.abort(abortError());
      reject(abortError());
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        leave();
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        leave();
        reject(err);
      }
    );
  });
}

/** 공통 예산을 확인하고 Riot 호출을 공유 요청으로 보낸다 */
function callRiot(ctx, signal, map, key, fetcher) {
  if (signal.aborted) return Promise.reject(abortError());
  if (!map.has(key)) {
    if (ctx.riotCalls >= LIVE_CONFIG.maxRiotCalls) {
      ctx.budgetHit = true;
      return Promise.reject(budgetError());
    }
    ctx.riotCalls++;
  }
  return sharedFetch(map, key, fetcher, signal);
}

async function runPool(tasks, concurrency, signal) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length && !signal.aborted) {
      const task = tasks[next++];
      await task();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
}

// ============================================
// 📥 개별 조회 (실패는 상태로 남기고 예외를 올리지 않는다)
// ============================================
async function loadRank(ctx, signal, puuid, queueType) {
  const key = `${LIVE_CONFIG.platformId}:${puuid}`;
  let entries = rankCache.get(key);
  if (entries === undefined) {
    try {
      entries = await callRiot(ctx, signal, inflight.rank, key, (s) =>
        riotService.getLeagueEntriesByPuuid(puuid, { signal: s })
      );
    } catch (err) {
      const reason = classifyFailure(err);
      return reason === 'skipped' ? { status: 'skipped' } : { status: 'error', reason };
    }
    // 404(null)는 '언랭크'가 아니라 조회 불가로 남긴다
    if (entries === null) return { status: 'error', reason: 'notFound' };
    if (!Array.isArray(entries)) return { status: 'error', reason: 'invalid' };
    rankCache.set(key, entries);
  }
  const entry = entries.find((e) => e?.queueType === queueType);
  if (!entry) return { status: 'unranked', queueType };
  return {
    status: 'ranked',
    queueType,
    tier: entry.tier,
    division: entry.rank,
    lp: entry.leaguePoints,
    wins: entry.wins,
    losses: entry.losses,
  };
}

async function loadMatchIds(ctx, signal, puuid, queueId, settings) {
  const key = `${LIVE_CONFIG.regionalRoute}:${puuid}:${queueId}:${settings.lookbackDays}:${settings.maxGames}`;
  const cached = idsCache.get(key);
  if (cached) return { status: 'ok', ids: cached };
  try {
    const startTime = Math.floor((now() - settings.lookbackDays * 24 * 60 * 60 * 1000) / 1000);
    const ids = await callRiot(ctx, signal, inflight.ids, key, (s) =>
      riotService.getRecentMatchIds(puuid, settings.maxGames, { queue: queueId, startTime, signal: s, throwOnNotFound: true })
    );
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) return { status: 'error', reason: 'invalid' };
    const unique = [...new Set(ids)].slice(0, settings.maxGames);
    idsCache.set(key, unique);
    return { status: 'ok', ids: unique };
  } catch (err) {
    const reason = classifyFailure(err);
    return reason === 'skipped' ? { status: 'skipped' } : { status: 'error', reason };
  }
}

async function loadMatch(ctx, signal, matchId) {
  const cached = matchCache.get(matchId);
  if (cached) return cached;
  // 다른 요청이 이미 가져오는 중인 경기에 합류하는 것은 새 상세 수집으로 세지 않는다
  const joined = inflight.match.has(matchId);
  if (!joined && ctx.newDetails >= LIVE_CONFIG.maxNewMatchDetails) {
    ctx.budgetHit = true;
    throw budgetError();
  }
  const promise = callRiot(ctx, signal, inflight.match, matchId, async (s) => {
    const detail = await riotService.getMatchDetail(matchId, { signal: s });
    if (!detail) {
      const err = new Error(`${matchId}: 404`);
      err.notFound = true;
      throw err;
    }
    const match = compactMatch(detail, matchId);
    matchCache.set(matchId, match); // 성공한 경기만 캐시
    return match;
  });
  if (!joined && inflight.match.has(matchId)) ctx.newDetails++;
  return promise;
}

/** 숙련도 상위 3챔피언 (주 챔피언). 404는 기록 없음 */
async function loadTopMasteries(ctx, signal, puuid) {
  const key = `${LIVE_CONFIG.platformId}:${puuid}:top3`;
  const cached = masteryCache.get(key);
  if (cached) return cached;
  try {
    const data = await callRiot(ctx, signal, inflight.mastery, key, (s) =>
      riotService.getTopChampionMasteries(puuid, 3, { signal: s })
    );
    let result;
    if (data === null) result = { status: 'none', champions: [] };
    else if (!Array.isArray(data)) result = { status: 'error', reason: 'invalid' };
    else {
      result = {
        status: 'ok',
        champions: data
          .filter((m) => Number.isFinite(m?.championId) && Number.isFinite(m?.championPoints))
          .slice(0, 3)
          .map((m) => ({ championId: m.championId, points: m.championPoints, level: m.championLevel })),
      };
    }
    if (result.status !== 'error') masteryCache.set(key, result);
    return result;
  } catch (err) {
    const reason = classifyFailure(err);
    return reason === 'skipped' ? { status: 'skipped' } : { status: 'error', reason };
  }
}

// ============================================
// 🗂️ 경기 단위 공유 수집 상태
// ============================================
function getCollection(game) {
  const key = `${game.platformId}:${game.gameId}`;
  let collection = gameCache.get(key);
  if (!collection) {
    collection = { key, players: new Map() };
    gameCache.set(key, collection);
  }
  return collection;
}

function playerState(collection, puuid) {
  let state = collection.players.get(puuid);
  if (!state) {
    state = { rank: null, ids: null, entries: new Map(), mastery: null };
    collection.players.set(puuid, state);
  }
  return state;
}

function isLookupTarget(p) {
  return Boolean(p.puuid) && !p.bot;
}

/** 참가자의 ids 앞쪽 depth개 중 아직 확정되지 않은 경기 상세 조회 작업 */
function detailTasks(ctx, signal, state, puuid, depth, evalOptions) {
  if (state.ids?.status !== 'ok') return [];
  return state.ids.ids
    .slice(0, depth)
    .filter((id) => {
      const e = state.entries.get(id);
      return !e || e.state === 'failed';
    })
    .map((matchId) => async () => {
      try {
        const match = await loadMatch(ctx, signal, matchId);
        state.entries.set(matchId, { matchId, ...evaluateMatchFor(match, puuid, evalOptions) });
      } catch (err) {
        const reason = classifyFailure(err);
        // 기한·예산으로 못 가져온 경기는 실패가 아니라 미수집(pending)으로 남긴다
        if (reason !== 'skipped') state.entries.set(matchId, { matchId, state: 'failed', reason });
      }
    });
}

function interleave(lists) {
  const out = [];
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) for (const l of lists) if (i < l.length) out.push(l[i]);
  return out;
}

// ============================================
// 🧱 모델 구성
// ============================================
function buildBaseParticipants(live) {
  return live.participants.map((p, slot) => {
    const puuid = typeof p?.puuid === 'string' && p.puuid ? p.puuid : null;
    const spells = [p?.spell1Id, p?.spell2Id];
    const perkIds = Array.isArray(p?.perks?.perkIds) ? p.perks.perkIds : null;
    return {
      slot,
      puuid,
      hidden: !puuid,
      bot: p?.bot === true,
      // riotId는 문서화된 필드가 아니므로 있으면 표시에만 쓴다
      displayName: typeof p?.riotId === 'string' && p.riotId.trim() ? p.riotId.trim() : null,
      teamId: p?.teamId,
      championId: p?.championId,
      championName: riotService.getChampionName(p?.championId),
      spellIds: spells,
      spellNames: spells.map((id) => riotService.getSpellName(id)),
      spellDataIds: spells.map((id) => riotService.getSpellDataId(id)),
      championDataId: riotService.getChampionDataId(p?.championId),
      hasSmite: spells.includes(SMITE_SPELL_ID),
      runes: perkIds
        ? { keystoneId: perkIds[0] ?? null, primaryStyleId: p.perks.perkStyle ?? null, subStyleId: p.perks.perkSubStyle ?? null }
        : null,
    };
  });
}

function historyOf(p, state, queueId) {
  if (!isLookupTarget(p)) return { status: p.bot ? 'bot' : 'hidden', ids: [], entries: [] };
  if (!isHistoryQueue(queueId)) return { status: 'unsupported', ids: [], entries: [] };
  const ids = state?.ids;
  if (!ids) return { status: 'skipped', ids: [], entries: [] };
  if (ids.status !== 'ok') return { status: ids.status, reason: ids.reason, ids: [], entries: [] };
  return { status: 'ok', ids: ids.ids, entries: [...state.entries.values()] };
}

function snapshotParticipants(base, collection, game) {
  return base.map((p) => {
    const state = p.puuid ? collection?.players.get(p.puuid) : null;
    const history = historyOf(p, state, game.queueId);
    const stats = history.status === 'ok' ? aggregateHistory(history, p.championId) : null;
    const rank = !isLookupTarget(p) ? { status: p.bot ? 'bot' : 'hidden' } : state?.rank || { status: 'skipped' };
    const topMasteries = !isLookupTarget(p) ? null : state?.mastery || { status: 'skipped' };
    return { ...p, rank, history: { status: history.status, reason: history.reason }, stats, topMasteries };
  });
}

async function loadProfiles(base, version) {
  const profiles = new Map();
  const unique = [...new Set(base.map((p) => p.championId))];
  const [runes] = await Promise.all([
    championKnowledge.getRunes(version),
    ...unique.map(async (championId) => {
      const dataId = riotService.getChampionDataId(championId);
      profiles.set(championId, dataId ? await championKnowledge.getChampionProfile(version, dataId) : null);
    }),
  ]);
  return { profiles, runes };
}

// ============================================
// 🔄 수집 단계
// ============================================
async function collect(ctx, collection, game, base, targetPuuid, settings) {
  const lookups = base.filter(isLookupTarget);
  const queueType = rankQueueTypeFor(game.queueId);
  const historyEnabled = isHistoryQueue(game.queueId);
  const evalOptions = { queueId: game.queueId, cutoffMs: now() - settings.lookbackDays * 24 * 60 * 60 * 1000 };
  const byTargetFirst = [...lookups].sort((a, b) => (b.puuid === targetPuuid) - (a.puuid === targetPuuid));

  // 1차: 랭크 · 주 챔피언(숙련도 상위) · 경기 ID · 참가자별 빠른 표본
  const quick = phaseSignal(ctx.signal, Math.min(LIVE_CONFIG.quickPhaseMs, ctx.deadlineAt - Date.now() - ctx.reserveMs));
  try {
    await runPool(
      byTargetFirst.flatMap((p) => {
        const state = playerState(collection, p.puuid);
        const tasks = [
          async () => { state.rank = await loadRank(ctx, quick.signal, p.puuid, queueType); },
          async () => {
            const result = await loadTopMasteries(ctx, quick.signal, p.puuid);
            if (result.status !== 'skipped' || !state.mastery) state.mastery = result;
          },
        ];
        if (historyEnabled && state.ids?.status !== 'ok') {
          tasks.push(async () => {
            const ids = await loadMatchIds(ctx, quick.signal, p.puuid, game.queueId, settings);
            if (ids.status !== 'skipped' || !state.ids) state.ids = ids;
          });
        }
        return tasks;
      }),
      LIVE_CONFIG.concurrency,
      quick.signal
    );
    if (historyEnabled) {
      const perPlayer = byTargetFirst.map((p) =>
        detailTasks(ctx, quick.signal, playerState(collection, p.puuid), p.puuid, settings.quickGames, evalOptions)
      );
      // 조회 대상 표본을 먼저, 나머지는 참가자별로 번갈아
      await runPool([...perPlayer[0] || [], ...interleave(perPlayer.slice(1))], LIVE_CONFIG.concurrency, quick.signal);
    }
  } finally {
    quick.dispose();
  }

  // 2차: 조회 대상과 상대 후보를 목표 표본까지 보강 → 3차: 나머지 참가자 (남은 예산·기한 안에서)
  const perspective = buildPerspective({ game, participants: snapshotParticipants(base, collection, game), targetPuuid });
  const priority = perspective.mode === 'personal'
    ? [perspective.target, ...(perspective.lane.opponents || []), ...(perspective.lane.allyDuo || [])]
    : [];
  const priorityIds = new Set(priority.filter(isLookupTarget).map((p) => p.puuid));

  const rest = phaseSignal(ctx.signal, ctx.deadlineAt - Date.now() - ctx.reserveMs);
  try {
    if (historyEnabled) {
      const priorityList = lookups.filter((p) => priorityIds.has(p.puuid));
      await runPool(
        interleave(priorityList.map((p) => detailTasks(ctx, rest.signal, playerState(collection, p.puuid), p.puuid, settings.maxGames, evalOptions))),
        LIVE_CONFIG.concurrency,
        rest.signal
      );
    }
    if (historyEnabled) {
      const others = lookups.filter((p) => !priorityIds.has(p.puuid));
      await runPool(
        interleave(others.map((p) => detailTasks(ctx, rest.signal, playerState(collection, p.puuid), p.puuid, settings.maxGames, evalOptions))),
        LIVE_CONFIG.concurrency,
        rest.signal
      );
    }
  } finally {
    rest.dispose();
  }
}

// ============================================
// 🚀 진입점
// ============================================

/**
 * input: { gameName, tagLine } 또는 { puuid, gameName, tagLine }
 * onBasic(model): 현재 게임·팀 연결만 끝난 기본 정보 (전적 수집 전). 실패해도 무시한다.
 * 반환: { notInGame: true, account } 또는 브리핑 모델
 */
async function createLiveBriefing(input, { onBasic = null, deadlineMs = LIVE_CONFIG.deadlineMs } = {}) {
  if (!process.env.RIOT_API_KEY || !process.env.RIOT_API_KEY.trim()) throw new BriefingError('NO_API_KEY');
  await riotService.initStaticData();
  const settings = historySettings();
  const ctx = createContext(deadlineMs);

  try {
    let { puuid, gameName, tagLine } = input;
    let live;
    try {
      if (!puuid) {
        ctx.riotCalls++;
        const account = await riotService.getAccountByRiotId(gameName, tagLine, { signal: ctx.signal });
        if (!account?.puuid) throw new BriefingError('ACCOUNT_NOT_FOUND');
        ({ puuid } = account);
        gameName = account.gameName || gameName;
        tagLine = account.tagLine || tagLine;
      }
      ctx.riotCalls++;
      live = await riotService.getLiveGame(puuid, { signal: ctx.signal });
    } catch (err) {
      if (err?.notFound) throw new BriefingError('ACCOUNT_NOT_FOUND');
      throw toBriefingError(err);
    }

    const account = { gameName, tagLine };
    if (!live) return { notInGame: true, account };
    if (!Array.isArray(live.participants) || live.participants.length === 0 || !Number.isFinite(live.gameId)) {
      throw new BriefingError('INVALID_LIVE_GAME');
    }

    const game = {
      platformId: typeof live.platformId === 'string' ? live.platformId : LIVE_CONFIG.platformId,
      gameId: live.gameId,
      queueId: Number.isFinite(live.gameQueueConfigId) ? live.gameQueueConfigId : 0,
      mapId: live.mapId,
      gameMode: live.gameMode || null,
      gameStartTime: Number.isFinite(live.gameStartTime) && live.gameStartTime > 0 ? live.gameStartTime : null,
      bans: (Array.isArray(live.bannedChampions) ? live.bannedChampions : [])
        .filter((b) => Number.isFinite(b?.championId) && b.championId > 0)
        .map((b) => ({ championId: b.championId, teamId: b.teamId, pickTurn: b.pickTurn })),
    };
    const base = buildBaseParticipants(live);
    const staticData = riotService.getStaticDataInfo();
    const profilesPromise = loadProfiles(base, staticData.version);

    const makeModel = (collection, extra = {}) => ({
      notInGame: false,
      account,
      targetPuuid: puuid,
      game,
      settings,
      staticData,
      participants: snapshotParticipants(base, collection, game),
      analyzedAt: now(),
      ...extra,
    });

    if (onBasic) {
      try {
        await onBasic(makeModel(null, { stage: 'basic' }));
      } catch (err) {
        console.error(`브리핑 기본 정보 표시 실패: ${err.message}`);
      }
    }

    const collection = getCollection(game);
    await collect(ctx, collection, game, base, puuid, settings);
    const { profiles, runes } = await profilesPromise;

    return makeModel(collection, {
      stage: 'final',
      profiles,
      runes,
      collectionStats: {
        riotCalls: ctx.riotCalls,
        newDetails: ctx.newDetails,
        budgetHit: ctx.budgetHit,
        deadlineHit: ctx.signal.aborted,
      },
    });
  } finally {
    ctx.dispose();
  }
}

function summarizeCompleteness(model, perspective) {
  const lookups = model.participants.filter((p) => !p.hidden && !p.bot);
  const sum = (fn) => lookups.reduce((s, p) => s + (p.stats ? fn(p.stats) : 0), 0);
  const profiles = model.profiles || new Map();
  let role = 'unsupported';
  if (perspective.mode !== 'personal') role = 'none';
  else if (perspective.roleSupported) role = perspective.myRole.level;
  return {
    players: model.participants.length,
    lookups: lookups.length,
    hidden: model.participants.length - lookups.length,
    historyOk: lookups.filter((p) => p.history.status === 'ok').length,
    historyUnsupported: lookups.some((p) => p.history.status === 'unsupported'),
    rankOk: lookups.filter((p) => p.rank.status === 'ranked' || p.rank.status === 'unranked').length,
    collectedGames: sum((s) => s.collected),
    pendingGames: sum((s) => s.pending),
    failedGames: sum((s) => s.failed),
    excludedGames: sum((s) => s.excludedTotal),
    role,
    profilesLoaded: model.participants.filter((p) => profiles.get(p.championId)).length,
    budgetHit: Boolean(model.collectionStats?.budgetHit),
    deadlineHit: Boolean(model.collectionStats?.deadlineHit),
  };
}

/** 같은 서버·사용자 반복 조회 제한. 가능하면 0을 반환하고 시각을 기록한다. */
function tryAcquireCooldown(guildId, userId) {
  const current = now();
  for (const [key, at] of cooldowns) {
    if (current - at >= LIVE_CONFIG.cooldownMs) cooldowns.delete(key);
  }
  const key = `${guildId}:${userId}`;
  const last = cooldowns.get(key);
  if (last !== undefined) return LIVE_CONFIG.cooldownMs - (current - last);
  cooldowns.set(key, current);
  return 0;
}

module.exports = {
  LIVE_CONFIG,
  BriefingError,
  historySettings,
  classifyFailure,
  describeErrorForLog,
  sharedFetch,
  createLiveBriefing,
  summarizeCompleteness,
  tryAcquireCooldown,
  __testing: {
    setNow(fn) {
      now = fn;
    },
    reset() {
      now = () => Date.now();
      gameCache.clear();
      matchCache.clear();
      idsCache.clear();
      rankCache.clear();
      masteryCache.clear();
      for (const map of Object.values(inflight)) map.clear();
      cooldowns.clear();
    },
    caches: { gameCache, matchCache, idsCache, rankCache, masteryCache, inflight },
  },
};
