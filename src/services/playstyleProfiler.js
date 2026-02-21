// ============================================
// 📊 Playstyle Profiler — 50게임 플레이스타일 프로파일링
// ============================================

/**
 * 티어별 벤치마크 (평균값 기준)
 */
const TIER_BENCHMARKS = {
  IRON:         { csPerMin: 4.0, visionPerMin: 0.4, deaths: 7.0, kda: 1.8 },
  BRONZE:       { csPerMin: 4.5, visionPerMin: 0.5, deaths: 6.5, kda: 2.0 },
  SILVER:       { csPerMin: 5.0, visionPerMin: 0.6, deaths: 6.0, kda: 2.3 },
  GOLD:         { csPerMin: 5.5, visionPerMin: 0.7, deaths: 5.5, kda: 2.5 },
  PLATINUM:     { csPerMin: 6.0, visionPerMin: 0.8, deaths: 5.0, kda: 2.8 },
  EMERALD:      { csPerMin: 6.5, visionPerMin: 0.9, deaths: 4.8, kda: 3.0 },
  DIAMOND:      { csPerMin: 7.0, visionPerMin: 1.0, deaths: 4.5, kda: 3.2 },
  MASTER:       { csPerMin: 7.5, visionPerMin: 1.1, deaths: 4.2, kda: 3.5 },
  GRANDMASTER:  { csPerMin: 8.0, visionPerMin: 1.2, deaths: 4.0, kda: 3.8 },
  CHALLENGER:   { csPerMin: 8.5, visionPerMin: 1.3, deaths: 3.8, kda: 4.0 },
};

/**
 * 값을 1~10 스코어로 변환
 * benchmark = 해당 티어 평균 (스코어 5)
 */
function scoreValue(value, benchmark, higherIsBetter = true) {
  const ratio = value / benchmark;
  let score;

  if (higherIsBetter) {
    // 평균=5, 50% 이상이면 10에 가까워짐
    score = Math.round(ratio * 5);
  } else {
    // deaths 같이 낮을수록 좋은 지표
    score = Math.round((1 / ratio) * 5);
  }

  return Math.max(1, Math.min(10, score));
}

/**
 * 랭크 문자열에서 티어 추출
 * "골드 IV 50LP (52% / 100판)" → "GOLD"
 */
function extractTier(rankString) {
  const tierMap = {
    '아이언': 'IRON', '브론즈': 'BRONZE', '실버': 'SILVER',
    '골드': 'GOLD', '플래티넘': 'PLATINUM', '에메랄드': 'EMERALD',
    '다이아몬드': 'DIAMOND', '마스터': 'MASTER',
    '그랜드마스터': 'GRANDMASTER', '챌린저': 'CHALLENGER',
  };

  for (const [ko, en] of Object.entries(tierMap)) {
    if (rankString.includes(ko)) return en;
  }
  return 'GOLD'; // 기본값
}

/**
 * 50게임 매치 데이터에서 플레이스타일 프로파일 생성
 *
 * @param {Array} matchDetails - 매치 디테일 객체 배열
 * @param {string} puuid - 대상 플레이어 PUUID
 * @param {string} rank - 포맷된 랭크 문자열
 * @param {string} summonerName - 소환사명 (표시용)
 * @returns {Object} playstyleProfile
 */
