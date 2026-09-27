// ============================================
// 🔍 Match Parser — 타임라인 데스 이벤트 분석
// ============================================

const { normalizeStats } = require('./statNormalizer');

// 타임라인에서 데스 이벤트 분석
function analyzeDeathEvents(timeline, participantId) {
  const deathEvents = [];

  if (!timeline || !timeline.info || !timeline.info.frames) {
    return { early_death_count: 0, solo_death_count: 0, total_deaths: 0 };
  }

  for (const frame of timeline.info.frames) {
    for (const event of frame.events) {
      if (event.type === 'CHAMPION_KILL' && event.victimId === participantId) {
        deathEvents.push({
          time_min: Math.floor(event.timestamp / 60000),
          position: event.position,
          assistingParticipantIds: event.assistingParticipantIds || [],
        });
      }
    }
  }

  return {
    early_death_count: deathEvents.filter((d) => d.time_min < 10).length,
    solo_death_count: deathEvents.filter((d) => d.assistingParticipantIds.length === 0).length,
    total_deaths: deathEvents.length,
  };
}

// participantId를 puuid로부터 추출
function getParticipantId(matchDetail, puuid) {
  const participants = matchDetail.info.participants;
  const p = participants.find((pp) => pp.puuid === puuid);
  return p ? p.participantId : null;
}

// 매치 데이터 전처리 → Claude 전달용 구조체 생성
function parseMatch(matchDetail, timeline, puuid, tier) {
  const participant = matchDetail.info.participants.find((p) => p.puuid === puuid);
  if (!participant) throw new Error('참가자 데이터 없음');

  const gameDurationMin = matchDetail.info.gameDuration / 60;
  const rawStats = {
    cs_per_min:
      (participant.totalMinionsKilled + participant.neutralMinionsKilled) / gameDurationMin,
    kda:
      (participant.kills + participant.assists) / Math.max(participant.deaths, 1),
    vision_score: participant.visionScore,
    damage_dealt: participant.totalDamageDealtToChampions,
  };

  const champion = participant.championName;
  const role = participant.teamPosition || 'MIDDLE';
  const normalized = normalizeStats(rawStats, tier, champion, role);
  const participantId = getParticipantId(matchDetail, puuid);
  const deathPattern = analyzeDeathEvents(timeline, participantId);

  return {
    champion,
    role: participant.teamPosition,
    game_duration_min: Math.round(gameDurationMin),
    team_result: participant.win ? 'WIN' : 'LOSE',
    kills: participant.kills,
    deaths: participant.deaths,
    assists: participant.assists,
    raw: rawStats,
    relative: normalized,
    death_pattern: deathPattern,
  };
}

module.exports = { parseMatch, analyzeDeathEvents, getParticipantId };
