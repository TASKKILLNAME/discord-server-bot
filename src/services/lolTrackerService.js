const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

const TRACKER_ROLE_NAME = '🎮 LOL 트래커';
const {
  getAccountByRiotId,
  getLiveGame,
  getRankByPuuid,
  formatRank,
  fetchLiveGameData,
} = require('./riotService');
const { analyzeLiveGame, parseAnalysisToFields } = require('./lolAnalyzer');
const { hasCredit, useCredit, getCredits } = require('./membershipService');

// 티어 순서 (낮은 → 높은)
const TIER_ORDER = [
  'IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM',
  'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER',
];
const RANK_ORDER = ['IV', 'III', 'II', 'I'];

const TIER_KO = {
  IRON: '아이언', BRONZE: '브론즈', SILVER: '실버', GOLD: '골드',
  PLATINUM: '플래티넘', EMERALD: '에메랄드', DIAMOND: '다이아몬드',
  MASTER: '마스터', GRANDMASTER: '그랜드마스터', CHALLENGER: '챌린저',
};

const TIER_EMOJI = {
  IRON: '⬛', BRONZE: '🟫', SILVER: '⬜', GOLD: '🟨',
  PLATINUM: '💎', EMERALD: '💚', DIAMOND: '💠',
  MASTER: '🟣', GRANDMASTER: '🔴', CHALLENGER: '👑',
};

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

  // 현재 랭크 저장 (랭크 변동 감지용)
  let currentRank = null;
  try {
    const rankEntries = await getRankByPuuid(account.puuid);
    const solo = rankEntries.find((r) => r.queueType === 'RANKED_SOLO_5x5');
    if (solo) {
      currentRank = { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses };
    }
  } catch (err) {
    // 랭크 조회 실패 시 null
  }

  data[guildId].players[discordUserId] = {
    gameName: account.gameName || gameName,
    tagLine: account.tagLine || tagLine,
    puuid: account.puuid,
    inGame: false,
    lastGameId: null,
    lastRank: currentRank,
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

// ============================================
// 🔒 전용 역할 + 채널 권한 관리
// ============================================

/**
 * LOL 트래커 전용 역할을 가져오거나 생성
 */
async function ensureTrackerRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === TRACKER_ROLE_NAME);
  if (!role) {
    try {
      role = await guild.roles.create({
        name: TRACKER_ROLE_NAME,
        color: 0x1a78ae,
        reason: 'LOL 트래커 전용 역할 자동 생성',
      });
      console.log(`🔒 ${guild.name}: "${TRACKER_ROLE_NAME}" 역할 생성 완료`);
    } catch (err) {
      console.error(`역할 생성 실패 (${guild.name}):`, err.message);
      return null;
    }
  }
  return role;
}

/**
 * 채널에 트래커 역할만 볼 수 있도록 권한 설정
 */
async function setChannelPermissions(channel, role) {
  try {
    // @everyone 읽기 차단, 트래커 역할만 허용
    await channel.permissionOverwrites.set([
      {
        id: channel.guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: role.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.ReadMessageHistory],
      },
      {
        id: channel.guild.members.me.id,
        allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.EmbedLinks],
      },
    ]);
    console.log(`🔒 ${channel.guild.name}: #${channel.name} 채널 권한 설정 완료`);
  } catch (err) {
    console.error(`채널 권한 설정 실패:`, err.message);
  }
}

/**
 * 멤버에게 트래커 역할 부여
 */
async function addTrackerRole(guild, discordUserId) {
  try {
    const role = await ensureTrackerRole(guild);
    if (!role) return;
    const member = await guild.members.fetch(discordUserId);
    if (member && !member.roles.cache.has(role.id)) {
      await member.roles.add(role);
      console.log(`✅ ${guild.name}: ${member.user.tag}에게 트래커 역할 부여`);
    }
  } catch (err) {
    console.error(`트래커 역할 부여 실패:`, err.message);
  }
}

/**
 * 멤버에서 트래커 역할 제거
 */