function profilePlaystyle(matchDetails, puuid, rank, summonerName) {
  // 소환사 협곡 게임만 필터링
  const classicMatches = matchDetails.filter(
    (m) => m && m.info && (m.info.gameMode === 'CLASSIC' || m.info.queueId === 420 || m.info.queueId === 440)
  );

  if (classicMatches.length === 0) {
    return getEmptyProfile(summonerName, rank);
  }

  const tier = extractTier(rank);
  const benchmark = TIER_BENCHMARKS[tier] || TIER_BENCHMARKS.GOLD;

  // 매치별 참가자 데이터 추출
  const participantData = classicMatches
    .map((match) => {
      const p = match.info.participants.find((pp) => pp.puuid === puuid);
      if (!p) return null;

      const duration = match.info.gameDuration;
      const durationMin = duration / 60;
      const totalCs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);

      // 솔로킬 계산 (어시스트 없는 킬)
      // 매치 디테일에서는 정확한 솔로킬을 알 수 없으므로 근사치 사용
      const estimatedSoloKills = Math.max(0, p.kills - Math.floor(p.assists * 0.3));

      return {
        win: p.win,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        cs: totalCs,
        csPerMin: durationMin > 0 ? totalCs / durationMin : 0,
        visionScore: p.visionScore || 0,
        visionPerMin: durationMin > 0 ? (p.visionScore || 0) / durationMin : 0,
        damage: p.totalDamageDealtToChampions || 0,
        killParticipation: 0, // 아래에서 계산
        champion: p.championName,
        role: p.teamPosition || '',
        duration: durationMin,
        soloKills: estimatedSoloKills,
        goldEarned: p.goldEarned || 0,
        turretKills: p.turretTakedowns || p.turretKills || 0,
        teamId: p.teamId,
        teamKills: 0, // 아래에서 계산
      };
    })
    .filter(Boolean);

  // 팀 킬 수 계산 및 킬관여율
  for (let i = 0; i < participantData.length; i++) {
    const match = classicMatches[i];
    const pd = participantData[i];
    const teamKills = match.info.participants
      .filter((p) => p.teamId === pd.teamId)
      .reduce((sum, p) => sum + p.kills, 0);
    pd.teamKills = teamKills;
    pd.killParticipation =
      teamKills > 0 ? Math.round(((pd.kills + pd.assists) / teamKills) * 100) : 0;
  }

  const total = participantData.length;

  // ============================================
  // 종합 통계
  // ============================================
  const wins = participantData.filter((p) => p.win).length;
  const winRate = Math.round((wins / total) * 100);

  const avgKills = participantData.reduce((s, p) => s + p.kills, 0) / total;
  const avgDeaths = participantData.reduce((s, p) => s + p.deaths, 0) / total;
  const avgAssists = participantData.reduce((s, p) => s + p.assists, 0) / total;
  const avgCsPerMin = participantData.reduce((s, p) => s + p.csPerMin, 0) / total;
  const avgVisionScore = participantData.reduce((s, p) => s + p.visionScore, 0) / total;
  const avgVisionPerMin = participantData.reduce((s, p) => s + p.visionPerMin, 0) / total;
  const avgDamage = Math.round(participantData.reduce((s, p) => s + p.damage, 0) / total);
  const avgKillParticipation = Math.round(
    participantData.reduce((s, p) => s + p.killParticipation, 0) / total
  );
  const avgSoloKills = participantData.reduce((s, p) => s + p.soloKills, 0) / total;

  const avgKDA =
    avgDeaths === 0
      ? 'Perfect'
      : ((avgKills + avgAssists) / avgDeaths).toFixed(2);

  // ============================================
  // 스코어 계산 (1~10)
  // ============================================
  const aggression = scoreValue(avgSoloKills + (avgKills * 0.5), benchmark.kda * 0.8, true);
  const csSkill = scoreValue(avgCsPerMin, benchmark.csPerMin, true);
  const visionScoreVal = scoreValue(avgVisionPerMin, benchmark.visionPerMin, true);

  // 로밍 점수: 다른 라인에서의 킬/어시스트 비율 추정
  // (정글러이거나 어시스트 비율이 높으면 로밍 점수 높음)
  const assistRatio = avgAssists / Math.max(avgKills + avgAssists, 1);
  const roaming = Math.max(1, Math.min(10, Math.round(assistRatio * 12)));

  // 후반 운영: 30분+ 게임에서의 성과
  const lateGames = participantData.filter((p) => p.duration > 30);
  let lateGameSkill = 5;
  if (lateGames.length >= 3) {
    const lateWinRate = lateGames.filter((p) => p.win).length / lateGames.length;
    lateGameSkill = Math.max(1, Math.min(10, Math.round(lateWinRate * 10)));
  }

  // ============================================
  // 챔피언 풀 (Top 3)
  // ============================================
  const champMap = {};
  for (const p of participantData) {
    if (!champMap[p.champion]) {
      champMap[p.champion] = {
        champion: p.champion,
        games: 0,
        wins: 0,
        kills: 0,
        deaths: 0,
        assists: 0,
        cs: 0,
        damage: 0,
        role: p.role,
      };
    }
    const c = champMap[p.champion];
    c.games++;
    if (p.win) c.wins++;
    c.kills += p.kills;
    c.deaths += p.deaths;
    c.assists += p.assists;
    c.cs += p.csPerMin;
    c.damage += p.damage;
  }

  const championPool = Object.values(champMap)
    .sort((a, b) => b.games - a.games)
    .slice(0, 3)
    .map((c) => ({
      champion: c.champion,
      games: c.games,
      winRate: Math.round((c.wins / c.games) * 100),
      avgKDA:
        c.deaths === 0
          ? 'Perfect'
          : ((c.kills + c.assists) / c.deaths).toFixed(2),
      avgCs: (c.cs / c.games).toFixed(1),
      avgDamage: Math.round(c.damage / c.games),
      role: c.role,
    }));

  // ============================================
  // 포지션 분포
  // ============================================
  const roleCount = { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 };
  for (const p of participantData) {
    if (roleCount[p.role] !== undefined) {
      roleCount[p.role]++;
    }
  }
  const roleDistribution = {};
  for (const [role, count] of Object.entries(roleCount)) {
    roleDistribution[role] = Math.round((count / total) * 100);
  }

  return {
    summonerName,
    rank,
    totalGames: total,
    winRate,

    aggression,
    roaming,
    visionScore: visionScoreVal,
    csSkill,
    lateGameSkill,

    avgSoloKills: avgSoloKills.toFixed(1),
    avgDeaths: avgDeaths.toFixed(1),
    avgVisionScore: avgVisionScore.toFixed(1),
    avgCsPerMin: avgCsPerMin.toFixed(1),
    avgKDA,
    avgDamage,
    avgKillParticipation,

    championPool,
    roleDistribution,
  };
}

function getEmptyProfile(summonerName, rank) {
  return {
    summonerName,
    rank,
    totalGames: 0,
    winRate: 0,
    aggression: 5,
    roaming: 5,
    visionScore: 5,
    csSkill: 5,
    lateGameSkill: 5,
    avgSoloKills: '0',
    avgDeaths: '0',
    avgVisionScore: '0',
    avgCsPerMin: '0',
    avgKDA: '0',
    avgDamage: 0,
    avgKillParticipation: 0,
    championPool: [],
    roleDistribution: { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 },
  };
}

module.exports = { profilePlaystyle };
