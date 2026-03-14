const cron = require('node-cron');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { pool } = require('../db');

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

let scheduledTask = null;

// ============================================
// 📁 DB 데이터 관리
// ============================================
async function getTrackerChannel(guildId) {
  const { rows } = await pool.query(
    'SELECT channel_id FROM lol_tracker_settings WHERE guild_id = $1',
    [guildId]
  );
  return rows[0]?.channel_id || null;
}

async function setTrackerChannel(guildId, channelId) {
  await pool.query(
    `INSERT INTO lol_tracker_settings (guild_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (guild_id) DO UPDATE SET channel_id = $2`,
    [guildId, channelId]
  );
}

async function getRegisteredPlayers(guildId) {
  const { rows } = await pool.query(
    'SELECT * FROM lol_tracker_players WHERE guild_id = $1',
    [guildId]
  );
  const players = {};
  for (const row of rows) {
    players[row.user_id] = {
      gameName: row.game_name,
      tagLine: row.tag_line,
      puuid: row.puuid,
      inGame: row.in_game,
      lastGameId: row.last_game_id,
      lastRank: row.last_rank,
      registeredAt: row.registered_at,
    };
  }
  return players;
}

async function getPlayer(guildId, userId) {
  const { rows } = await pool.query(
    'SELECT * FROM lol_tracker_players WHERE guild_id = $1 AND user_id = $2',
    [guildId, userId]
  );
  if (!rows[0]) return null;
  const row = rows[0];
  return {
    gameName: row.game_name,
    tagLine: row.tag_line,
    puuid: row.puuid,
    inGame: row.in_game,
    lastGameId: row.last_game_id,
    lastRank: row.last_rank,
    registeredAt: row.registered_at,
  };
}

async function updatePlayerState(guildId, userId, updates) {
  const sets = [];
  const vals = [guildId, userId];
  let idx = 3;
  if (updates.inGame !== undefined) {
    sets.push(`in_game = $${idx++}`);
    vals.push(updates.inGame);
  }
  if (updates.lastGameId !== undefined) {
    sets.push(`last_game_id = $${idx++}`);
    vals.push(updates.lastGameId);
  }
  if (updates.lastRank !== undefined) {
    sets.push(`last_rank = $${idx++}`);
    vals.push(JSON.stringify(updates.lastRank));
  }
  if (sets.length === 0) return;
  await pool.query(
    `UPDATE lol_tracker_players SET ${sets.join(', ')} WHERE guild_id = $1 AND user_id = $2`,
    vals
  );
}

// ============================================
// 👤 플레이어 등록/해제
// ============================================
async function registerPlayer(guildId, discordUserId, gameName, tagLine) {
  const account = await getAccountByRiotId(gameName, tagLine);

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

  await pool.query(
    `INSERT INTO lol_tracker_players (guild_id, user_id, game_name, tag_line, puuid, in_game, last_game_id, last_rank)
     VALUES ($1, $2, $3, $4, $5, false, NULL, $6)
     ON CONFLICT (guild_id, user_id) DO UPDATE
     SET game_name = $3, tag_line = $4, puuid = $5, last_rank = $6`,
    [guildId, discordUserId, account.gameName || gameName, account.tagLine || tagLine, account.puuid, JSON.stringify(currentRank)]
  );

  return account;
}

async function unregisterPlayer(guildId, discordUserId) {
  const { rowCount } = await pool.query(
    'DELETE FROM lol_tracker_players WHERE guild_id = $1 AND user_id = $2',
    [guildId, discordUserId]
  );
  return rowCount > 0;
}

// ============================================
// 🔒 전용 역할 + 채널 권한 관리
// ============================================
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

