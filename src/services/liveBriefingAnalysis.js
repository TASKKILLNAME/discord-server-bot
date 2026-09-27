// ============================================
// 🧮 /전적 실시간 게임 시작 브리핑 — 순수 계산 (API·Discord·AI 무관)
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
  frequentChampionGames: 5, // 상대 후보의 '자주 사용' 사실을 표시할 최소 경기 수

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
  confirmed: '확인됨',
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

function queueName(queueId) {
  return ROLE_QUEUES.get(queueId) || OTHER_QUEUE_NAMES.get(queueId) || `큐 ${queueId}`;
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
 * 매치 상세를 브리핑에 필요한 필드만 남긴 형태로 줄인다. 구조가 깨졌으면 MatchDataError.
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
      win: p.win,
      kills: p.kills,
      deaths: p.deaths,
      assists: p.assists,
      teamPosition: typeof p.teamPosition === 'string' ? p.teamPosition : '',
      earlySurrender: p.gameEndedInEarlySurrender === true,
    };
  }

  return {
    matchId: expectedMatchId,
    queueId: info.queueId,
    gameEndTimestamp: Number.isFinite(info.gameEndTimestamp) ? info.gameEndTimestamp : null,
    endOfGameResult: typeof info.endOfGameResult === 'string' ? info.endOfGameResult : null,
    participants,
  };
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
  if (validAll > 0) {
    reasons.push(`수집 경기 중 ${ROLE_LABELS[role]} ${agg.positions[role]}/${validAll}경기`);
  }
  if (validChamp > 0) {
    reasons.push(`현재 챔피언 경기 중 ${ROLE_LABELS[role]} ${agg.champion.positions[role]}/${validChamp}경기`);
  }
  if (player.hasSmite) reasons.push('강타 보유');
  if (reasons.length === 0) reasons.push('과거 포지션 기록 없음');
  return reasons;
}

/**
 * 한 팀 5명의 역할 배치. fixed: { [slot]: role } (사용자 지정)
 * 반환: Map(slot → { role, level, reasons })
 *  - 최선 배치에서 그 사람만 다른 역할로 바꾼 최선 배치와의 점수 차가 roleMargin 미만이면 불확실
 *  - 본인 근거(포지션 기록 roleMinEvidenceGames 이상, 또는 강타+정글)가 없으면 불확실
 *  - 동점 배치는 차이가 0이므로 항상 불확실
 */
