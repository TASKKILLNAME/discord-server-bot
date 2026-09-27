const { SPY_CONFIG, calculateSpyScore } = require('./spyPrediction');

// ============================================
// 🧮 /전적 실시간 — 순수 계산 (API·Discord 무관)
//
// 같은 입력이면 항상 같은 숫자가 나오도록 비율·평균은 정수(퍼밀·10분의 1·100분의 1)로 계산한다.
// 규칙 설명: LIVE_BRIEFING.md
// ============================================

// 표본·역할 추정 설정 (Riot 공식 규칙이 아니라 이 기능의 설계값)
const BRIEFING_CONFIG = Object.freeze({
  lookbackDays: 60,
  maxGames: 20, // 참가자별 목표 표본 (동일 큐 완료 경기)
  quickGames: 5, // 1차로 모든 참가자에게 확보하는 빠른 표본
  smallSampleThreshold: 5, // 표시용 '표본 적음' 기준 (통계적 신뢰도 아님)
  recentIcons: 10, // 최근 경기 챔피언 아이콘 수

  // 역할 배치 점수 (휴리스틱이며 확률이 아니다)
  roleWeights: Object.freeze({
    history: 3, // 수집 경기 전체의 포지션 비율 × 3
    championHistory: 4, // 현재 챔피언 경기의 포지션 비율 × 4 × min(1, 경기수/3)
    championHistoryFullAt: 3,
    smite: 3, // 강타 보유 시 정글 +3
    noSmiteJunglePenalty: 1.5, // 강타 없으면 정글 −1.5 (금지가 아니라 감점)
  }),
  roleMargin: 1, // 최선 배치와 '이 사람만 다른 역할인 최선 배치'의 점수 차가 이보다 작으면 불확실
  roleMinEvidenceGames: 2, // 포지션이 기록된 과거 경기가 이보다 적으면 (강타 정글 제외) 불확실

  // 태그
  mainRoleMinGames: 5, // 주 포지션 판정 최소 경기
  mainRoleShare: 0.6, // 주 포지션 판정 최소 비율
  mainsRoleMinGames: 3, // 주챔(숙련도 상위) 경기로 주 포지션을 볼 때 최소 경기
  mainsRoleShare: 0.8, //  〃 최소 비율
  roleCheckGames: 12, // 주 포지션이 애매한 참가자를 먼저 보강하는 표본 크기
  streakTagMin: 3, // #N연승/#N연패 표시 최소
  masteryTagGames: 10, // #장인: 수집 경기 중 현재 챔피언 10경기 이상이면서
  masteryTagShare: 0.5, //        절반 이상

  // 첩자 (spyPrediction의 경기별 점수를 재사용, 재미용 통계)
  spyMinSamples: 5, // 개인 첩자 판정률을 보여줄 최소 경기
  spyWarnPermil: 400, // #첩자주의 기준 (40%)
  spyTeamMinPlayers: 3, // 팀 첩자 존재 확률을 낼 최소 인원 (판정률이 있는 사람)
});

const ROLES = Object.freeze(['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY']);
const ROLE_LABELS = Object.freeze({
  TOP: '탑',
  JUNGLE: '정글',
  MIDDLE: '미드',
  BOTTOM: '원딜',
  UTILITY: '서포터',
});
const ROLE_LEVEL_LABELS = Object.freeze({
  user: '사용자 지정',
  estimated: '추정',
  uncertain: '불확실',
  unsupported: '분석 대상 아님',
});

const SMITE_SPELL_ID = 11;
const SUMMONERS_RIFT_MAP_ID = 11;

