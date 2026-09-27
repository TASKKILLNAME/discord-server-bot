'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeStats,
  analyzeChampionPool,
  sanitizeForPrompt,
  calcRelative,
} = require('../src/utils/statNormalizer');
const {
  parseMatch,
  analyzeDeathEvents,
  getParticipantId,
} = require('../src/utils/matchParser');
const { createProgressEmbed } = require('../src/utils/serverSetup');
const { calculateLevel, xpForLevel, xpForNextLevel } = require('../src/services/levelService');
const { formatRank } = require('../src/services/riotService');
const { parseAnalysisToFields: parseClaudeFields } = require('../src/services/claudeService');
const { parseAnalysisToFields: parseLolFields } = require('../src/services/lolAnalyzer');
const { parseTeams } = require('../src/services/chzzkService');
const templates = require('../src/templates/serverTemplates');

test('상대 점수는 경계값에 따라 -2부터 2까지 계산된다', () => {
  assert.deepEqual(
    [50, 70, 84, 100, 115, 149, 150].map((actual) => calcRelative(actual, 100)),
    [-2, -1, -1, 0, 1, 1, 2]
  );
  assert.equal(calcRelative(100, 0), 0);
});

test('스탯 정규화는 티어, 역할, 챔피언 보정을 함께 적용한다', () => {
  const result = normalizeStats(
    { cs_per_min: 5, kda: 2, vision_score: 25 },
    'gold',
    'Ivern',
    'JUNGLE'
  );

  assert.equal(result.adjusted_avg.cs_per_min, 3.2);
  assert.equal(result.adjusted_avg.kda, 2.1);
  assert.equal(result.context_flags.is_roam, true);
  assert.equal(result.cs_score, 2);
});

test('알 수 없는 티어는 gold 기준으로 처리된다', () => {
  const result = normalizeStats(
    { cs_per_min: 7.2, kda: 2.1, vision_score: 21 },
    'unknown',
    'UnknownChampion',
    'MIDDLE'
  );
  assert.deepEqual(
    { cs: result.cs_score, kda: result.kda_score, vision: result.vision_score },
    { cs: 0, kda: 0, vision: 0 }
  );
});

test('고 elo 프롬프트 정리는 평균 이상 지표를 숨기고 입력을 변경하지 않는다', () => {
  const input = { relative: { cs: 1, kda: 0, deaths: -1 } };
  const result = sanitizeForPrompt(input, 'master');

  assert.deepEqual(result.relative, {
    cs: 'ABOVE_AVG_SKIP',
    kda: 'ABOVE_AVG_SKIP',
    deaths: -1,
  });
  assert.deepEqual(input.relative, { cs: 1, kda: 0, deaths: -1 });
});

test('챔피언 풀 분석은 원본 항목과 상대 지표를 결합한다', () => {
  const [result] = analyzeChampionPool(
    [{ name: 'Ahri', role: 'MIDDLE', avg_cs: 7.2, avg_kda: 2.1 }],
    'gold'
  );
  assert.equal(result.name, 'Ahri');
  assert.equal(result.cs_vs_avg, 0);
  assert.equal(result.flags.is_roam, true);
});

test('타임라인이 없으면 데스 통계는 0이다', () => {
  assert.deepEqual(analyzeDeathEvents(null, 1), {
    early_death_count: 0,
    solo_death_count: 0,
    total_deaths: 0,
  });
});

test('데스 이벤트는 10분 전과 단독 처치를 구분한다', () => {
  const timeline = {
    info: {
      frames: [
        { events: [{ type: 'CHAMPION_KILL', victimId: 3, timestamp: 9 * 60000 }] },
        {
          events: [{
            type: 'CHAMPION_KILL',
            victimId: 3,
            timestamp: 12 * 60000,
            assistingParticipantIds: [4],
          }],
        },
      ],
    },
  };
  assert.deepEqual(analyzeDeathEvents(timeline, 3), {
    early_death_count: 1,
    solo_death_count: 1,
    total_deaths: 2,
  });
});

