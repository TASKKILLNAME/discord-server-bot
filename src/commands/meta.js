const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getAccountByRiotId,
  getRecentMatchIds,
  getMatchDetail,
  getRankByPuuid,
  formatRank,
} = require('../services/riotService');
const { analyzeChampionPool } = require('../utils/statNormalizer');
const { getMetaCoaching, parseAnalysisToFields } = require('../services/claudeService');
const { CHANGES, CURRENT_PATCH } = require('../constants/patchData');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('메타')
    .setDescription('최근 50판 기반 개인화 메타 코칭')
    .addStringOption((opt) =>
      opt
        .setName('소환사명')
        .setDescription('소환사명#태그 형식 (예: Hide on bush#KR1)')
        .setRequired(true),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const input = interaction.options.getString('소환사명');
      const hashIndex = input.lastIndexOf('#');

      if (hashIndex === -1 || hashIndex === 0 || hashIndex === input.length - 1) {
        return interaction.editReply({
          content: '❌ 소환사명#태그 형식으로 입력해주세요 (예: Hide on bush#KR1)',
        });
      }

      const gameName = input.substring(0, hashIndex).trim();
      const tagLine = input.substring(hashIndex + 1).trim();

      // 로딩 메시지
      await interaction.editReply({
        embeds: [
          new EmbedBuilder()
            .setTitle('📊 메타 분석 중...')
            .setDescription(
              `**${gameName}#${tagLine}** 최근 50게임 분석 중\n` +
                '데이터 수집 → 챔피언 풀 분석 → 티어 보정 → AI 코칭\n' +
                '잠시만 기다려주세요... (약 30~90초)',
            )
            .setColor(0xf0b232),
        ],
      });

      // 1. 소환사 정보 조회
      const account = await getAccountByRiotId(gameName, tagLine);
      const rankData = await getRankByPuuid(account.puuid);
      const soloRank = rankData.find((r) => r.queueType === 'RANKED_SOLO_5x5');
      const tier = soloRank?.tier?.toLowerCase() || 'gold';
      const rankStr = formatRank(rankData);

      // 2. 최근 50판 수집
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
                'Riot API 속도 제한으로 시간이 소요될 수 있습니다...',
            )
            .setColor(0xffa500),
        ],
      });

      // 3. 챔피언별 집계
      const champStats = {};
      let totalGames = 0;
      let totalWins = 0;
      let totalKills = 0;
      let totalDeaths = 0;
      let totalAssists = 0;

      for (const matchId of matchIds) {
        try {
          const detail = await getMatchDetail(matchId);
          if (!detail) continue;

          const p = detail.info.participants.find((x) => x.puuid === account.puuid);
          if (!p) continue;

          totalGames++;
          if (p.win) totalWins++;
          totalKills += p.kills;
          totalDeaths += p.deaths;
          totalAssists += p.assists;

          const name = p.championName;
          if (!champStats[name]) {
            champStats[name] = {
              games: 0,
              wins: 0,
              kills: 0,
              deaths: 0,
              assists: 0,
              cs: 0,
              duration: 0,
              roles: {},
            };
          }
          const s = champStats[name];
          s.games++;
          if (p.win) s.wins++;
          s.kills += p.kills;
          s.deaths += p.deaths;
          s.assists += p.assists;
          s.cs += p.totalMinionsKilled + p.neutralMinionsKilled;
          s.duration += detail.info.gameDuration / 60;
          const role = p.teamPosition || 'UNKNOWN';
          s.roles[role] = (s.roles[role] || 0) + 1;
        } catch (err) {
          console.error(`매치 조회 실패 (${matchId}):`, err.message);
        }
      }

      if (totalGames === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 매치 데이터 조회 실패')
              .setDescription('매치 상세 정보를 가져올 수 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      // 4. 모스트 3 추출
      const top3 = Object.entries(champStats)
        .sort((a, b) => b[1].games - a[1].games)
        .slice(0, 3)
        .map(([name, s]) => {
          // 가장 많이 플레이한 포지션 추출
          const primaryRole = Object.entries(s.roles)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || 'MIDDLE';
          return {
            name,
            games: s.games,
            winrate: s.wins / s.games,
            avg_kda: (s.kills + s.assists) / Math.max(s.deaths, 1),
            avg_cs: s.cs / s.duration,
            role: primaryRole,
          };
        });

      // 5. 플레이 성향 계산
      const playStyle = {
        top_champions: top3,
        analyzed_games: totalGames,
      };

      // 6. 모스트 챔피언 관련 패치 변경사항만 필터
      const topChampNames = top3.map((c) => c.name);
      const filteredChanges = CHANGES.filter((c) => topChampNames.includes(c.champion));

      // 7. 티어 보정 적용
      const normalizedPool = analyzeChampionPool(top3, tier);
      playStyle.top_champions = normalizedPool;

      // 8. AI 메타 코칭
      const coachingText = await getMetaCoaching(playStyle, filteredChanges, tier);
      const analysisFields = parseAnalysisToFields(coachingText);

      // 9. 종합 KDA
      const avgKDA =
        totalDeaths === 0
          ? 'Perfect'
          : ((totalKills + totalAssists) / totalDeaths).toFixed(2);
      const winRate = Math.round((totalWins / totalGames) * 100);

      // 10. 결과 전송
      // 프로필 Embed
      const profileEmbed = new EmbedBuilder()
        .setTitle(`📊 ${gameName}#${tagLine} — 메타 코칭`)
        .addFields(
          { name: '🏆 랭크', value: rankStr, inline: true },
          {
            name: '📈 최근 전적',
            value: `${totalGames}게임 | ${winRate}% 승률`,
            inline: true,
          },
          { name: '📊 평균 KDA', value: String(avgKDA), inline: true },
        )
        .setColor(0x5865f2)
        .setTimestamp();

      // 챔피언 풀 Embed
      const champEmbed = new EmbedBuilder()
        .setTitle('🏆 주력 챔피언 TOP 3')
        .setColor(0x1a78ae);

      if (normalizedPool.length > 0) {
        const champDesc = normalizedPool
          .map((c, i) => {
            const wr = Math.round(c.winrate * 100);
            const csLabel =
              c.flags.is_roam ? `CS ${c.avg_cs.toFixed(1)}/분 (로밍형)` : `CS ${c.avg_cs.toFixed(1)}/분`;
            const kdaLabel =
              c.flags.is_dive ? `KDA ${c.avg_kda.toFixed(2)} (다이브형)` : `KDA ${c.avg_kda.toFixed(2)}`;
            const csTag =
              c.cs_vs_avg >= 1 ? ' ✅' : c.cs_vs_avg <= -1 ? ' ⚠️' : '';
            const kdaTag =
              c.kda_vs_avg >= 1 ? ' ✅' : c.kda_vs_avg <= -1 ? ' ⚠️' : '';

            return `**${i + 1}. ${c.name}** — ${c.games}판 ${wr}% 승률\n${kdaLabel}${kdaTag} | ${csLabel}${csTag}`;
          })
          .join('\n\n');
        champEmbed.setDescription(champDesc);
      } else {
        champEmbed.setDescription('충분한 데이터가 없습니다.');
      }

      // AI 분석 Embed
      const analysisEmbed = new EmbedBuilder()
        .setTitle('🤖 AI 메타 코칭')
        .setColor(0xf0b232)
        .setFooter({
          text: `패치 ${CURRENT_PATCH} | AI 분석은 참고용입니다`,
        })
        .setTimestamp();

      for (const f of analysisFields.slice(0, 25)) {
        analysisEmbed.addFields(f);
      }

      await interaction.editReply({
        embeds: [profileEmbed, champEmbed, analysisEmbed],
      });
    } catch (err) {
      console.error('메타 분석 오류:', err);
      const msg =
        err.response?.status === 404
          ? '❌ 소환사를 찾을 수 없습니다'
          : `❌ 분석 중 오류가 발생했습니다: ${err.userMessage || err.message || '알 수 없는 오류'}`;
      await interaction.editReply(msg);
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
