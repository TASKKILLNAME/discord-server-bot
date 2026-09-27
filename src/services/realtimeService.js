'use strict';

const riot = require('./riotService');
const { AsyncCache } = require('../utils/asyncCache');
const { ROLES, ANALYSIS_CONFIG } = require('../constants/realtimeAnalysis');
const { analyzeRecentGames, extractRecentGame, validateMatchData } = require('./playerAnalysisService');
const { assignTeamRoles } = require('./roleAnalyzer');
const { calculateSpyScore } = require('./spyAnalyzer');

const CACHE_POLICY = Object.freeze({
  account: { ttlMs: 60 * 60_000, maxEntries: 500 },
  live: { ttlMs: 10_000, maxEntries: 500 },
  history: { ttlMs: 3 * 60_000, maxEntries: 500 },
  match: { ttlMs: 6 * 60 * 60_000, maxEntries: 2000 },
  rank: { ttlMs: 5 * 60_000, maxEntries: 500 },
  static: { ttlMs: 5 * 60_000, maxEntries: 1 },
});

const USER_ERRORS = {
  NO_API_KEY: 'Riot API 키가 설정되지 않았습니다.',
  NOT_FOUND: '소환사를 찾을 수 없습니다. Riot ID를 확인해 주세요.',
  SELF_NOT_FOUND: '현재 게임에서 조회한 계정을 확인할 수 없어 아군 분석을 중단했습니다.',
  INVALID_TEAM: '현재 게임의 팀 구성을 확인할 수 없습니다.',
  UNSUPPORTED_GAME: '아군 스캔은 소환사의 협곡 5인 팀 게임에서 사용할 수 있습니다.',
  TIMEOUT: '조회 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.',
  AUTH: 'Riot API 인증 또는 권한 문제로 조회하지 못했습니다.',
  RATE_LIMITED: 'Riot API 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.',
  UPSTREAM: 'Riot 데이터를 조회하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

class RealtimeError extends Error {
  constructor(code) { super(USER_ERRORS[code]); this.code = code; this.userMessage = this.message; }
}

function classifyError(error) {
  if (error instanceof RealtimeError) return error;
  if (error?.notFound) return new RealtimeError('NOT_FOUND');
  const status = error?.response?.status;
  if (status === 401 || status === 403) return new RealtimeError('AUTH');
  if (status === 429) return new RealtimeError('RATE_LIMITED');
  return new RealtimeError('UPSTREAM');
}

function getSoloRank(entries) {
  if (!Array.isArray(entries)) throw new Error('Invalid rank response');
  const rank = entries.find((entry) => entry.queueType === 'RANKED_SOLO_5x5');
  if (!rank) return { status: 'unranked' };
  if (typeof rank.tier !== 'string' || typeof rank.rank !== 'string' || !Number.isFinite(rank.leaguePoints)) {
    throw new Error('Invalid solo rank');
  }
  return { status: 'ranked', tier: rank.tier, division: rank.rank, lp: rank.leaguePoints };
}

function publicIdentity(p) {
  // Do not recover hidden identities through old matches or Account-V1 fallbacks.
  return p.bot !== true && typeof p.puuid === 'string' && p.puuid.trim() !== '' &&
    typeof p.riotId === 'string' && /^[^#\r\n]+#[^#\r\n]+$/.test(p.riotId);
}

function createRealtimeService({ api = riot, now = Date.now, deadlineMs = ANALYSIS_CONFIG.deadlineMs,
  getChampionRoles, requireApiKey = true } = {}) {
  const caches = Object.fromEntries(Object.entries(CACHE_POLICY).map(([key, options]) => [
    key, new AsyncCache({ ...options, now, cacheIf: key === 'match'
      ? (match) => Number.isFinite(match?.info?.gameEndTimestamp) : () => true }),
  ]));

  async function history(puuid, signal) {
    return caches.history.get(puuid, async (sharedSignal) => {
      const ids = await api.getRecentMatchIds(puuid, ANALYSIS_CONFIG.sampleSize, {
        queue: ANALYSIS_CONFIG.queueId, throwOnNotFound: true, signal: sharedSignal,
      });
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('Invalid match list');
      const games = [];
      for (const id of [...new Set(ids)].slice(0, ANALYSIS_CONFIG.sampleSize)) {
        const detail = await caches.match.get(id, async (matchSignal) => {
          const result = await api.getMatchDetail(id, { signal: matchSignal });
          validateMatchData(result, id);
          return result;
        }, { signal: sharedSignal });
        const game = extractRecentGame(detail, puuid, id, api.getChampionName);
        if (game) games.push(game);
      }
      return games;
    }, { signal });
  }

  async function scanTeammates(gameName, tagLine) {
    if (requireApiKey && !process.env.RIOT_API_KEY?.trim()) throw new RealtimeError('NO_API_KEY');
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new RealtimeError('TIMEOUT')), deadlineMs);
    try {
      const name = String(gameName || '').trim();
      const tag = String(tagLine || '').trim();
      if (!name || !tag) throw new RealtimeError('NOT_FOUND');
      const account = await caches.account.get(JSON.stringify([name.toLowerCase(), tag.toLowerCase()]),
        (s) => api.getAccountByRiotId(name, tag, { signal: s }), { signal });
      if (!account?.puuid) throw new RealtimeError('SELF_NOT_FOUND');
      const live = await caches.live.get(account.puuid, (s) => api.getLiveGame(account.puuid, { signal: s }), { signal });
      const targetName = `${account.gameName || name}#${account.tagLine || tag}`;
      if (!live) return { status: 'notInGame', targetName };
      if (live.mapId !== 11) throw new RealtimeError('UNSUPPORTED_GAME');
      const participants = Array.isArray(live.participants) ? live.participants : [];
      const self = participants.filter((p) => p.puuid === account.puuid);
      if (self.length !== 1) throw new RealtimeError('SELF_NOT_FOUND');
      if (![100, 200].includes(self[0].teamId)) throw new RealtimeError('INVALID_TEAM');
      const team = participants.filter((p) => p.teamId === self[0].teamId);
      const ids = team.map((p) => p.puuid).filter(Boolean);
      if (team.length > 5 || new Set(ids).size !== ids.length) throw new RealtimeError('INVALID_TEAM');
      await caches.static.get('data', () => api.initStaticData(), { signal });

      // Only the other allies receive personal-data lookups. Self participates in
      // the five-position assignment using champion/spells, with no history fetch.
      const enriched = await Promise.all(team.map(async (p, index) => {
        const isSelf = p === self[0];
        const isPrivate = !publicIdentity(p);
        const base = { key: index, isSelf, private: isPrivate, puuid: p.puuid,
          riotId: isPrivate ? null : p.riotId, championId: p.championId,
          championName: api.getChampionName(p.championId),
          spell1Id: p.spell1Id, spell2Id: p.spell2Id,
          rank: { status: 'unavailable' }, analysis: { status: 'unavailable' } };
        if (isSelf || isPrivate) return base;
        const [rank, recent] = await Promise.allSettled([
          caches.rank.get(p.puuid, async (s) => getSoloRank(await api.getRankByPuuid(p.puuid,
            { signal: s, throwOnNotFound: true })), { signal }),
          history(p.puuid, signal),
        ]);
        return { ...base,
          rank: rank.status === 'fulfilled' ? rank.value : { status: 'error' },
          analysis: recent.status === 'fulfilled'
            ? analyzeRecentGames(recent.value, p.championId) : { status: 'error' },
        };
      }));
      const assigned = assignTeamRoles(enriched, getChampionRoles);
      const allies = assigned.filter((p) => !p.isSelf)
        .map((p) => ({ ...p, spy: calculateSpyScore(p) }))
        .sort((a, b) => ROLES.indexOf(a.currentRole.role) - ROLES.indexOf(b.currentRole.role));
      return { status: 'ok', targetName, gameId: live.gameId, queueId: live.gameQueueConfigId,
        teamId: self[0].teamId, allies, timedOut: signal.aborted,
        offRoleCount: allies.filter((p) => !p.private && p.spy.offRole.status === 'SUSPECTED').length,
        highRiskCount: allies.filter((p) => p.spy.level === 'HIGH').length };
    } catch (error) {
      throw classifyError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return { scanTeammates };
}

const service = createRealtimeService();
module.exports = { ...service, createRealtimeService, RealtimeError, classifyError, getSoloRank, CACHE_POLICY };