async function setChannelPermissions(channel, role) {
  try {
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

// ============================================
// 🔄 자동 게임 감지 스케줄러
// ============================================
function startLolTracker(client) {
  if (!process.env.RIOT_API_KEY) {
    console.log('⚠️ RIOT_API_KEY가 설정되지 않았습니다. 롤 트래커가 비활성화됩니다.');
    return;
  }

  console.log('🎮 롤 게임 자동 감지 트래커 시작 (2분 간격)');

  scheduledTask = cron.schedule('*/2 * * * *', async () => {
    await checkAllPlayers(client);
  });
}

async function checkAllPlayers(client) {
  let guilds;
  try {
    const { rows } = await pool.query('SELECT guild_id, channel_id FROM lol_tracker_settings');
    guilds = rows;
  } catch (err) {
    console.error('트래커 설정 로드 실패:', err.message);
    return;
  }

  for (const guildRow of guilds) {
    const { guild_id: guildId, channel_id: channelId } = guildRow;
    if (!channelId) continue;

    const channel = client.channels.cache.get(channelId);
    if (!channel) continue;

    let players;
    try {
      const { rows } = await pool.query(
        'SELECT * FROM lol_tracker_players WHERE guild_id = $1',
        [guildId]
      );
      players = rows;
    } catch (err) {
      console.error(`플레이어 로드 실패 (${guildId}):`, err.message);
      continue;
    }

    for (const row of players) {
      const player = {
        gameName: row.game_name,
        tagLine: row.tag_line,
        puuid: row.puuid,
        inGame: row.in_game,
        lastGameId: row.last_game_id,
        lastRank: row.last_rank,
      };

      try {
        const liveGame = await getLiveGame(player.puuid);

        if (liveGame && !player.inGame) {
          console.log(`🎮 게임 감지: ${player.gameName}#${player.tagLine} (${guildId})`);

          await updatePlayerState(guildId, row.user_id, {
            inGame: true,
            lastGameId: liveGame.gameId,
          });

          sendGameNotification(client, channel, player, row.user_id).catch((err) => {
            console.error(`게임 알림 전송 실패 (${player.gameName}):`, err.message);
          });
        } else if (!liveGame && player.inGame) {
          await updatePlayerState(guildId, row.user_id, { inGame: false });

          setTimeout(async () => {
            try {
              await checkRankChange(channel, player, row.user_id, guildId);
            } catch (err) {
              console.error(`랭크 체크 실패 (${player.gameName}):`, err.message);
            }
          }, 10000);
        }
      } catch (err) {
        if (err.response?.status !== 403) {
          console.error(`트래커 체크 실패 (${player.gameName}):`, err.message);
        }
      }
    }
  }
}

// ============================================
// 📢 게임 감지 알림 전송
// ============================================
async function sendGameNotification(client, channel, player, discordUserId) {
  try {
    const guildId = channel.guild.id;

    if (!(await hasCredit(guildId, discordUserId))) {
      const remaining = await getCredits(guildId, discordUserId);
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

    const credits = await getCredits(guildId, discordUserId);
    const loadingEmbed = new EmbedBuilder()
      .setTitle('🎮 게임 감지!')
      .setDescription(
        `<@${discordUserId}> (**${player.gameName}#${player.tagLine}**)님이 게임을 시작했습니다!\nAI가 분석 중입니다... (💳 잔여: ${credits}회)`
      )
      .setColor(0xffa500)
      .setTimestamp();

    const loadingMsg = await channel.send({ embeds: [loadingEmbed] });

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

    await useCredit(guildId, discordUserId, '자동 게임 감지');

    const blueDesc = gameData.blueTeam
      .map((p) => `**${p.championName}** | ${p.rank}\n${p.spell1} / ${p.spell2}`)
      .join('\n\n');

    const redDesc = gameData.redTeam
      .map((p) => `**${p.championName}** | ${p.rank}\n${p.spell1} / ${p.spell2}`)
      .join('\n\n');

    const embeds = [];

    embeds.push(
      new EmbedBuilder()
        .setTitle(`🎮 ${player.gameName}#${player.tagLine}님의 실시간 게임`)
        .setDescription(`<@${discordUserId}>님이 게임을 시작했습니다!`)
        .addFields({ name: '🎯 게임 모드', value: gameData.gameMode, inline: true })
        .setColor(0x1a78ae)
        .setTimestamp()
    );

    embeds.push(
      new EmbedBuilder()
        .setTitle('🔵 블루팀')
        .setDescription(blueDesc.length > 4096 ? blueDesc.substring(0, 4093) + '...' : blueDesc)
        .setColor(0x4287f5)
    );

    embeds.push(
      new EmbedBuilder()
        .setTitle('🔴 레드팀')
        .setDescription(redDesc.length > 4096 ? redDesc.substring(0, 4093) + '...' : redDesc)
        .setColor(0xed4245)
    );

    const analysisEmbed = new EmbedBuilder()
      .setTitle('🤖 AI 분석')
      .setColor(0xf0b232)
      .setFooter({ text: 'AI 분석 | 실제 결과와 다를 수 있습니다' })
      .setTimestamp();

    for (const field of analysisFields.slice(0, 25)) {
      analysisEmbed.addFields(field);
    }
    embeds.push(analysisEmbed);

    await loadingMsg.delete().catch(() => {});
    await channel.send({ embeds });
  } catch (err) {
    console.error('게임 알림 전송 실패:', err.message);
  }
}

// ============================================
// 🏆 랭크 변동 감지
// ============================================
async function checkRankChange(channel, player, discordUserId, guildId) {
  const rankEntries = await getRankByPuuid(player.puuid);
  const solo = rankEntries.find((r) => r.queueType === 'RANKED_SOLO_5x5');

  if (!solo) return;

  const newRank = { tier: solo.tier, rank: solo.rank, lp: solo.leaguePoints, wins: solo.wins, losses: solo.losses };
  const oldRank = player.lastRank;

  if (!oldRank) {
    await updatePlayerState(guildId, discordUserId, { lastRank: newRank });
    return;
  }

  if (oldRank.tier === newRank.tier && oldRank.rank === newRank.rank) {
    await updatePlayerState(guildId, discordUserId, { lastRank: newRank });
    return;
  }

  const comparison = compareTiers(oldRank, newRank);

  if (comparison > 0) {
    await sendPromotionNotification(channel, player, discordUserId, oldRank, newRank);
  } else if (comparison < 0) {
    await sendDemotionNotification(channel, player, discordUserId, oldRank, newRank);
  }

  await updatePlayerState(guildId, discordUserId, { lastRank: newRank });
}

function compareTiers(oldRank, newRank) {
  const oldTierIdx = TIER_ORDER.indexOf(oldRank.tier);
  const newTierIdx = TIER_ORDER.indexOf(newRank.tier);

  if (newTierIdx !== oldTierIdx) {
    return newTierIdx - oldTierIdx;
  }

  const oldRankIdx = RANK_ORDER.indexOf(oldRank.rank);
  const newRankIdx = RANK_ORDER.indexOf(newRank.rank);
  return newRankIdx - oldRankIdx;
}

async function sendPromotionNotification(channel, player, discordUserId, oldRank, newRank) {
  const oldTierIdx = TIER_ORDER.indexOf(oldRank.tier);
  const newTierIdx = TIER_ORDER.indexOf(newRank.tier);
  const isTierUp = newTierIdx > oldTierIdx;

  const oldDisplay = `${TIER_KO[oldRank.tier] || oldRank.tier} ${oldRank.rank}`;
  const newDisplay = `${TIER_KO[newRank.tier] || newRank.tier} ${newRank.rank}`;
  const emoji = TIER_EMOJI[newRank.tier] || '🎉';

  const isHighElo = ['MASTER', 'GRANDMASTER', 'CHALLENGER'].includes(newRank.tier);

  let title, description, color;

  if (isHighElo && isTierUp) {
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
    title = `🎉 ${player.gameName}님 ${TIER_KO[newRank.tier]} 승급!`;
    description =
      `<@${discordUserId}>\n\n` +
      `${emoji} **${oldDisplay}** → **${newDisplay}** ${newRank.lp}LP\n` +
      `전적: ${newRank.wins}승 ${newRank.losses}패 (${Math.round((newRank.wins / (newRank.wins + newRank.losses)) * 100)}%)\n\n` +
      '🎉 축하합니다!';
    color = 0x57f287;
  } else {
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
