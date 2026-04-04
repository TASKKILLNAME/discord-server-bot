const {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  SeparatorBuilder,
  ThumbnailBuilder,
  SeparatorSpacingSize,
  MessageFlags,
} = require('discord.js');

// 챔피언 이미지 URL
const DDRAGON_VERSION = '14.24.1';
function championIconUrl(championName) {
  return `https://ddragon.leagueoflegends.com/cdn/${DDRAGON_VERSION}/img/champion/${championName}.png`;
}

// 랭크 → 색상 매핑
const RANK_COLORS = {
  IRON: 0x6b5b4f,
  BRONZE: 0xcd7f32,
  SILVER: 0xc0c0c0,
  GOLD: 0xffd700,
  PLATINUM: 0x00cba9,
  EMERALD: 0x50c878,
  DIAMOND: 0xb9f2ff,
  MASTER: 0x9b59b6,
  GRANDMASTER: 0xe74c3c,
  CHALLENGER: 0xf1c40f,
};

function getRankColor(rankString) {
  if (!rankString) return 0x5865f2;
  const tier = rankString.split(' ')[0]?.toUpperCase();
  return RANK_COLORS[tier] || 0x5865f2;
}

// KDA 등급 텍스트
function kdaGrade(kda) {
  const val = parseFloat(kda);
  if (val >= 6) return '**S+**';
  if (val >= 4) return '**S**';
  if (val >= 3) return '**A**';
  if (val >= 2) return 'B';
  if (val >= 1) return 'C';
  return 'D';
}

/**
 * 최근 전적 결과를 Components V2 레이아웃으로 생성
 */
function buildRecentMatchLayout(matchData, analysisFields, options = {}) {
  const { gameName, tagLine, rank, summonerLevel, matches } = matchData;
  const wins = matches.filter(m => m.win).length;
  const losses = matches.length - wins;
  const winRate = Math.round((wins / matches.length) * 100);
  const label = options.label || '';

  // ── Container 1: 프로필 요약 ──
  const profileContainer = new ContainerBuilder()
    .setAccentColor(getRankColor(rank));

  profileContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 📊 ${gameName}#${tagLine}${label}`
    ),
  );

  profileContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  profileContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        `🏆 **${rank}**　　📈 레벨 **${summonerLevel}**`,
        `📊 최근 **${matches.length}**게임　**${wins}**승 **${losses}**패 (**${winRate}%**)`,
      ].join('\n')
    ),
  );

  // ── Container 2: 매치 히스토리 ──
  const matchContainer = new ContainerBuilder()
    .setAccentColor(0x1a78ae);

  matchContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 📋 매치 히스토리'),
  );

  matchContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  // 매치별 라인 (텍스트 기반, 보기 좋게 정리)
  const matchLines = matches.map(m => {
    const result = m.win ? '🟢 승리' : '🔴 패배';
    const grade = kdaGrade(m.kda);
    return [
      `${result}　**${m.champion}**`,
      `┗ ${m.kills}/${m.deaths}/${m.assists} (${grade} ${m.kda})　CS ${m.cs} (${m.csPerMin}/분)　⏱ ${m.duration}`,
    ].join('\n');
  });

  // 5개씩 끊어서 TextDisplay 추가 (한 컴포넌트당 글자 수 제한)
  const chunkSize = 5;
  for (let i = 0; i < matchLines.length; i += chunkSize) {
    const chunk = matchLines.slice(i, i + chunkSize).join('\n\n');
    matchContainer.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(chunk),
    );
  }

  // ── Container 3: AI 분석 ──
  const analysisContainer = new ContainerBuilder()
    .setAccentColor(0xf0b232);

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🤖 AI 분석'),
  );

  analysisContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  if (analysisFields && analysisFields.length > 0) {
    const analysisText = analysisFields
      .slice(0, 15)
      .map(f => `**${f.name}**\n${f.value}`)
      .join('\n\n');

    // 4096자 제한 대응 - 분할
    const maxLen = 3900;
    if (analysisText.length <= maxLen) {
      analysisContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(analysisText),
      );
    } else {
      // 필드별로 나눠서 추가
      let buffer = '';
      for (const f of analysisFields.slice(0, 15)) {
        const entry = `**${f.name}**\n${f.value}\n\n`;
        if (buffer.length + entry.length > maxLen) {
          analysisContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(buffer.trim()),
          );
          buffer = entry;
        } else {
          buffer += entry;
        }
      }
      if (buffer.trim()) {
        analysisContainer.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(buffer.trim()),
        );
      }
    }
  }

  analysisContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# AI 분석 | 실제 결과와 다를 수 있습니다'
    ),
  );

  return {
    components: [profileContainer, matchContainer, analysisContainer],
    flags: MessageFlags.IsComponentsV2,
  };
}