async function removeTrackerRole(guild, discordUserId) {
  try {
    const role = guild.roles.cache.find((r) => r.name === TRACKER_ROLE_NAME);
    if (!role) return;
    const member = await guild.members.fetch(discordUserId);
    if (member && member.roles.cache.has(role.id)) {
      await member.roles.remove(role);
      console.log(`🗑️ ${guild.name}: ${member.user.tag}에서 트래커 역할 제거`);
    }
  } catch (err) {
    console.error(`트래커 역할 제거 실패:`, err.message);
  }
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
          // 게임 종료 → 랭크 변동 체크
          player.inGame = false;
          changed = true;

          // 게임 종료 후 랭크 체크 (10초 뒤, API 반영 대기)
          setTimeout(async () => {
            try {
              await checkRankChange(channel, player, discordUserId);
              saveTrackerData(loadTrackerData()); // 변경사항 저장
            } catch (err) {
              console.error(`랭크 체크 실패 (${player.gameName}):`, err.message);
            }
          }, 10000);
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
    const guildId = channel.guild.id;

    // 크레딧 보유 체크 (차감은 AI 분석 성공 후)
    if (!hasCredit(guildId, discordUserId)) {
      const remaining = getCredits(guildId, discordUserId);
      const noCreditsEmbed = new EmbedBuilder()
        .setTitle('🎮 게임 감지!')
        .setDescription(
          `<@${discordUserId}> (**${player.gameName}#${player.tagLine}**)님이 게임을 시작했습니다!\n\n` +
            `⚠️ AI 분석 크레딧이 부족합니다. (잔여: ${remaining}회)\n` +
            '`/멤버십 구매`로 크레딧을 충전해주세요.'
        )
        .setColor(0x808080)
        .setTimestamp();
      await channel.send({ embeds: [noCreditsEmbed] });
      return;
    }

    // 로딩 메시지
    const credits = getCredits(guildId, discordUserId);
    const loadingEmbed = new EmbedBuilder()
      .setTitle('🎮 게임 감지!')
      .setDescription(
        `<@${discordUserId}> (**${player.gameName}#${player.tagLine}**)님이 게임을 시작했습니다!\nAI가 분석 중입니다... (💳 잔여: ${credits}회)`
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

    // ✅ AI 분석 성공 → 크레딧 차감
    useCredit(guildId, discordUserId, '자동 게임 감지');

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

// ============================================
// 🏆 랭크 변동 감지
// ============================================

/**
 * 랭크 변동 체크: 이전 랭크와 비교하여 승급/강등 알림
 */
async function checkRankChange(channel, player, discordUserId) {
  const rankEntries = await getRankByPuuid(player.puuid);
  const solo = rankEntries.find((r) => r.queueType === 'RANKED_SOLO_5x5');

  if (!solo) return;

  const newRank = { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses };
  const oldRank = player.lastRank;

  // 이전 랭크가 없으면 (첫 기록) 저장만
  if (!oldRank) {
    player.lastRank = newRank;
    return;
  }

  // 같으면 스킵
  if (oldRank.tier === newRank.tier && oldRank.rank === newRank.rank) {
    player.lastRank = newRank; // LP 등 업데이트
    return;
  }

  const comparison = compareTiers(oldRank, newRank);

  if (comparison > 0) {
    // 🎉 승급!
    await sendPromotionNotification(channel, player, discordUserId, oldRank, newRank);
  } else if (comparison < 0) {
    // 📉 강등
    await sendDemotionNotification(channel, player, discordUserId, oldRank, newRank);
  }

  // 랭크 업데이트
  player.lastRank = newRank;
}

/**
 * 티어 비교: 양수 = 승급, 음수 = 강등, 0 = 동일
 */
function compareTiers(oldRank, newRank) {
  const oldTierIdx = TIER_ORDER.indexOf(oldRank.tier);
  const newTierIdx = TIER_ORDER.indexOf(newRank.tier);

  if (newTierIdx !== oldTierIdx) {
    return newTierIdx - oldTierIdx;
  }

  // 같은 티어 내 디비전 비교
  const oldRankIdx = RANK_ORDER.indexOf(oldRank.rank);
  const newRankIdx = RANK_ORDER.indexOf(newRank.rank);
  return newRankIdx - oldRankIdx;
}

/**
 * 🎉 승급 알림 전송
 */
async function sendPromotionNotification(channel, player, discordUserId, oldRank, newRank) {
  const oldTierIdx = TIER_ORDER.indexOf(oldRank.tier);
  const newTierIdx = TIER_ORDER.indexOf(newRank.tier);
  const isTierUp = newTierIdx > oldTierIdx;

  const oldDisplay = `${TIER_KO[oldRank.tier] || oldRank.tier} ${oldRank.rank}`;
  const newDisplay = `${TIER_KO[newRank.tier] || newRank.tier} ${newRank.rank}`;
  const emoji = TIER_EMOJI[newRank.tier] || '🎉';

  // 마스터 이상 특별 축하
  const isHighElo = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(newRank.tier);

  let title, description, color;

  if (isHighElo && isTierUp) {
    // 🏆 마스터/그마/챌 진입 특별 메시지
    const specialMessages = {
      MASTER: '마스터 티어 달성! 상위 0.5%의 실력자입니다!',
      GRANDMASTER: '그랜드마스터 진입! 진정한 고수의 영역입니다!',
      CHALLENGER: '챌린저 달성!! 최강자의 반열에 올랐습니다!!!',
    };

    title = `👑🎆 ${player.gameName}님 ${TIER_KO[newRank.tier]} 승격!! 🎆👑`;
    description =
      `<@${discordUserId}>\n\n` +
      `${emoji} **${specialMessages[newRank.tier]}**\n\n` +
      `**${oldDisplay}** → **${newDisplay}** ${newRank.lp}LP\n` +
      `전적: ${newRank.wins}승 ${newRank.losses}패 (${Math.round((newRank.wins / (newRank.wins + newRank.losses)) * 100)}%)\n\n` +
      '🎊🎊🎊 축하합니다!! 🎊🎊🎊';
    color = newRank.tier === 'CHALLENGER' ? 0xffd700 : newRank.tier === 'GRANDMASTER' ? 0xff4444 : 0x9b59b6;
  } else if (isTierUp) {
    // 🎉 일반 티어 승급
    title = `🎉 ${player.gameName}님 ${TIER_KO[newRank.tier]} 승급!`;
    description =
      `<@${discordUserId}>\n\n` +
      `${emoji} **${oldDisplay}** → **${newDisplay}** ${newRank.lp}LP\n` +
      `전적: ${newRank.wins}승 ${newRank.losses}패 (${Math.round((newRank.wins / (newRank.wins + newRank.losses)) * 100)}%)\n\n` +
      '🎉 축하합니다!';
    color = 0x57f287;
  } else {
    // 📈 디비전 승급
    title = `📈 ${player.gameName}님 승급!`;
    description =
      `<@${discordUserId}>\n\n` +
      `${emoji} **${oldDisplay}** → **${newDisplay}** ${newRank.lp}LP\n` +
      `전적: ${newRank.wins}승 ${newRank.losses}패 (${Math.round((newRank.wins / (newRank.wins + newRank.losses)) * 100)}%)`;
    color = 0x3498db;
  }

  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

/**
 * 📉 강등 알림 전송
 */
async function sendDemotionNotification(channel, player, discordUserId, oldRank, newRank) {
  const oldDisplay = `${TIER_KO[oldRank.tier] || oldRank.tier} ${oldRank.rank}`;
  const newDisplay = `${TIER_KO[newRank.tier] || newRank.tier} ${newRank.rank}`;

  const embed = new EmbedBuilder()
    .setTitle(`📉 ${player.gameName}님 강등...`)
    .setDescription(
      `<@${discordUserId}>\n\n` +
      `**${oldDisplay}** → **${newDisplay}** ${newRank.lp}LP\n` +
      `전적: ${newRank.wins}승 ${newRank.losses}패 (${Math.round((newRank.wins / (newRank.wins + newRank.losses)) * 100)}%)\n\n` +
      '💪 다시 올라갈 수 있습니다! 힘내세요!'
    )
    .setColor(0x95a5a6)
    .setTimestamp();

  await channel.send({ embeds: [embed] });
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
  ensureTrackerRole,
  setChannelPermissions,
  addTrackerRole,
  removeTrackerRole,
};
