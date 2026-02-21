// ============================================
// 📊 Match Timeline Parser — 의사결정 데이터 분해기
// Riot Match-v5 Timeline → Claude 코칭용 구조화 데이터
// ============================================

/**
 * 소환사 협곡 맵 구역 분류
 * 맵 크기: 약 15000x15000 유닛
 */
function classifyLocation(x, y, teamId) {
  // 블루팀(100) 기준 좌표 정규화 — 레드팀(200)이면 좌표 반전
  const nx = teamId === 100 ? x : 15000 - x;
  const ny = teamId === 100 ? y : 15000 - y;

  // 적 베이스 (레드 넥서스 부근)
  if (nx > 12500 && ny > 12500) return 'ENEMY_BASE';

  // 리버 존 (대각선 밴드)
  const riverCenter = (nx + ny) / 2;
  if (riverCenter > 6000 && riverCenter < 9000 && Math.abs(nx - ny) < 5000) {
    return 'RIVER';
  }

  // 적 정글 (맵 우상단 쪽)
  if (nx + ny > 17000 && nx > 5000 && ny > 5000) return 'ENEMY_JUNGLE';

  // 아군 정글 (맵 좌하단 쪽)
  if (nx + ny < 13000 && nx < 10000 && ny < 10000 && nx > 2000 && ny > 2000) {
    return 'OWN_JUNGLE';
  }

  // 라인 과확장 — 맵 중앙 넘어서 적 쪽
  if (nx + ny > 16000) return 'LANE_OVEREXTENDED';

  // 라인 안전 지역 — 자기 쪽
  return 'LANE_SAFE';
}

/**
 * 매치 디테일에서 라인 상대 participantId 찾기
 */
function findLaneOpponent(matchDetail, participantId) {
  const participants = matchDetail.info.participants;
  const target = participants.find((p) => p.participantId === participantId);
  if (!target || !target.teamPosition) return null;

  const opponent = participants.find(
    (p) =>
      p.teamId !== target.teamId &&
      p.teamPosition === target.teamPosition &&
      p.participantId !== participantId
  );
  return opponent ? opponent.participantId : null;
}

/**
 * 특정 시간의 골드 값 조회 (가장 가까운 프레임)
 */
function getGoldAtTime(frames, participantId, targetTimestampMs) {
  let closestFrame = null;
  let minDiff = Infinity;

  for (const frame of frames) {
    const diff = Math.abs(frame.timestamp - targetTimestampMs);
    if (diff < minDiff) {
      minDiff = diff;
      closestFrame = frame;
    }
  }

  if (!closestFrame || !closestFrame.participantFrames) return 0;
  const pf = closestFrame.participantFrames[String(participantId)];
  return pf ? pf.totalGold : 0;
}

/**
 * 특정 시간의 CS(미니언 처치) 조회
 */
function getCsAtTime(frames, participantId, targetTimestampMs) {
  let closestFrame = null;
  let minDiff = Infinity;

  for (const frame of frames) {
    const diff = Math.abs(frame.timestamp - targetTimestampMs);
    if (diff < minDiff) {
      minDiff = diff;
      closestFrame = frame;
    }
  }

  if (!closestFrame || !closestFrame.participantFrames) return 0;
  const pf = closestFrame.participantFrames[String(participantId)];
  return pf ? (pf.minionsKilled || 0) + (pf.jungleMinionsKilled || 0) : 0;
}

/**
 * 사망 컨텍스트 분류
 * 주변 이벤트를 분석하여 솔로/갱킹/팀파이트/다이브 구분
 */
function classifyDeathContext(deathEvent, allEvents, frames, participantId, matchDetail) {
  const deathTime = deathEvent.timestamp;
  const assistCount = (deathEvent.assistingParticipantIds || []).length;

  // 15초 내, 3000유닛 내 다른 킬 이벤트 수 확인
  const nearbyKills = allEvents.filter((e) => {
    if (e.type !== 'CHAMPION_KILL') return false;
    if (Math.abs(e.timestamp - deathTime) > 15000) return false;
    if (!e.position || !deathEvent.position) return true; // 위치 정보 없으면 시간만 기준
    const dist = Math.sqrt(
      Math.pow(e.position.x - deathEvent.position.x, 2) +
        Math.pow(e.position.y - deathEvent.position.y, 2)
    );
    return dist < 3000;
  });

  // 팀파이트: 15초 내 3+명 사망
  if (nearbyKills.length >= 3) return 'TEAMFIGHT_DEATH';

  // 다이브: 타워 범위 내 사망 (타워 좌표 기준 ~850유닛)
  const towerPositions = getTowerPositions(matchDetail, participantId);
  if (deathEvent.position) {
    for (const tower of towerPositions) {
      const dist = Math.sqrt(
        Math.pow(deathEvent.position.x - tower.x, 2) +
          Math.pow(deathEvent.position.y - tower.y, 2)
      );
      if (dist < 1000) return 'DIVE_DEATH';
    }
  }

  // 갱킹: 킬러가 다른 라인이고 1-2명만 관여
  const participants = matchDetail.info.participants;
  const target = participants.find((p) => p.participantId === participantId);
  const killer = participants.find((p) => p.participantId === deathEvent.killerId);

  if (
    killer &&
    target &&
    killer.teamPosition !== target.teamPosition &&
    killer.teamPosition !== '' &&
    assistCount <= 1
  ) {
    return 'GANK_DEATH';
  }

  // 솔로 데스: 어시스트 없이 1v1
  if (assistCount === 0) return 'SOLO_DEATH';

  return 'TEAMFIGHT_DEATH';
}

