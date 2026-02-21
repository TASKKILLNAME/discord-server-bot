const {
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
  getAccountByRiotId,
  getRecentMatchIds,
  getMatchDetail,
  getSummonerByPuuid,
  getRankByPuuid,
  initStaticData,
  formatRank,
} = require('../services/riotService');
const { profilePlaystyle } = require('../services/playstyleProfiler');
const { analyzeMetaImpact, parseCoachingToFields } = require('../services/coachAnalyzer');
const { hasCredit, useCredit, getCredits } = require('../services/membershipService');

const PATCH_DATA_FILE = path.join(__dirname, '../../data/patch.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('메타')
    .setDescription('최근 50게임 기반 플레이스타일 진단 + 패치 적응 코칭')
    .addStringOption((opt) =>
      opt
        .setName('소환사명')
        .setDescription('게임 이름#태그 (예: Hide on bush#KR1)')
        .setRequired(true)
    ),

  async execute(interaction) {
    // 1. 입력 파싱
    const rawInput = interaction.options.getString('소환사명');
    const hashIndex = rawInput.lastIndexOf('#');

    if (hashIndex === -1 || hashIndex === 0 || hashIndex === rawInput.length - 1) {
      return interaction.reply({
        content: '❌ 올바른 형식으로 입력해주세요: `이름#태그` (예: Hide on bush#KR1)',
        ephemeral: true,
      });
    }

    const gameName = rawInput.substring(0, hashIndex).trim();
    const tagLine = rawInput.substring(hashIndex + 1).trim();

    // 2. 크레딧 체크 (2회 필요)
    const currentCredits = getCredits(interaction.guild.id, interaction.user.id);
    if (currentCredits < 2) {
      return interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 크레딧 부족')
            .setDescription(
              `메타 분석에는 크레딧 2회가 필요합니다. (잔여: ${currentCredits}회)\n\n` +
                '`/멤버십 구매`로 크레딧을 충전해주세요.'
            )
            .setColor(0xff0000),
        ],
        ephemeral: true,
      });
    }

    // 3. deferReply
    await interaction.deferReply();

    try {
      // 로딩 메시지
      const loadingEmbed = new EmbedBuilder()
        .setTitle('📊 메타 분석 중...')
        .setDescription(
          `**${gameName}#${tagLine}** 최근 50게임을 분석합니다.\n` +
            '50게임 수집 → 플레이스타일 프로파일링 → 패치 분석 → AI 코칭\n' +
            '잠시만 기다려주세요... (약 30~90초)\n\n' +
            `💳 잔여 크레딧: ${currentCredits}회 (2회 차감 예정)`
        )
        .setColor(0xf0b232);
      await interaction.editReply({ embeds: [loadingEmbed] });

      // 4. 정적 데이터 초기화
      await initStaticData();

      // 5. 계정 조회
      const account = await getAccountByRiotId(gameName, tagLine);

      // 6. 소환사 정보 + 랭크
      const summoner = await getSummonerByPuuid(account.puuid);
      const rankData = await getRankByPuuid(account.puuid);
      const rank = formatRank(rankData);

      // 7. 최근 50게임 매치 ID
      const matchIds = await getRecentMatchIds(account.puuid, 50);

      if (matchIds.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 전적을 찾을 수 없습니다')
              .setDescription('최근 게임 기록이 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      // 진행 상태 업데이트
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📊 매치 데이터 수집 중...')
            .setDescription(
              `${matchIds.length}개 게임의 상세 데이터를 수집합니다.\n` +
                'Riot API 속도 제한으로 시간이 소요될 수 있습니다...'
            )
            .setColor(0xffa500),
        ],
      });

      // 8. 매치 상세 일괄 조회 (순차적 — 레이트 리밋 큐가 처리)
      const matchDetails = [];
      for (const matchId of matchIds) {
        try {
          const detail = await getMatchDetail(matchId);
          if (detail) matchDetails.push(detail);
        } catch (err) {
          console.error(`매치 조회 실패 (${matchId}):`, err.message);
        }
      }

      if (matchDetails.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 매치 데이터 조회 실패')
              .setDescription('매치 상세 정보를 가져올 수 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      // 9. 플레이스타일 프로파일링
      const playstyleProfile = profilePlaystyle(
        matchDetails,
        account.puuid,
        rank,
        `${account.gameName}#${account.tagLine}`
      );

      // 10. 패치 데이터 로드
      let patchData = { champions: [], items: [], systemChanges: [] };
      try {
        if (fs.existsSync(PATCH_DATA_FILE)) {
          patchData = JSON.parse(fs.readFileSync(PATCH_DATA_FILE, 'utf-8'));
        }
      } catch (err) {
        console.error('patch.json 로드 실패:', err.message);
      }

      // 11. AI 메타 분석
      const metaAnalysis = await analyzeMetaImpact(playstyleProfile, patchData);
      const analysisFields = parseCoachingToFields(metaAnalysis);

      // 12. 크레딧 차감 (2회)
      useCredit(interaction.guild.id, interaction.user.id, '메타 분석 (1/2)');
      useCredit(interaction.guild.id, interaction.user.id, '메타 분석 (2/2)');

      // 13. 결과 전송
      // 프로필 Embed
      const profileEmbed = new EmbedBuilder()
        .setTitle(`📊 ${gameName}#${tagLine} — 메타 코칭`)
        .addFields(
          { name: '🏆 랭크', value: rank, inline: true },
          {
            name: '📈 최근 전적',
            value: `${playstyleProfile.totalGames}게임 | ${playstyleProfile.winRate}% 승률`,
            inline: true,
          },
          { name: '📊 평균 KDA', value: playstyleProfile.avgKDA, inline: true }
        )
        .setColor(0x5865f2)
        .setTimestamp();

      // 플레이스타일 Embed
      const styleEmbed = new EmbedBuilder()
        .setTitle('🎮 플레이스타일 프로필')
        .addFields(
          {
            name: '⚔️ 공격성',
            value: `${'█'.repeat(playstyleProfile.aggression)}${'░'.repeat(10 - playstyleProfile.aggression)} ${playstyleProfile.aggression}/10`,
            inline: true,
          },
          {
            name: '🗺️ 로밍',
            value: `${'█'.repeat(playstyleProfile.roaming)}${'░'.repeat(10 - playstyleProfile.roaming)} ${playstyleProfile.roaming}/10`,
            inline: true,
          },
          {
            name: '👁️ 시야',
            value: `${'█'.repeat(playstyleProfile.visionScore)}${'░'.repeat(10 - playstyleProfile.visionScore)} ${playstyleProfile.visionScore}/10`,
            inline: true,
          },
          {
            name: '🌾 CS',
            value: `${'█'.repeat(playstyleProfile.csSkill)}${'░'.repeat(10 - playstyleProfile.csSkill)} ${playstyleProfile.csSkill}/10`,
            inline: true,
          },
          {
            name: '🏰 후반',
            value: `${'█'.repeat(playstyleProfile.lateGameSkill)}${'░'.repeat(10 - playstyleProfile.lateGameSkill)} ${playstyleProfile.lateGameSkill}/10`,
            inline: true,
          },
          { name: '\u200b', value: '\u200b', inline: true } // 정렬용 빈 필드
        )
        .setColor(0xf0b232);

      // 챔피언 풀 Embed
      const champEmbed = new EmbedBuilder()
        .setTitle('🏆 주력 챔피언 TOP 3')
        .setColor(0x1a78ae);

      if (playstyleProfile.championPool.length > 0) {
        const champDesc = playstyleProfile.championPool
          .map(
            (c, i) =>
              `**${i + 1}. ${c.champion}** — ${c.games}판 ${c.winRate}% 승률 | KDA ${c.avgKDA} | CS ${c.avgCs}/분`
          )
          .join('\n\n');
        champEmbed.setDescription(champDesc);
      } else {
        champEmbed.setDescription('충분한 데이터가 없습니다.');
      }

      // 포지션 분포
      const roleStr = Object.entries(playstyleProfile.roleDistribution)
        .filter(([, v]) => v > 0)
        .sort(([, a], [, b]) => b - a)
        .map(([role, pct]) => `${translateRole(role)}: ${pct}%`)
        .join(' | ');
      if (roleStr) {
        champEmbed.addFields({ name: '📍 포지션 분포', value: roleStr });
      }

      // AI 분석 Embed
      const analysisEmbed = new EmbedBuilder()
        .setTitle('🤖 AI 메타 코칭')
        .setColor(0xf0b232)
        .setFooter({
          text: `AI 코치 분석 | 패치: ${patchData.version || '데이터 없음'} | 실제 결과와 다를 수 있습니다`,
        })
        .setTimestamp();

      for (const f of analysisFields.slice(0, 25)) {
        analysisEmbed.addFields(f);
      }

      await interaction.editReply({
        embeds: [profileEmbed, styleEmbed, champEmbed, analysisEmbed],
      });
    } catch (err) {
      console.error('메타 분석 오류:', err);
      const errorDetail = err.userMessage || err.message || '알 수 없는 오류';
      const statusCode = err.response?.status ? ` (HTTP ${err.response.status})` : '';
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('❌ 오류 발생')
            .setDescription(`${errorDetail}${statusCode}`)
            .setColor(0xff0000),
        ],
      });
    }
  },
};

function translateRole(role) {
  const map = {
    TOP: '탑',
    JUNGLE: '정글',
    MIDDLE: '미드',
    BOTTOM: '원딜',
    UTILITY: '서포터',
  };
  return map[role] || role;
}
