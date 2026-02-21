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
  initStaticData,
  formatRank,
  getRankByPuuid,
} = require('../services/riotService');
const { parseMatchTimeline } = require('../services/matchParser');
const { analyzeDecisions, parseCoachingToFields } = require('../services/coachAnalyzer');
const { renderAnalysisReport } = require('../services/reportRenderer');
module.exports = {
  data: new SlashCommandBuilder()
    .setName('분석')
    .setDescription('최근 게임의 의사결정을 AI 코치가 심층 분석합니다 (이미지 리포트)')
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

    // 2. deferReply
    await interaction.deferReply();

    try {
      // 로딩 메시지
      const loadingEmbed = new EmbedBuilder()
        .setTitle('🧠 AI 코치 분석 중...')
        .setDescription(
          `**${gameName}#${tagLine}** 최근 게임의 의사결정을 분석합니다.\n` +
            '타임라인 데이터 수집 → 의사결정 분해 → AI 코칭 → 이미지 생성\n' +
            '잠시만 기다려주세요... (약 20~50초)'
        )
        .setColor(0xf0b232);
      await interaction.editReply({ embeds: [loadingEmbed] });

      // 4. 정적 데이터 초기화
      await initStaticData();

      // 5. 계정 조회
      const account = await getAccountByRiotId(gameName, tagLine);

      // 6. 최근 매치 ID 조회 (1게임)
      const matchIds = await getRecentMatchIds(account.puuid, 1);

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

      // 7. 매치 디테일 + 타임라인 병렬 호출
      const [matchDetail, timeline] = await Promise.all([
        getMatchDetail(matchIds[0]),
        getMatchTimeline(matchIds[0]),
      ]);

      if (!matchDetail || !timeline) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 데이터 조회 실패')
              .setDescription(
                '매치 데이터 또는 타임라인을 가져올 수 없습니다.\n' +
                  '일부 게임 모드(ARAM, 사용자 설정 등)는 타임라인을 지원하지 않을 수 있습니다.'
              )
              .setColor(0xff0000),
          ],
        });
      }

      // 8. participantId 찾기
      const participant = matchDetail.info.participants.find(
        (p) => p.puuid === account.puuid
      );

      if (!participant) {
        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('❌ 참가자 데이터 없음')
              .setDescription('매치에서 해당 플레이어를 찾을 수 없습니다.')
              .setColor(0xff0000),
          ],
        });
      }

      // 9. 랭크 조회
      const rankData = await getRankByPuuid(account.puuid);
      const rank = formatRank(rankData);

      // 10. 타임라인 파싱
      const decisionData = parseMatchTimeline(
        timeline,
        matchDetail,
        participant.participantId
      );
      decisionData.playerInfo.rank = rank;

      // 11. AI 코칭 분석
      const coachFeedback = await analyzeDecisions(decisionData);

      // 12. 이미지 렌더링
      let imageBuffer;
      try {
        imageBuffer = await renderAnalysisReport(decisionData, coachFeedback, {
          gameName: account.gameName,
          tagLine: account.tagLine,
          rank,
          champion: decisionData.playerInfo.champion,
          win: decisionData.playerInfo.win,
        });
      } catch (renderErr) {
        console.error('이미지 렌더링 실패, 텍스트 폴백:', renderErr.message);
        // 이미지 실패 시 텍스트 Embed 폴백
        imageBuffer = null;
      }

      // 13. 결과 전송
      if (imageBuffer) {
        const attachment = new AttachmentBuilder(imageBuffer, {
          name: 'analysis-report.png',
        });

        const resultEmbed = new EmbedBuilder()
          .setTitle(`🧠 AI 코치 분석 — ${gameName}#${tagLine}`)
          .setDescription(
            `**${decisionData.playerInfo.champion}** (${decisionData.playerInfo.win ? '✅ 승리' : '❌ 패배'}) | ` +
              `${decisionData.playerInfo.kills}/${decisionData.playerInfo.deaths}/${decisionData.playerInfo.assists} | ` +
              `${rank}`
          )
          .setImage('attachment://analysis-report.png')
          .setColor(decisionData.playerInfo.win ? 0x57f287 : 0xed4245)
          .setFooter({ text: 'AI 코치 분석 | 실제 결과와 다를 수 있습니다' })
          .setTimestamp();

        await interaction.editReply({
          embeds: [resultEmbed],
          files: [attachment],
        });
      } else {
        // 텍스트 폴백
        const fields = parseCoachingToFields(coachFeedback);

        const resultEmbed = new EmbedBuilder()
          .setTitle(`🧠 AI 코치 분석 — ${gameName}#${tagLine}`)
          .setDescription(
            `**${decisionData.playerInfo.champion}** (${decisionData.playerInfo.win ? '✅ 승리' : '❌ 패배'}) | ` +
              `${decisionData.playerInfo.kills}/${decisionData.playerInfo.deaths}/${decisionData.playerInfo.assists} | ` +
              `${rank}`
          )
          .setColor(decisionData.playerInfo.win ? 0x57f287 : 0xed4245)
          .setTimestamp();

        const analysisEmbed = new EmbedBuilder()
          .setTitle('🤖 AI 코치 피드백')
          .setColor(0xf0b232)
          .setFooter({ text: 'AI 코치 분석 | 이미지 생성 실패로 텍스트 표시' })
          .setTimestamp();

        for (const f of fields.slice(0, 25)) {
          analysisEmbed.addFields(f);
        }

        await interaction.editReply({ embeds: [resultEmbed, analysisEmbed] });
      }
    } catch (err) {
      console.error('분석 명령어 오류:', err);
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