/**
 * 아군 타워 위치 반환 (간략화된 좌표)
 */
function getTowerPositions(matchDetail, participantId) {
  const target = matchDetail.info.participants.find(
    (p) => p.participantId === participantId
  );
  if (!target) return [];

  const isBlue = target.teamId === 100;

  // 소환사 협곡 주요 타워 위치 (간략화)
  if (isBlue) {
    return [
      { x: 981, y: 10441 },   // 탑 외곽
      { x: 1512, y: 6699 },   // 탑 내곽
      { x: 1169, y: 4287 },   // 탑 억제기
      { x: 5846, y: 6396 },   // 미드 외곽
      { x: 5048, y: 4812 },   // 미드 내곽
      { x: 3651, y: 3696 },   // 미드 억제기
      { x: 10504, y: 1029 },  // 봇 외곽
      { x: 6919, y: 1483 },   // 봇 내곽
      { x: 4281, y: 1253 },   // 봇 억제기
    ];
  } else {
    return [
      { x: 4318, y: 13875 },  // 탑 외곽
      { x: 7943, y: 13411 },  // 탑 내곽
      { x: 10481, y: 13650 }, // 탑 억제기
      { x: 8955, y: 8510 },   // 미드 외곽
      { x: 9767, y: 10113 },  // 미드 내곽
      { x: 11134, y: 11207 }, // 미드 억제기
      { x: 13866, y: 4505 },  // 봇 외곽
      { x: 13327, y: 8226 },  // 봇 내곽
      { x: 13624, y: 10572 }, // 봇 억제기
    ];
  }
}

/**
 * 리콜 타이밍 추정 (아이템 구매 이벤트 클러스터)
 */
function detectBackTimings(allEvents, participantId) {
  const itemPurchases = allEvents
    .filter(
      (e) =>
        e.type === 'ITEM_PURCHASED' &&
        e.participantId === participantId &&
        e.timestamp > 90000 // 게임 시작 후 1분 30초 이후
    )
    .map((e) => e.timestamp);

  if (itemPurchases.length === 0) return [];

  // 5초 내 연속 구매를 하나의 리콜로 묶음
  const backTimings = [];
  let clusterStart = itemPurchases[0];
  let lastTime = itemPurchases[0];

  for (let i = 1; i < itemPurchases.length; i++) {
    if (itemPurchases[i] - lastTime > 5000) {
      backTimings.push(clusterStart);
      clusterStart = itemPurchases[i];
    }
    lastTime = itemPurchases[i];
  }
  backTimings.push(clusterStart);

  return backTimings;
}

/**
 * 메인 파서: Match-v5 Timeline → 의사결정 리포트
 *
 * @param {Object} timeline - Riot Match-v5 Timeline API 응답
 * @param {Object} matchDetail - Riot Match-v5 Match Detail API 응답
 * @param {number} participantId - 대상 플레이어의 participantId (1~10)
 * @returns {Object} 구조화된 의사결정 데이터
 */