// 역할 분석을 하는 소환사의 협곡 5대5 큐
const ROLE_QUEUES = new Map([
  [400, '일반 게임(드래프트)'],
  [420, '솔로랭크'],
  [430, '일반 게임(블라인드)'],
  [440, '자유랭크'],
  [490, '빠른 대전'],
]);
const OTHER_QUEUE_NAMES = new Map([
  [0, '사용자 설정 게임'],
  [450, '칼바람 나락'],
  [900, 'U.R.F.'],
  [1700, '아레나'],
]);
const MAP_NAMES = new Map([
  [11, '소환사의 협곡'],
  [12, '칼바람 나락'],
  [30, '아레나'],
]);

function queueName(queueId) {
  return ROLE_QUEUES.get(queueId) || OTHER_QUEUE_NAMES.get(queueId) || `큐 ${queueId}`;
}

function mapName(mapId) {
  return MAP_NAMES.get(mapId) || null;
}

/** 이 큐의 랭크 엔트리 종류. 랭크 큐가 아니면 솔로랭크를 참고값으로 쓴다. */
function rankQueueTypeFor(queueId) {
  return queueId === 440 ? 'RANKED_FLEX_SR' : 'RANKED_SOLO_5x5';
}

/** 과거 전적을 모을 수 있는 큐인가 (사용자 설정 게임은 동일 큐 비교가 의미 없다) */
function isHistoryQueue(queueId) {
  return Number.isInteger(queueId) && queueId > 0;
}

function isRoleAnalysisSupported(game, participants) {
  if (game.mapId !== SUMMONERS_RIFT_MAP_ID || !ROLE_QUEUES.has(game.queueId)) return false;
  const counts = new Map();
  for (const p of participants) counts.set(p.teamId, (counts.get(p.teamId) || 0) + 1);
  return counts.size === 2 && [...counts.values()].every((n) => n === 5);
}

// ============================================
// 🔎 매치 상세 검증·제외
// ============================================
class MatchDataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MatchDataError';
  }
}