function assignTeamRoles(team, fixed = {}) {
  const result = new Map();
  if (team.length !== 5) {
    for (const p of team) result.set(p.slot, { role: null, level: 'unsupported', reasons: [] });
    return result;
  }

  const scored = team.map((p) => ({ player: p, ...roleScoresFor(p) }));
  const allowed = ROLE_PERMUTATIONS.filter((perm) =>
    scored.every(({ player }, i) => !fixed[player.slot] || fixed[player.slot] === perm[i])
  );
  if (allowed.length === 0) {
    for (const p of team) result.set(p.slot, { role: null, level: 'uncertain', reasons: ['지정한 포지션이 서로 겹침'] });
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
      result.set(player.slot, { role, level: 'user', reasons: ['조회자가 직접 지정'] });
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
      result.set(player.slot, { role: null, level: 'uncertain', reasons });
    } else {
      result.set(player.slot, { role, level: 'estimated', reasons });
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
 */
function buildPerspective(model, { roleOverride = null } = {}) {
  const { game, participants, targetPuuid } = model;
  const target = targetPuuid ? participants.find((p) => p.puuid && p.puuid === targetPuuid) : null;
  if (!target) {
    return { mode: 'general', reason: 'TARGET_NOT_FOUND', target: null };
  }

  const allies = participants.filter((p) => p.teamId === target.teamId);
  const enemies = participants.filter((p) => p.teamId !== target.teamId);
  const enemyTeamId = enemies[0]?.teamId ?? null;
  const supported = isRoleAnalysisSupported(game, participants);

  let roles = new Map();
  if (supported) {
    const fixed = roleOverride && ROLES.includes(roleOverride) ? { [target.slot]: roleOverride } : {};
    roles = new Map([...assignTeamRoles(allies, fixed), ...assignTeamRoles(enemies)]);
  } else {
    for (const p of participants) roles.set(p.slot, { role: null, level: 'unsupported', reasons: [] });
  }

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
    lane = { type: 'none', note: '포지션 확인 불가 — 라인 분석을 생략하고 일반 정보만 표시합니다.' };
  } else if (myRole.role === 'TOP' || myRole.role === 'MIDDLE') {
    const opponents = withRole(enemies, myRole.role);
    lane = {
      type: 'solo',
      opponents,
      note: opponents.length === 0 ? `상대 ${ROLE_LABELS[myRole.role]} 후보 포지션 확인 불가` : null,
    };
  } else if (myRole.role === 'BOTTOM' || myRole.role === 'UTILITY') {
    const allyDuo = [...withRole(allies, 'BOTTOM'), ...withRole(allies, 'UTILITY')];
    if (!allyDuo.includes(target)) allyDuo.unshift(target);
    const enemyDuo = [...withRole(enemies, 'BOTTOM'), ...withRole(enemies, 'UTILITY')];
    lane = {
      type: 'bottom',
      allyDuo,
      opponents: enemyDuo,
      note: enemyDuo.length < 2 ? '상대 바텀 듀오 일부 포지션 확인 불가' : null,
    };
  } else {
    const opponents = withRole(enemies, 'JUNGLE');
    lane = {
      type: 'jungle',
      opponents,
      note: '정글은 맞라인 상대가 아닙니다. 상대 정글의 현재 위치·동선은 추측하지 않습니다.',
    };
  }

  return {
    mode: 'personal',
    target,
    allyTeamId: target.teamId,
    enemyTeamId,
    allies,
    enemies,
    roles,
    myRole,
    roleOverride: myRole.level === 'user' ? myRole.role : null,
    roleSupported: supported,
    lane,
  };
}

// ============================================
// 🧩 조합 특성 · 주의할 점 · 운영 선택지
// ============================================

/**
 * knowledge.profileFor(championId) → Data Dragon 기반 프로필 또는 null
 * knowledge.verifiedTraitsFor(dataId) → 검수 완료 특성 { engage: {...} } 또는 {}
 */
function summarizeTeamComposition(players, knowledge) {
  const hardCc = [];
  const damage = { physical: 0, magic: 0, mixed: 0, unknown: 0 };
  const curated = { engage: [], protect: [], frontline: [], poke: [] };
  for (const p of players) {
    const profile = knowledge.profileFor(p.championId);
    if (!profile) {
      damage.unknown++;
      continue;
    }
    if (profile.hardCc.length > 0) {
      hardCc.push({ championName: p.championName, skills: profile.hardCc });
    }
    damage[profile.damageLean || 'unknown']++;
    const traits = knowledge.verifiedTraitsFor(profile.id);
    for (const key of Object.keys(curated)) {
      if (traits[key]?.value === true) curated[key].push({ championName: p.championName, evidence: traits[key].evidence });
    }
  }
  const known = players.length - damage.unknown;
  return {
    hardCc,
    damage,
    known,
    total: players.length,
    curated,
    // 자료가 있는 챔피언이 4명 미만이면 팀 전체 결론을 유보한다
    conclusive: known >= 4,
  };
}

function roleLabelFor(perspective, player) {
  const r = perspective.roles.get(player.slot);
  return r?.role ? ROLE_LABELS[r.role] : '포지션 불확실';
}

function firstOrNull(list) {
  return list && list.length > 0 ? list[0] : null;
}

/**
 * 사실(fact)과 그 사실에 근거한 주의할 점(최대 3)·운영 선택지(최대 2)를 만든다.
 * 모든 문장은 입력 데이터나 검수된 자료에서 온다. 자료가 없으면 만들지 않는다.
 */
function buildBriefContent(perspective, knowledge, game) {
  const facts = [];
  const addFact = (subject, text) => {
    const id = `F${facts.length + 1}`;
    facts.push({ id, subject, text });
    return id;
  };
  const cautions = [];
  const options = [];

  if (perspective.mode !== 'personal') {
    return { facts, cautions, options, compAlly: null, compEnemy: null, matchups: [] };
  }

  const { target, lane, allies, enemies } = perspective;
  const compAlly = summarizeTeamComposition(allies, knowledge);
  const compEnemy = summarizeTeamComposition(enemies, knowledge);
  const myProfile = knowledge.profileFor(target.championId);

  // 1) 검수된 상대법
  const matchups = [];
  if (lane.type !== 'none' && myProfile) {
    const opponentIds = (lane.opponents || [])
      .map((p) => knowledge.profileFor(p.championId)?.id)
      .filter(Boolean);
    const allyIds = lane.type === 'bottom'
      ? (lane.allyDuo || []).map((p) => knowledge.profileFor(p.championId)?.id).filter(Boolean)
      : [myProfile.id];
    matchups.push(
      ...knowledge.findMatchups({ laneType: lane.type, role: perspective.myRole.role, allyIds, opponentIds, queueId: game.queueId })
    );
  }
  for (const m of matchups) {
    for (const text of m.cautions) {
      const f = addFact('MATCHUP', `검수된 상대법(${m.id}): ${text}`);
      cautions.push({ source: 'verified-matchup', text, factIds: [f], matchupId: m.id });
    }
    for (const text of m.options) {
      const f = addFact('MATCHUP', `검수된 상대법(${m.id}) 운영: ${text}`);
      options.push({ source: 'verified-matchup', text, factIds: [f], matchupId: m.id });
    }
  }

  // 2) 상대법 자료가 없으면 상대 챔피언의 공식 일반 팁 (특정 매치업의 정답이 아님)
  if (matchups.length === 0 && lane.type !== 'none') {
    for (const opponent of lane.opponents || []) {
      const tip = firstOrNull(knowledge.profileFor(opponent.championId)?.enemytips);
      if (!tip) continue;
      const f = addFact('ENEMY_LANE', `${opponent.championName} 공식 일반 팁(Data Dragon enemytips): ${tip}`);
      cautions.push({ source: 'official-tip', text: `${opponent.championName} 공식 일반 팁: ${tip}`, factIds: [f] });
      break;
    }
  }

  // 3) 적 조합 — 하드 CC (스킬 설명 키워드 기준)
  if (compEnemy.hardCc.length >= 3) {
    const names = compEnemy.hardCc.map((h) => h.championName).join(', ');
    const f = addFact('ENEMY_TEAM', `적 팀 중 스킬 설명에 하드 CC 표현이 있는 챔피언 ${compEnemy.hardCc.length}명: ${names}`);
    cautions.push({
      source: 'composition',
      text: `적 팀에 하드 CC 스킬 보유 챔피언이 ${compEnemy.hardCc.length}명(${names})입니다. 교전 전에 진입 각과 시야를 확인하세요.`,
      factIds: [f],
    });
  }

  // 4) 상대 후보의 현재 챔피언 표본 (사실만, 실력 판정 없음)
  for (const opponent of lane.opponents || []) {
    const s = opponent.stats;
    if (!s || s.champion.games < BRIEFING_CONFIG.frequentChampionGames) continue;
    const f = addFact(
      'ENEMY_LANE',
      `${opponent.championName}(${roleLabelFor(perspective, opponent)} 후보): 최근 수집 ${s.collected}경기 중 해당 챔피언 ${s.champion.games}경기(${s.champion.wins}승 ${s.champion.losses}패)`
    );
    cautions.push({
      source: 'record',
      text: `상대 ${opponent.championName}: 최근 수집 ${s.collected}경기 중 해당 챔피언 ${s.champion.games}경기로 이 챔피언 표본이 많습니다.`,
      factIds: [f],
    });
    break;
  }

  // 5) 적 조합 — 피해 성향 (공식 성향 수치 기준, 실제 피해 비율 아님)
  if (compEnemy.conclusive) {
    for (const [lean, label] of [['physical', '물리'], ['magic', '마법']]) {
      if (compEnemy.damage[lean] >= 4) {
        const f = addFact('ENEMY_TEAM', `적 팀 ${compEnemy.known}명 중 ${label} 피해 성향 ${compEnemy.damage[lean]}명 (Data Dragon info 수치 기준)`);
        cautions.push({
          source: 'composition',
          text: `적 팀은 ${label} 피해 성향 챔피언이 ${compEnemy.damage[lean]}명입니다(공식 성향 수치 기준, 실제 피해 비율 아님). 방어 아이템 선택 시 참고하세요.`,
          factIds: [f],
        });
      }
    }
  }

  // 운영 선택지: 내 챔피언 공식 팁 → 우리 조합 하드 CC
  for (const tip of (myProfile?.allytips || []).slice(0, 2)) {
    const f = addFact('ME', `${target.championName} 공식 챔피언 팁(Data Dragon allytips): ${tip}`);
    options.push({ source: 'official-tip', text: `${target.championName} 공식 팁: ${tip}`, factIds: [f] });
  }
  if (compAlly.hardCc.length >= 3) {
    const names = compAlly.hardCc.map((h) => h.championName).join(', ');
    const f = addFact('ALLY_TEAM', `우리 팀 중 스킬 설명에 하드 CC 표현이 있는 챔피언 ${compAlly.hardCc.length}명: ${names}`);
    options.push({
      source: 'composition',
      text: `우리 팀도 하드 CC 스킬 보유 챔피언이 ${compAlly.hardCc.length}명(${names})이라, 스킬을 연계해 교전을 여는 운영을 선택지로 둘 수 있습니다.`,
      factIds: [f],
    });
  }

  const ordered = (list, order) =>
    list
      .map((item, i) => ({ item, i }))
      .sort((a, b) => order.indexOf(a.item.source) - order.indexOf(b.item.source) || a.i - b.i)
      .map(({ item }) => item);

  const pickedCautions = ordered(cautions, ['verified-matchup', 'official-tip', 'composition', 'record']).slice(0, 3);
  const pickedOptions = ordered(options, ['verified-matchup', 'official-tip', 'composition']).slice(0, 2);
  pickedCautions.forEach((c, i) => { c.id = `C${i + 1}`; });
  pickedOptions.forEach((o, i) => { o.id = `O${i + 1}`; });

  return { facts, cautions: pickedCautions, options: pickedOptions, compAlly, compEnemy, matchups };
}

// ============================================
// 🧾 표시용 포맷 (정수 → 문자열)
// ============================================
function formatPermil(permil) {
  return `${Math.floor(permil / 10)}.${permil % 10}`;
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
  rankQueueTypeFor,
  isHistoryQueue,
  isRoleAnalysisSupported,
  compactMatch,
  evaluateMatchFor,
  combinedKda,
  computeStreak,
  aggregateHistory,
  roleScoresFor,
  assignTeamRoles,
  buildPerspective,
  summarizeTeamComposition,
  buildBriefContent,
  formatPermil,
  formatTenths,
  formatKda,
  formatStreak,
};
