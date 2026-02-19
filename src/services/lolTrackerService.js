const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const {
  getAccountByRiotId,
  getLiveGame,
  fetchLiveGameData,
} = require('./riotService');
const { analyzeLiveGame, parseAnalysisToFields } = require('./lolAnalyzer');

const DATA_FILE = path.join(__dirname, '../../data/lolTracker.json');

let scheduledTask = null;

// ============================================
// 📁 데이터 관리
// ============================================
function loadTrackerData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error('롤 트래커 데이터 로드 오류:', err);
  }
  return {};
}

function saveTrackerData(data) {
  try {
    const dir = path.dirname(DATA_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('롤 트래커 데이터 저장 오류:', err);
  }
}

// ============================================
// 👤 플레이어 등록/해제
// ============================================
async function registerPlayer(guildId, discordUserId, gameName, tagLine) {
  // Riot API로 계정 확인 (PUUID 조회)
  const account = await getAccountByRiotId(gameName, tagLine);

  const data = loadTrackerData();
  if (!data[guildId]) {
    data[guildId] = { channelId: null, players: {} };
  }

  data[guildId].players[discordUserId] = {
    gameName: account.gameName || gameName,
    tagLine: account.tagLine || tagLine,
    puuid: account.puuid,
    inGame: false,
    lastGameId: null,
    registeredAt: new Date().toISOString(),
  };

  saveTrackerData(data);
  return account;
}

function unregisterPlayer(guildId, discordUserId) {
  const data = loadTrackerData();
  if (data[guildId]?.players?.[discordUserId]) {
    delete data[guildId].players[discordUserId];
    saveTrackerData(data);
    return true;
  }
  return false;
}

function setTrackerChannel(guildId, channelId) {
  const data = loadTrackerData();
  if (!data[guildId]) {
    data[guildId] = { channelId: null, players: {} };
  }
  data[guildId].channelId = channelId;
  saveTrackerData(data);
}

function getRegisteredPlayers(guildId) {
  const data = loadTrackerData();
  return data[guildId]?.players || {};
}

function getTrackerChannel(guildId) {
  const data = loadTrackerData();
  return data[guildId]?.channelId || null;
}

// ============================================
// 🔄 자동 게임 감지 스케줄러
// ============================================
function startLolTracker(client) {
  if (!process.env.RIOT_API_KEY) {
    console.log('⚠️ RIOT_API_KEY가 설정되지 않았습니다. 롤 트래커가 비활성화됩니다.');
    return;
  }

  console.log('🎮 롤 게임 자동 감지 트래커 시작 (2분 간격)');

  // 2분마다 체크
  scheduledTask = cron.schedule('*/2 * * * *', async () => {
    await checkAllPlayers(client);
  });
}

async function checkAllPlayers(client) {
  const data = loadTrackerData();
  let changed = false;

  for (const [guildId, guildData] of Object.entries(data)) {
    if (!guildData.channelId || !guildData.players) continue;

    const channel = client.channels.cache.get(guildData.channelId);
    if (!channel) continue;

    for (const [discordUserId, player] of Object.entries(guildData.players)) {
      try {
        const liveGame = await getLiveGame(player.puuid);

        if (liveGame && !player.inGame) {
          // 🎮 게임 시작 감지!
          console.log(`🎮 게임 감지: ${player.gameName}#${player.tagLine} (${guildId})`);

          player.inGame = true;
          player.lastGameId = liveGame.gameId;
          changed = true;

          // 비동기로 분석 후 알림 (메인 루프 블로킹 방지)
          sendGameNotification(client, channel, player, discordUserId).catch((err) => {
            console.error(`게임 알림 전송 실패 (${player.gameName}):`, err.message);
          });
        } else if (!liveGame && player.inGame) {
          // 게임 종료
          player.inGame = false;
          changed = true;
        }
      } catch (err) {
        // API 오류는 조용히 무시 (다음 주기에 재시도)
        if (err.response?.status !== 403) {
          console.error(`트래커 체크 실패 (${player.gameName}):`, err.message);
        }
      }
    }
  }

  if (changed) {
    saveTrackerData(data);
  }
}

// ============================================
// 📢 게임 감지 알림 전송
// ============================================
async function sendGameNotification(client, channel, player, discordUserId) {
  try {
    // 로딩 메시지
    const loadingEmbed = new EmbedBuilder()
      .setTitle('🎮 게임 감지!')
      .setDescription(
        `<@${discordUserId}> (**${player.gameName}#${player.tagLine}**)님이 게임을 시작했습니다!\nAI가 분석 중입니다...`
      )
      .setColor(0xffa500)
      .setTimestamp();

    const loadingMsg = await channel.send({ embeds: [loadingEmbed] });

    // 실시간 게임 데이터 조회 + AI 분석
    const gameData = await fetchLiveGameData(player.gameName, player.tagLine);

    if (gameData.notInGame) {
      await loadingMsg.edit({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎮 게임 정보')
            .setDescription(`${player.gameName}#${player.tagLine}님의 게임이 이미 종료되었거나 조회할 수 없습니다.`)
            .setColor(0x808080),
        ],
      });
      return;
    }

    const analysis = await analyzeLiveGame(gameData);
    const analysisFields = parseAnalysisToFields(analysis);

    // 블루팀 정보
    const blueDesc = gameData.blueTeam
      .map((p) => `**${p.championName}** | ${p.rank}\n${p.spell1} / ${p.spell2}`)
      .join('\n\n');

    // 레드팀 정보
    const redDesc = gameData.redTeam
      .map((p) => `**${p.championName}** | ${p.rank}\n${p.spell1} / ${p.spell2}`)
      .join('\n\n');

    // 임베드 배열 생성
    const embeds = [];

    // 게임 개요
    embeds.push(
      new EmbedBuilder()
        .setTitle(`🎮 ${player.gameName}#${player.tagLine}님의 실시간 게임`)
        .setDescription(`<@${discordUserId}>님이 게임을 시작했습니다!`)
        .addFields({ name: '🎯 게임 모드', value: gameData.gameMode, inline: true })
        .setColor(0x1a78ae)
        .setTimestamp()
    );

    // 블루팀
    embeds.push(
      new EmbedBuilder()
        .setTitle('🔵 블루팀')
        .setDescription(blueDesc.length > 4096 ? blueDesc.substring(0, 4093) + '...' : blueDesc)
        .setColor(0x4287f5)
    );

    // 레드팀
    embeds.push(
      new EmbedBuilder()
        .setTitle('🔴 레드팀')
        .setDescription(redDesc.length > 4096 ? redDesc.substring(0, 4093) + '...' : redDesc)
        .setColor(0xed4245)
    );

    // AI 분석
    const analysisEmbed = new EmbedBuilder()
      .setTitle('🤖 AI 분석')
      .setColor(0xf0b232)
      .setFooter({ text: 'AI 분석 | 실제 결과와 다를 수 있습니다' })
      .setTimestamp();

    for (const field of analysisFields.slice(0, 25)) {
      analysisEmbed.addFields(field);
    }
    embeds.push(analysisEmbed);

    // 로딩 메시지를 삭제하고 새 메시지 전송
    await loadingMsg.delete().catch(() => {});
    await channel.send({ embeds });
  } catch (err) {
    console.error('게임 알림 전송 실패:', err.message);
  }
}

function stopLolTracker() {
  if (scheduledTask) {
    scheduledTask.stop();
    console.log('⏹️ 롤 트래커 중지됨');
  }
}

module.exports = {
  loadTrackerData,
  saveTrackerData,
  registerPlayer,
  unregisterPlayer,
  setTrackerChannel,
  getRegisteredPlayers,
  getTrackerChannel,
  startLolTracker,
  stopLolTracker,
};