function parseMatchTimeline(timeline, matchDetail, participantId) {
  const frames = timeline.info.frames || [];
  const participant = matchDetail.info.participants.find(
    (p) => p.participantId === participantId
  );

  if (!participant) {
    throw new Error(`participantId ${participantId}를 찾을 수 없습니다.`);
  }

  const teamId = participant.teamId;
  const laneOpponentId = findLaneOpponent(matchDetail, participantId);
  const gameDuration = matchDetail.info.gameDuration;

  // 모든 이벤트 플랫 배열로
  const allEvents = frames.flatMap((f) => f.events || []);

  // ============================================
  // 1. 사망 분석
  // ============================================
  const deathEvents = allEvents.filter(
    (e) => e.type === 'CHAMPION_KILL' && e.victimId === participantId
  );

  const deathAnalysis = deathEvents.map((death) => {
    const minuteMark = death.timestamp / 60000;
    const oneMinBefore = death.timestamp - 60000;

    // 1분 전 골드 차이
    let goldDiffBeforeDeath = 0;
    if (laneOpponentId) {
      const myGold = getGoldAtTime(frames, participantId, oneMinBefore);
      const oppGold = getGoldAtTime(frames, laneOpponentId, oneMinBefore);
      goldDiffBeforeDeath = myGold - oppGold;
    }

    // 위치 분류
    const locationType = death.position
      ? classifyLocation(death.position.x, death.position.y, teamId)
      : 'UNKNOWN';

    // 사망 컨텍스트
    const deathContext = classifyDeathContext(
      death,
      allEvents,
      frames,
      participantId,
      matchDetail
    );

    return {
      timestamp: death.timestamp,
      minuteMark,
      goldDiffBeforeDeath,
      killerId: death.killerId,
      assistingIds: death.assistingParticipantIds || [],
      location: death.position || { x: 0, y: 0 },
      locationType,
      deathContext,
    };
  });

  // ============================================
  // 2. 오브젝트 참여
  // ============================================
  const teamObjectives = allEvents.filter(
    (e) =>
      (e.type === 'ELITE_MONSTER_KILL' || e.type === 'BUILDING_KILL') &&
      e.killerTeamId === teamId
  );

  const participatedObjectives = teamObjectives.filter(
    (e) =>
      e.killerId === participantId ||
      (e.assistingParticipantIds || []).includes(participantId)
  );

  const missedObjectives = teamObjectives
    .filter(
      (e) =>
        e.killerId !== participantId &&
        !(e.assistingParticipantIds || []).includes(participantId) &&
        e.type === 'ELITE_MONSTER_KILL' // 건물은 미참여가 자연스러울 수 있으므로 제외
    )
    .map((e) => ({
      type: e.monsterType || e.buildingType || 'UNKNOWN',
      timestamp: e.timestamp,
      minuteMark: e.timestamp / 60000,
    }));

  const totalObj = teamObjectives.length;
  const participationRate = totalObj > 0
    ? Math.round((participatedObjectives.length / totalObj) * 100)
    : 100;

  // ============================================
  // 3. 골드 효율
  // ============================================
  const goldAt10 = getGoldAtTime(frames, participantId, 600000);
  const goldAt15 = getGoldAtTime(frames, participantId, 900000);
  const csAt10 = getCsAtTime(frames, participantId, 600000);
  const csAt15 = getCsAtTime(frames, participantId, 900000);

  let goldDiffAt10 = 0;
  let goldDiffAt15 = 0;
  if (laneOpponentId) {
    goldDiffAt10 = goldAt10 - getGoldAtTime(frames, laneOpponentId, 600000);
    goldDiffAt15 = goldAt15 - getGoldAtTime(frames, laneOpponentId, 900000);
  }

  const backTimings = detectBackTimings(allEvents, participantId);

  // ============================================
  // 4. 시야 타임라인
  // ============================================
  const wardEvents = allEvents.filter(
    (e) => e.type === 'WARD_PLACED' && e.creatorId === participantId
  );
  const wardKillEvents = allEvents.filter(
    (e) => e.type === 'WARD_KILL' && e.killerId === participantId
  );

  const earlyWardsPlaced = wardEvents.filter((e) => e.timestamp < 900000).length;
  const lateWardsPlaced = wardEvents.filter((e) => e.timestamp >= 900000).length;

  // ============================================
  // 5. 전투 프로필
  // ============================================
  const teamKills = allEvents.filter(
    (e) => {
      if (e.type !== 'CHAMPION_KILL') return false;
      const killerParticipant = matchDetail.info.participants.find(
        (p) => p.participantId === e.killerId
      );
      return killerParticipant && killerParticipant.teamId === teamId;
    }
  ).length;

  const playerKillsAndAssists = participant.kills + participant.assists;
  const killParticipation =
    teamKills > 0 ? Math.round((playerKillsAndAssists / teamKills) * 100) : 0;

  const soloKills = allEvents.filter(
    (e) =>
      e.type === 'CHAMPION_KILL' &&
      e.killerId === participantId &&
      (e.assistingParticipantIds || []).length === 0
  ).length;

  return {
    playerInfo: {
      champion: participant.championName,
      role: participant.teamPosition || 'UNKNOWN',
      win: participant.win,
      kills: participant.kills,
      deaths: participant.deaths,
      assists: participant.assists,
      rank: '', // 호출자가 채워넣음
    },
    gameDuration,
    deathAnalysis,
    objectiveParticipation: {
      totalObjectives: totalObj,
      participated: participatedObjectives.length,
      participationRate,
      missedObjectives,
    },
    goldEfficiency: {
      goldAt10,
      goldAt15,
      goldDiffAt10,
      goldDiffAt15,
      csAt10,
      csAt15,
      backTimings,
    },
    visionTimeline: {
      wardsPlacedTotal: wardEvents.length,
      wardsKilledTotal: wardKillEvents.length,
      earlyWardsPlaced,
      lateWardsPlaced,
    },
    combatProfile: {
      damageDealt: participant.totalDamageDealtToChampions,
      damageTaken: participant.totalDamageTaken,
      healingDone: participant.totalHeal || 0,
      killParticipation,
      soloKills,
    },
  };
}

module.exports = { parseMatchTimeline };