test('puuid로 participantId를 찾는다', () => {
  const match = { info: { participants: [{ puuid: 'a', participantId: 7 }] } };
  assert.equal(getParticipantId(match, 'a'), 7);
  assert.equal(getParticipantId(match, 'missing'), null);
});

test('매치 파서는 KDA, CS, 승패와 데스 패턴을 만든다', () => {
  const participant = {
    puuid: 'p1', participantId: 1, championName: 'Ahri', teamPosition: 'MIDDLE',
    totalMinionsKilled: 180, neutralMinionsKilled: 0, kills: 5, deaths: 0,
    assists: 7, visionScore: 21, totalDamageDealtToChampions: 20000, win: true,
  };
  const match = { info: { gameDuration: 1800, participants: [participant] } };
  const result = parseMatch(match, null, 'p1', 'gold');

  assert.equal(result.raw.cs_per_min, 6);
  assert.equal(result.raw.kda, 12);
  assert.equal(result.team_result, 'WIN');
  assert.equal(result.game_duration_min, 30);
  assert.equal(result.death_pattern.total_deaths, 0);
});

test('매치에 대상 참가자가 없으면 명확히 실패한다', () => {
  assert.throws(
    () => parseMatch({ info: { gameDuration: 60, participants: [] } }, null, 'p1', 'gold'),
    /참가자 데이터 없음/
  );
});

test('레벨 XP 계산식이 서로 일관된다', () => {
  assert.equal(xpForLevel(5), 2500);
  assert.equal(calculateLevel(xpForLevel(5)), 5);
  assert.equal(xpForNextLevel(5), xpForLevel(6));
});

test('Riot 랭크 포맷은 솔로 랭크와 승률을 표시한다', () => {
  assert.equal(formatRank([]), '언랭크');
  assert.equal(
    formatRank([{ queueType: 'RANKED_SOLO_5x5', tier: 'GOLD', rank: 'II', leaguePoints: 33, wins: 6, losses: 4 }]),
    '골드 II 33LP (60% / 10판)'
  );
});

test('Claude 분석 필드 파서는 한 줄 헤더 내용과 장문 제한을 처리한다', () => {
  const fields = parseClaudeFields(`**[성향 분석]** 공격적입니다.\n**[개선점]**\n${'가'.repeat(1100)}`);
  assert.equal(fields[0].name, '성향 분석');
  assert.equal(fields[0].value, '공격적입니다.');
  assert.equal(fields[1].value.length, 1024);
  assert.ok(fields[1].value.endsWith('...'));
});

test('LoL 분석 필드 파서는 ## 섹션을 Discord field로 변환한다', () => {
  assert.deepEqual(parseLolFields('## 종합\n좋음\n\n## 개선\n시야 확보'), [
    { name: '종합', value: '좋음' },
    { name: '개선', value: '시야 확보' },
  ]);
});

test('LCK 방송 제목에서 양 팀을 추출한다', () => {
  assert.deepEqual(parseTeams('2026 LCK 스프링 || T1 vs Gen.G'), ['T1', 'Gen.G']);
  assert.deepEqual(parseTeams('[LIVE] T1 VS. 한화생명 | LCK'), ['T1', '한화생명']);
  assert.equal(parseTeams('일반 방송'), null);
});

test('진행 임베드는 색상과 footer를 구성한다', () => {
  const result = createProgressEmbed('제목', '내용', '#ff00aa');
  assert.equal(result.embeds[0].title, '제목');
  assert.equal(result.embeds[0].color, 0xff00aa);
  assert.equal(result.embeds[0].footer.text, '🤖 Server Manager Bot');
});

test('서버 템플릿 5종은 역할·카테고리·채널 기본 구조를 갖는다', () => {
  assert.deepEqual(Object.keys(templates).sort(), ['business', 'community', 'gaming', 'project', 'study']);
  for (const [key, template] of Object.entries(templates)) {
    assert.ok(template.name, `${key}: name`);
    assert.ok(template.roles.length > 0, `${key}: roles`);
    assert.ok(template.categories.length > 0, `${key}: categories`);
    for (const category of template.categories) {
      assert.ok(category.name, `${key}: category name`);
      assert.ok(Array.isArray(category.channels), `${key}: category channels`);
    }
  }
});