/**
 * 실시간 게임 결과를 Components V2 레이아웃으로 생성
 */
function buildLiveGameLayout(gameData, analysisFields, gameName, tagLine) {
  // ── Container 1: 게임 정보 ──
  const headerContainer = new ContainerBuilder()
    .setAccentColor(0x1a78ae);

  headerContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 🎮 ${gameName}#${tagLine} 실시간 게임\n🎯 **${gameData.gameMode}**`
    ),
  );

  // ── Container 2: 블루팀 ──
  const blueContainer = new ContainerBuilder()
    .setAccentColor(0x4287f5);

  blueContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🔵 블루팀'),
  );

  blueContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  const blueText = gameData.blueTeam
    .map(p => `**${p.championName}** | ${p.rank}\n┗ ${p.spell1} / ${p.spell2}`)
    .join('\n\n');

  blueContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(blueText.substring(0, 4000)),
  );

  // ── Container 3: 레드팀 ──
  const redContainer = new ContainerBuilder()
    .setAccentColor(0xed4245);

  redContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🔴 레드팀'),
  );

  redContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  const redText = gameData.redTeam
    .map(p => `**${p.championName}** | ${p.rank}\n┗ ${p.spell1} / ${p.spell2}`)
    .join('\n\n');

  redContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(redText.substring(0, 4000)),
  );

  // ── Container 4: AI 분석 ──
  const analysisContainer = new ContainerBuilder()
    .setAccentColor(0xf0b232);

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🤖 AI 분석'),
  );

  analysisContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  if (analysisFields && analysisFields.length > 0) {
    const analysisText = analysisFields
      .slice(0, 15)
      .map(f => `**${f.name}**\n${f.value}`)
      .join('\n\n');

    const maxLen = 3900;
    if (analysisText.length <= maxLen) {
      analysisContainer.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(analysisText),
      );
    } else {
      let buffer = '';
      for (const f of analysisFields.slice(0, 15)) {
        const entry = `**${f.name}**\n${f.value}\n\n`;
        if (buffer.length + entry.length > maxLen) {
          analysisContainer.addTextDisplayComponents(
            new TextDisplayBuilder().setContent(buffer.trim()),
          );
          buffer = entry;
        } else {
          buffer += entry;
        }
      }
      if (buffer.trim()) {
        analysisContainer.addTextDisplayComponents(
          new TextDisplayBuilder().setContent(buffer.trim()),
        );
      }
    }
  }

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# AI 분석 | 실제 결과와 다를 수 있습니다'
    ),
  );

  return {
    components: [headerContainer, blueContainer, redContainer, analysisContainer],
    flags: MessageFlags.IsComponentsV2,
  };
}

/**
 * 단일 매치 (실시간 → 최근 1게임 대체) Components V2
 */
function buildSingleMatchLayout(matchData, analysisFields, gameName, tagLine) {
  const m = matchData.matches[0];

  const container = new ContainerBuilder()
    .setAccentColor(m.win ? 0x57f287 : 0xed4245);

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      `## 📊 ${gameName}#${tagLine} — 최근 게임`
    ),
  );

  container.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      [
        `🏆 **${matchData.rank}**　　📈 레벨 **${matchData.summonerLevel}**`,
        '',
        `${m.win ? '🟢 **승리**' : '🔴 **패배**'}　**${m.champion}**`,
        `┗ ${m.kills}/${m.deaths}/${m.assists} (KDA ${m.kda})　CS ${m.cs}　⏱ ${m.duration}`,
      ].join('\n')
    ),
  );

  // AI 분석
  const analysisContainer = new ContainerBuilder()
    .setAccentColor(0xf0b232);

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent('## 🤖 AI 분석'),
  );

  analysisContainer.addSeparatorComponents(
    new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
  );

  if (analysisFields && analysisFields.length > 0) {
    const text = analysisFields
      .slice(0, 15)
      .map(f => `**${f.name}**\n${f.value}`)
      .join('\n\n');

    analysisContainer.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(text.substring(0, 3900)),
    );
  }

  analysisContainer.addTextDisplayComponents(
    new TextDisplayBuilder().setContent(
      '-# AI 분석 | 실제 결과와 다를 수 있습니다'
    ),
  );

  return {
    components: [container, analysisContainer],
    flags: MessageFlags.IsComponentsV2,
  };
}

module.exports = {
  buildRecentMatchLayout,
  buildLiveGameLayout,
  buildSingleMatchLayout,
};