function isCount(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * 매치 상세를 필요한 필드만 남긴 형태로 줄인다. 구조가 깨졌으면 MatchDataError.
 * 참가자별 값 검증은 evaluateMatchFor에서 한다 (한 사람 값이 이상해도 다른 사람 표본은 살린다).
 */
function compactMatch(detail, expectedMatchId) {
  const info = detail?.info;
  if (!info || typeof info !== 'object' || !Array.isArray(info.participants)) {
    throw new MatchDataError(`${expectedMatchId}: info/participants 없음`);
  }
  if (expectedMatchId && detail.metadata?.matchId && detail.metadata.matchId !== expectedMatchId) {
    throw new MatchDataError(`${expectedMatchId}: matchId 불일치`);
  }
  if (!Number.isFinite(info.queueId)) throw new MatchDataError(`${expectedMatchId}: queueId 없음`);

  const participants = {};
  for (const p of info.participants) {
    if (!p || typeof p.puuid !== 'string' || !p.puuid) continue;
    participants[p.puuid] = {
      championId: p.championId,
      teamId: p.teamId,
      win: p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      goldEarned: p.goldEarned,
      teamPosition: typeof p.teamPosition === 'string' ? p.teamPosition : '',
      earlySurrender: p.gameEndedInEarlySurrender === true,
    };
  }

  return {
    matchId: expectedMatchId,
    queueId: info.queueId,
    gameDuration: Number.isFinite(info.gameDuration) ? info.gameDuration : null,
    gameEndTimestamp: Number.isFinite(info.gameEndTimestamp) ? info.gameEndTimestamp : null,
    endOfGameResult: typeof info.endOfGameResult === 'string' ? info.endOfGameResult : null,
    participants,
  };
}

/**
 * 그 경기에서 이 플레이어가 '첩자'(부진) 기준을 넘었는지. spyPrediction과 같은 점수식·기준을 쓴다.
 * 판단할 수 없으면 null.
 */
function spyVerdict(match, p) {
  const all = Object.values(match.participants);
  const teamKills = all
    .filter((x) => x.teamId === p.teamId)
    .reduce((sum, x) => sum + (isCount(x.kills) ? x.kills : 0), 0);
  const opponent = ROLES.includes(p.teamPosition)
    ? all.find((x) => x.teamId !== p.teamId && x.teamPosition === p.teamPosition)
    : null;
  const score = calculateSpyScore({
    kills: p.kills,
    deaths: p.deaths,
    assists: p.assists,
    teamKills,
    durationSec: match.gameDuration,
    gold: p.goldEarned,
    laneOpponentGold: opponent?.goldEarned,
  });
  return score === null ? null : score >= SPY_CONFIG.scoreThreshold;
}

/**
 * 한 참가자 기준 표본 판정.
 *  - ok: 집계에 포함
 *  - excluded: 정상 경기와 비교하기 어려운 기록 (다시하기·미완료) 또는 조건 불일치 (큐·기간)
 *  - failed: 데이터 이상 (참가자 없음·값 이상) — 분모에서 빠지고 누락 수로 남는다
 */
function evaluateMatchFor(match, puuid, { queueId, cutoffMs }) {
  if (match.queueId !== queueId) return { state: 'excluded', reason: 'queue' };
  if (match.endOfGameResult && match.endOfGameResult !== 'GameComplete') {
    return { state: 'excluded', reason: 'notCompleted' };
  }
  if (match.gameEndTimestamp === null) return { state: 'failed', reason: 'invalid' };
  if (match.gameEndTimestamp < cutoffMs) return { state: 'excluded', reason: 'period' };

  const p = match.participants[puuid];
  if (!p) return { state: 'failed', reason: 'invalid' };
  if (p.earlySurrender) return { state: 'excluded', reason: 'remake' };
  if (typeof p.win !== 'boolean' || ![p.kills, p.deaths, p.assists].every(isCount)) {
    return { state: 'failed', reason: 'invalid' };
  }

  return {
    state: 'ok',
    game: {
      championId: p.championId,
      win: p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      teamPosition: ROLES.includes(p.teamPosition) ? p.teamPosition : null,
      endMs: match.gameEndTimestamp,
      spy: spyVerdict(match, p),
    },
  };
}

// ============================================
// 📊 전적 집계
// ============================================
function emptyPositions() {
  return Object.fromEntries(ROLES.map((r) => [r, 0]));
}

/** (총 킬 + 총 어시) / 총 데스. 데스 0이면 { deathless: true } */
function combinedKda(kills, deaths, assists) {
  if (deaths === 0) return { deathless: true, hundredths: null };
  return { deathless: false, hundredths: Math.round(((kills + assists) * 100) / deaths) };
}

function summarizeGames(games) {
  const n = games.length;
  const wins = games.filter((g) => g.win).length;
  const kills = games.reduce((s, g) => s + g.kills, 0);
  const deaths = games.reduce((s, g) => s + g.deaths, 0);
  const assists = games.reduce((s, g) => s + g.assists, 0);
  const positions = emptyPositions();
  let unknownPositions = 0;
  for (const g of games) {
    if (g.teamPosition) positions[g.teamPosition]++;
    else unknownPositions++;
  }
  return {
    games: n,
    wins,
    losses: n - wins,
    winPermil: n > 0 ? Math.round((wins * 1000) / n) : null,
    avg: n > 0
      ? {
          killsTenths: Math.round((kills * 10) / n),
          deathsTenths: Math.round((deaths * 10) / n),
          assistsTenths: Math.round((assists * 10) / n),
        }
      : null,
    kda: n > 0 ? combinedKda(kills, deaths, assists) : null,
    positions,
    unknownPositions,
  };
}

/**
 * results(최신순)에서 연속 기록. 다시하기(R)는 건너뛰고, 누락(?)을 만나면 그 너머를 모르므로 '최소'로 표시한다.
 */
function computeStreak(results) {
  let first = null;
  let count = 0;
  for (const r of results) {
    if (r === 'R') continue;
    if (r === '?') return count > 0 ? { win: first === 'W', count, atLeast: true } : null;
    if (first === null) first = r;
    if (r !== first) return { win: first === 'W', count, atLeast: false };
    count++;
  }
  // 수집 범위 끝까지 이어졌다면 그 이전 기록은 모른다
  return count > 0 ? { win: first === 'W', count, atLeast: true } : null;
}

/** 포지션 분포에서 minGames 이상·share 이상인 포지션. 없으면 null */
function dominantRole(positions, minGames, share) {
  const valid = ROLES.reduce((s, r) => s + positions[r], 0);
  if (valid < minGames) return null;
  let best = null;
  for (const r of ROLES) if (!best || positions[r] > positions[best]) best = r;
  return positions[best] >= valid * share ? best : null;
}

/** 주 포지션: 포지션 기록 mainRoleMinGames 이상, 한 포지션 비율 mainRoleShare 이상 */
function mainRoleOf(positions) {
  return dominantRole(positions, BRIEFING_CONFIG.mainRoleMinGames, BRIEFING_CONFIG.mainRoleShare);
}

/**
 * 최근 표본만으로 주 포지션을 못 정했을 때: 주챔(숙련도 상위) 경기들의 포지션으로 본다.
 * championPositions: { [championId]: positions }, championIds: 주챔 ID 목록
 */
function mainRoleFromChampions(championPositions, championIds) {
  const merged = emptyPositions();
  for (const id of championIds || []) {
    const positions = championPositions?.[id];
    if (!positions) continue;
    for (const r of ROLES) merged[r] += positions[r];
  }
  return dominantRole(merged, BRIEFING_CONFIG.mainsRoleMinGames, BRIEFING_CONFIG.mainsRoleShare);
}

/**
 * history: { status, ids, entries: [{ matchId, state, reason, game }] } (ids와 같은 최신순)
 */
function aggregateHistory(history, currentChampionId) {
  const ids = Array.isArray(history?.ids) ? history.ids : [];
  const byId = new Map((history?.entries || []).map((e) => [e.matchId, e]));
  const excluded = { remake: 0, notCompleted: 0, queue: 0, period: 0 };
  const games = [];
  const results = [];
  let failed = 0;
  let pending = 0;

  for (const matchId of ids) {
    const entry = byId.get(matchId);
    if (!entry || entry.state === 'pending') {
      pending++;
      results.push('?');
    } else if (entry.state === 'failed') {
      failed++;
      results.push('?');
    } else if (entry.state === 'excluded') {
      excluded[entry.reason] = (excluded[entry.reason] || 0) + 1;
      results.push('R');
    } else {
      games.push(entry.game);
      results.push(entry.game.win ? 'W' : 'L');
    }
  }

  const all = summarizeGames(games);
  const champion = summarizeGames(games.filter((g) => g.championId === currentChampionId));
  const excludedTotal = Object.values(excluded).reduce((s, n) => s + n, 0);
  const spyGames = games.filter((g) => g.spy !== null && g.spy !== undefined);
  const spies = spyGames.filter((g) => g.spy).length;
  const championPositions = {};
  for (const g of games) {
    if (!g.teamPosition) continue;
    championPositions[g.championId] = championPositions[g.championId] || emptyPositions();
    championPositions[g.championId][g.teamPosition]++;
  }
  const mainRole = mainRoleOf(all.positions);

  return {
    idsFound: ids.length,
    collected: games.length,
    pending,
    failed,
    excluded,
    excludedTotal,
    ...all,
    results,
    streak: computeStreak(results),
    champion,
    championPositions,
    mainRole,
    mainRoleSource: mainRole ? 'history' : null,
    recent: games.slice(0, BRIEFING_CONFIG.recentIcons).map((g) => ({ championId: g.championId, win: g.win })),
    spy: {
      samples: spyGames.length,
      spies,
      ratePermil: spyGames.length >= BRIEFING_CONFIG.spyMinSamples ? Math.round((spies * 1000) / spyGames.length) : null,
    },
    smallSample: games.length < BRIEFING_CONFIG.smallSampleThreshold,
    complete: pending === 0 && failed === 0,
  };
}

// ============================================
// 🧭 역할(포지션) 추정 — 팀 단위 배치
// ============================================
function roleScoresFor(player) {
  const w = BRIEFING_CONFIG.roleWeights;
  const agg = player.stats;
  const validAll = agg ? ROLES.reduce((s, r) => s + agg.positions[r], 0) : 0;
  const validChamp = agg ? ROLES.reduce((s, r) => s + agg.champion.positions[r], 0) : 0;
  const champFactor = Math.min(1, validChamp / w.championHistoryFullAt);

  const scores = {};
  for (const role of ROLES) {
    let score = 0;
    if (validAll > 0) score += (w.history * agg.positions[role]) / validAll;
    if (validChamp > 0) score += (w.championHistory * champFactor * agg.champion.positions[role]) / validChamp;
    if (role === 'JUNGLE') score += player.hasSmite ? w.smite : -w.noSmiteJunglePenalty;
    scores[role] = score;
  }
  return { scores, validAll, validChamp };
}

function permutations(items) {
  if (items.length <= 1) return [items.slice()];
  const out = [];
  items.forEach((item, i) => {
    const rest = items.slice(0, i).concat(items.slice(i + 1));
    for (const perm of permutations(rest)) out.push([item, ...perm]);
  });
  return out;
}
const ROLE_PERMUTATIONS = permutations(ROLES);

function describeRoleEvidence(player, role, validAll, validChamp) {
  const reasons = [];
  const agg = player.stats;
  if (validAll > 0) reasons.push(`수집 경기 중 ${ROLE_LABELS[role]} ${agg.positions[role]}/${validAll}경기`);
  if (validChamp > 0) reasons.push(`현재 챔피언 경기 중 ${ROLE_LABELS[role]} ${agg.champion.positions[role]}/${validChamp}경기`);
  if (player.hasSmite) reasons.push('강타 보유');
  if (reasons.length === 0) reasons.push('과거 포지션 기록 없음');
  return reasons;
}

/**
 * 한 팀 5명의 역할 배치. fixed: { [slot]: role } (사용자 지정)
 * 반환: Map(slot → { role, level, slotRole, reasons })
 *  - slotRole: 최선 배치에서 배정된 자리 (화면 행 정렬용, 불확실해도 채운다)
 *  - 최선 배치에서 그 사람만 다른 역할로 바꾼 최선 배치와의 점수 차가 roleMargin 미만이면 불확실
 *  - 본인 근거(포지션 기록 roleMinEvidenceGames 이상, 또는 강타+정글)가 없으면 불확실
 *  - 동점 배치는 차이가 0이므로 항상 불확실
 */
function assignTeamRoles(team, fixed = {}) {
  const result = new Map();
  if (team.length !== 5) {
    for (const p of team) result.set(p.slot, { role: null, slotRole: null, level: 'unsupported', reasons: [] });
    return result;
  }

  const scored = team.map((p) => ({ player: p, ...roleScoresFor(p) }));
  const allowed = ROLE_PERMUTATIONS.filter((perm) =>
    scored.every(({ player }, i) => !fixed[player.slot] || fixed[player.slot] === perm[i])
  );
  if (allowed.length === 0) {
    for (const p of team) result.set(p.slot, { role: null, slotRole: null, level: 'uncertain', reasons: ['지정한 포지션이 서로 겹침'] });
    return result;
  }

  const totals = allowed.map((perm) => perm.reduce((s, role, i) => s + scored[i].scores[role], 0));
  let bestIndex = 0;
  for (let i = 1; i < totals.length; i++) if (totals[i] > totals[bestIndex]) bestIndex = i;
  const best = allowed[bestIndex];
  const bestTotal = totals[bestIndex];

  scored.forEach(({ player, validAll, validChamp }, i) => {
    const role = best[i];
    if (fixed[player.slot]) {
      result.set(player.slot, { role, slotRole: role, level: 'user', reasons: ['조회자가 직접 지정'] });
      return;
    }
    let alternative = -Infinity;
    allowed.forEach((perm, k) => {
      if (perm[i] !== role) alternative = Math.max(alternative, totals[k]);
    });
    const gap = bestTotal - alternative;
    const hasEvidence =
      validAll >= BRIEFING_CONFIG.roleMinEvidenceGames || (role === 'JUNGLE' && player.hasSmite);
    const reasons = describeRoleEvidence(player, role, validAll, validChamp);
    if (!hasEvidence || gap < BRIEFING_CONFIG.roleMargin) {
      result.set(player.slot, { role: null, slotRole: role, level: 'uncertain', reasons });
    } else {
      result.set(player.slot, { role, slotRole: role, level: 'estimated', reasons });
    }
  });
  return result;
}

// ============================================
// 👤 조회자 관점
// ============================================

/**
 * model: { game, participants, targetPuuid } (participants[].stats = aggregateHistory 결과)
 * roleOverride: 조회 대상의 포지션 직접 지정 (ROLES 중 하나) — 상대 역할은 확정하지 않는다
 * 조회 대상을 찾지 못해도 두 팀의 역할 배치는 계산한다 (화면 행 정렬용).
 */
function buildPerspective(model, { roleOverride = null } = {}) {
  const { game, participants, targetPuuid } = model;
  const target = targetPuuid ? participants.find((p) => p.puuid && p.puuid === targetPuuid) : null;
  const supported = isRoleAnalysisSupported(game, participants);
  const teamIds = [...new Set(participants.map((p) => p.teamId))];

  const roles = new Map();
  for (const teamId of teamIds) {
    const team = participants.filter((p) => p.teamId === teamId);
    if (!supported) {
      for (const p of team) roles.set(p.slot, { role: null, slotRole: null, level: 'unsupported', reasons: [] });
      continue;
    }
    const fixed = target && target.teamId === teamId && roleOverride && ROLES.includes(roleOverride)
      ? { [target.slot]: roleOverride }
      : {};
    for (const [slot, r] of assignTeamRoles(team, fixed)) roles.set(slot, r);
  }

  if (!target) {
    return { mode: 'general', reason: 'TARGET_NOT_FOUND', target: null, roles, roleSupported: supported };
  }

  const allies = participants.filter((p) => p.teamId === target.teamId);
  const enemies = participants.filter((p) => p.teamId !== target.teamId);
  const myRole = roles.get(target.slot);
  const withRole = (list, role) =>
    list.filter((p) => {
      const r = roles.get(p.slot);
      return r.role === role && (r.level === 'estimated' || r.level === 'user');
    });

  let lane;
  if (!supported) {
    lane = { type: 'none', note: '역할 분석 대상 모드가 아니어서 라인 분석을 생략했습니다.' };
  } else if (!myRole.role) {
    lane = { type: 'none', note: '포지션 확인 불가 — 라인 분석을 생략합니다.' };
  } else if (myRole.role === 'TOP' || myRole.role === 'MIDDLE') {
    lane = { type: 'solo', opponents: withRole(enemies, myRole.role) };
  } else if (myRole.role === 'BOTTOM' || myRole.role === 'UTILITY') {
    const allyDuo = [...withRole(allies, 'BOTTOM'), ...withRole(allies, 'UTILITY')];
    if (!allyDuo.includes(target)) allyDuo.unshift(target);
    lane = { type: 'bottom', allyDuo, opponents: [...withRole(enemies, 'BOTTOM'), ...withRole(enemies, 'UTILITY')] };
  } else {
    lane = { type: 'jungle', opponents: withRole(enemies, 'JUNGLE') };
  }

  return {
    mode: 'personal',
    target,
    allyTeamId: target.teamId,
    enemyTeamId: enemies[0]?.teamId ?? null,
    allies,
    enemies,
    roles,
    myRole,
    roleSupported: supported,
    lane,
  };
}

// ============================================
// 🏷️ 태그 · 티어 · 팀 요약
// ============================================

/**
 * PS식 태그. 모두 입력 데이터에서 나온 사실만 쓴다.
 *  - #라인꼬임: 주 포지션이 있는데 이번 판 추정 포지션이 다름
 *  - #라인꼬임?: 같은 팀에 주 포지션이 같은 사람이 있음 (누군가는 주 포지션이 아닐 수 있음)
 *  - #N연승 / #N연패: 수집 경기 기준 3연속 이상 (누락이 끼면 '+')
 *  - #장인: 수집 경기 중 현재 챔피언 10경기 이상이면서 절반 이상
 *  - #첩자주의: 수집 경기 첩자 판정률 40% 이상 (재미용)
 */
function playerTags(player, roleInfo, teammates) {
  const s = player.stats;
  const tags = [];
  if (!s) return tags;
  const c = BRIEFING_CONFIG;

  if (s.mainRole) {
    if (roleInfo?.role && roleInfo.level === 'estimated' && roleInfo.role !== s.mainRole) {
      tags.push({ text: '#라인꼬임', tone: 'bad' });
    } else if (teammates.some((t) => t !== player && t.stats?.mainRole === s.mainRole)) {
      tags.push({ text: '#라인꼬임?', tone: 'bad' });
    }
  }
  if (s.streak && s.streak.count >= c.streakTagMin) {
    const label = `#${s.streak.count}${s.streak.win ? '연승' : '연패'}${s.streak.atLeast ? '+' : ''}`;
    tags.push({ text: label, tone: s.streak.win ? 'good' : 'bad' });
  }
  if (s.champion.games >= c.masteryTagGames && s.champion.games >= s.collected * c.masteryTagShare) {
    tags.push({ text: '#장인', tone: 'good' });
  }
  if (s.spy.ratePermil !== null && s.spy.ratePermil >= c.spyWarnPermil) {
    tags.push({ text: '#첩자주의', tone: 'bad' });
  }
  return tags;
}

const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND'];
const APEX_TIERS = ['MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVISIONS = ['IV', 'III', 'II', 'I'];
const TIER_KO = {
  IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드', PLATINUM: '플래티넘',
  EMERALD: '에메랄드', DIAMOND: '다이아몬드', MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저',
};
const TIER_SHORT = {
  IRON: 'I', BRONZE: 'B', SILVER: 'S', GOLD: 'G', PLATINUM: 'P', EMERALD: 'E', DIAMOND: 'D',
  MASTER: 'M', GRANDMASTER: 'GM', CHALLENGER: 'C',
};
const DIVISION_NUMBER = { IV: 4, III: 3, II: 2, I: 1 };

/** 평균 계산용 점수: 아이언 IV 0LP = 0, 한 구간 100, 마스터 이상은 2800 + LP */
function tierScore(rank) {
  if (rank?.status !== 'ranked') return null;
  const lp = Number.isFinite(rank.lp) ? Math.max(0, rank.lp) : 0;
  if (APEX_TIERS.includes(rank.tier)) return 2800 + lp;
  const t = TIERS.indexOf(rank.tier);
  const d = DIVISIONS.indexOf(rank.division);
  if (t < 0 || d < 0) return null;
  return t * 400 + d * 100 + Math.min(lp, 99);
}

function tierFromScore(score) {
  if (score >= 2800) return { tier: 'MASTER', division: null, label: '마스터+', badge: 'M+' };
  const t = Math.floor(score / 400);
  const d = Math.floor((score % 400) / 100);
  const tier = TIERS[t];
  const division = DIVISIONS[d];
  return { tier, division, label: `${TIER_KO[tier]} ${division}`, badge: `${TIER_SHORT[tier]}${DIVISION_NUMBER[division]}` };
}

/** 'D1', 'M', 'U'(언랭크), '-'(비공개·봇), '?'(조회 실패·미조회) */
function tierBadge(rank) {
  if (rank?.status === 'unranked') return 'U';
  if (rank?.status === 'hidden' || rank?.status === 'bot') return '-';
  if (rank?.status !== 'ranked') return '?';
  if (APEX_TIERS.includes(rank.tier)) return TIER_SHORT[rank.tier];
  return `${TIER_SHORT[rank.tier] || '?'}${DIVISION_NUMBER[rank.division] || ''}`;
}

function tierName(rank) {
  if (rank?.status !== 'ranked') return null;
  const tier = TIER_KO[rank.tier] || rank.tier;
  return APEX_TIERS.includes(rank.tier) ? tier : `${tier} ${rank.division}`;
}

/** 랭크가 있는 참가자만으로 평균 티어. 없으면 null */
function averageTier(players) {
  const scores = players.map((p) => tierScore(p.rank)).filter((s) => s !== null);
  if (scores.length === 0) return null;
  const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  return { ...tierFromScore(avg), counted: scores.length, total: players.length };
}

/**
 * 팀에 첩자가 1명 이상 있을 확률 (재미용).
 * 각자의 최근 경기 첩자 판정률을 독립이라고 보고 1 − Π(1 − p). excludeSlot(조회 대상 본인)은 뺀다.
 * 판정률이 있는 사람이 spyTeamMinPlayers 미만이면 null.
 */
function teamSpyEstimate(players, excludeSlot = null) {
  const rates = players
    .filter((p) => p.slot !== excludeSlot)
    .map((p) => p.stats?.spy?.ratePermil)
    .filter((r) => r !== null && r !== undefined);
  const considered = players.filter((p) => p.slot !== excludeSlot).length;
  if (rates.length < BRIEFING_CONFIG.spyTeamMinPlayers) return { permil: null, counted: rates.length, considered };
  const none = rates.reduce((acc, r) => acc * (1 - r / 1000), 1);
  const expected = rates.reduce((acc, r) => acc + r / 1000, 0);
  return {
    permil: Math.round((1 - none) * 1000),
    expectedTenths: Math.round(expected * 10),
    counted: rates.length,
    considered,
  };
}

// ============================================
// 🧾 표시용 포맷 (정수 → 문자열)
// ============================================
function formatPermil(permil) {
  return `${Math.floor(permil / 10)}.${permil % 10}`;
}

function formatPercentPermil(permil) {
  return `${Math.round(permil / 10)}`;
}

function formatTenths(tenths) {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

function formatKda(kda) {
  if (!kda) return '-';
  if (kda.deathless) return '데스 없음';
  const h = kda.hundredths;
  return `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;
}

function formatStreak(streak) {
  if (!streak) return null;
  const label = `${streak.count}${streak.win ? '연승' : '연패'}`;
  return streak.atLeast ? `최소 ${label}` : label;
}

module.exports = {
  BRIEFING_CONFIG,
  ROLES,
  ROLE_LABELS,
  ROLE_LEVEL_LABELS,
  ROLE_QUEUES,
  SMITE_SPELL_ID,
  MatchDataError,
  queueName,
  mapName,
  rankQueueTypeFor,
  isHistoryQueue,
  isRoleAnalysisSupported,
  compactMatch,
  evaluateMatchFor,
  combinedKda,
  computeStreak,
  mainRoleOf,
  mainRoleFromChampions,
  aggregateHistory,
  roleScoresFor,
  assignTeamRoles,
  buildPerspective,
  playerTags,
  tierScore,
  tierBadge,
  tierName,
  averageTier,
  teamSpyEstimate,
  formatPermil,
  formatPercentPermil,
  formatTenths,
  formatKda,
  formatStreak,
};
