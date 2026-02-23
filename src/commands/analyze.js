const {
  SlashCommandBuilder,
  EmbedBuilder,
  AttachmentBuilder,
} = require('discord.js');
const {
  getAccountByRiotId,
  getRecentMatchIds,
  getMatchDetail,
  getMatchTimeline,
  getRankByPuuid,
  formatRank,
} = require('../services/riotService');
const { parseMatch } = require('../utils/matchParser');
const { getMatchAnalysis, parseAnalysisToFields } = require('../services/claudeService');
const { generateReportImage } = require('../services/imageService');
const { CURRENT_PATCH } = require('../constants/patchData');
const fs = require('fs');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('분석')
    .setDescription('최근 게임을 AI가 분석합니다')
    .addStringOption((opt) =>
      opt
        .setName('소환사명')
        .setDescription('소환사명#태그 형식 (예: Hide on bush#KR1)')
        .setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt
        .setName('게임수')
        .setDescription('분석할 게임 수 (기본: 1, 최대: 3)')
        .setMinValue(1)
        .setMaxValue(3)
        .setRequired(false),
    ),

  async execute(interaction) {
    await interaction.deferReply();

    try {
      const input = interaction.options.getString('소환사명');
      const count = interaction.options.getInteger('게임수') || 1;
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
            .setTitle('🧠 AI 코치 분석 중...')
            .setDescription(
              `**${gameName}#${tagLine}** 최근 ${count}게임 분석 중\n` +
                '데이터 수집 → 티어 보정 → AI 코칭 → 이미지 생성\n' +
                '잠시만 기다려주세요... (약 20~50초)',
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

      // 2. 최근 게임 가져오기
      const matchIds = await getRecentMatchIds(account.puuid, count);

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

      // 3. 각 매치를 순회하며 분석
      const results = [];
      const totalCount = matchIds.length;

      for (let i = 0; i < matchIds.length; i++) {
        const matchId = matchIds[i];

        try {
          // 진행 상태 업데이트 (2게임 이상일 때)
          if (totalCount > 1) {
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setTitle('🧠 AI 코치 분석 중...')
                  .setDescription(
                    `**${gameName}#${tagLine}** [${i + 1}/${totalCount}] 게임 분석 중\n` +
                      '데이터 수집 → 티어 보정 → AI 코칭 → 이미지 생성\n' +
                      '잠시만 기다려주세요...',
                  )
                  .setColor(0xf0b232),
              ],
            });
          }

          // 매치 디테일 + 타임라인 병렬 호출
          const [detail, timeline] = await Promise.all([
            getMatchDetail(matchId),
            getMatchTimeline(matchId),
          ]);

          if (!detail || !timeline) {
            console.error(`매치 데이터 조회 실패 (${matchId})`);
            continue;
          }

          // 매치 파싱 (티어 보정 + 챔피언 플래그 적용)
          const parsed = parseMatch(detail, timeline, account.puuid, tier);

          // AI 코칭 분석
          const analysisText = await getMatchAnalysis(parsed, tier);

          // 이미지 생성
          let imagePath = null;
          try {
            imagePath = await generateReportImage(analysisText, {
              summoner: gameName,
              champion: parsed.champion,
              tier,
              team_result: parsed.team_result,
              raw: parsed.raw,
              kills: parsed.kills,
              deaths: parsed.deaths,
              assists: parsed.assists,
              patch: CURRENT_PATCH,
            });
          } catch (renderErr) {
            console.error(`이미지 렌더링 실패 (${i + 1}번째 게임), 텍스트 폴백:`, renderErr.message);
          }

          results.push({ parsed, analysisText, imagePath, index: i });
        } catch (err) {
          console.error(`매치 분석 실패 (${matchId}):`, err.message);
        }
      }

      // 분석 결과가 하나도 없는 경우
      if (results.length === 0) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 데이터 조회 실패')
              .setDescription('매치 데이터를 분석할 수 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      // 4. Discord 전송
      const tierDisplay = soloRank
        ? `${soloRank.tier} ${soloRank.rank} ${soloRank.leaguePoints}LP`
        : '언랭';

      const embeds = [];
      const files = [];
      const imagePaths = [];

      for (let i = 0; i < results.length; i++) {
        const { parsed, analysisText, imagePath } = results[i];
        const gameLabel = results.length > 1 ? `[${i + 1}/${results.length}] ` : '';

        if (imagePath) {
          const fileName = `analysis_${i + 1}.png`;
          files.push(new AttachmentBuilder(imagePath, { name: fileName }));
          imagePaths.push(imagePath);

          const embed = new EmbedBuilder()
            .setColor(parsed.team_result === 'WIN' ? 0x2ecc71 : 0xe74c3c)
            .setTitle(`🧠 ${gameLabel}${gameName} | ${parsed.champion} | ${parsed.team_result}`)
            .setDescription('AI 분석 결과를 이미지로 확인하세요')
            .addFields(
              { name: '티어', value: tierDisplay, inline: true },
              { name: 'KDA', value: parsed.raw.kda.toFixed(2), inline: true },
              { name: 'CS/분', value: parsed.raw.cs_per_min.toFixed(1), inline: true },
            )
            .setImage(`attachment://${fileName}`)
            .setFooter({ text: `패치 ${CURRENT_PATCH} | AI 분석은 참고용입니다` })
            .setTimestamp();

          embeds.push(embed);
        } else {
          // 텍스트 폴백
          const fields = parseAnalysisToFields(analysisText);

          const embed = new EmbedBuilder()
            .setColor(parsed.team_result === 'WIN' ? 0x2ecc71 : 0xe74c3c)
            .setTitle(`🧠 ${gameLabel}${gameName} | ${parsed.champion} | ${parsed.team_result}`)
            .setDescription(`${tierDisplay} | KDA ${parsed.raw.kda.toFixed(2)} | CS ${parsed.raw.cs_per_min.toFixed(1)}/분`)
            .setFooter({ text: `패치 ${CURRENT_PATCH} | AI 분석은 참고용입니다` })
            .setTimestamp();

          for (const f of fields.slice(0, 25)) {
            embed.addFields(f);
          }

          embeds.push(embed);
        }
      }

      await interaction.editReply({ embeds, files });

      // 임시 파일 정리
      for (const p of imagePaths) {
        try {
          fs.unlinkSync(p);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (err) {
      console.error('분석 명령어 오류:', err);
      const msg =
        err.response?.status === 404
          ? '❌ 소환사를 찾을 수 없습니다'
          : `❌ 분석 중 오류가 발생했습니다: ${err.userMessage || err.message || '알 수 없는 오류'}`;
      await interaction.editReply(msg);
    }
  },
};
