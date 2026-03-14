const express = require('express');
const session = require('express-session');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const app = express();
const PORT = process.env.DASHBOARD_PORT || 3000;

// ============================================
// Middleware
// ============================================
app.use(express.json());
app.use(
  cors({
    origin: process.env.DASHBOARD_URL || 'http://localhost:3000',
    credentials: true,
  })
);
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'discord-bot-dashboard-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // true in production with HTTPS
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Static files (React build)
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// Discord Bot Client Reference
// ============================================
let botClient = null;

function setBotClient(client) {
  botClient = client;
  console.log('🌐 대시보드에 봇 클라이언트 연결됨');
}

// Bot client check middleware
function requireBot(req, res, next) {
  if (!botClient) {
    return res.status(503).json({ error: '봇이 아직 준비되지 않았습니다.' });
  }
  next();
}

// Auth check middleware
function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  next();
}

// ============================================
// Discord OAuth2 Routes
// ============================================

// Login redirect
app.get('/auth/discord', (req, res) => {
  const params = new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    redirect_uri: `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/auth/discord/callback`,
    response_type: 'code',
    scope: 'identify guilds',
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

// OAuth2 callback
app.get('/auth/discord/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.redirect('/?error=no_code');
  }

  try {
    // Exchange code for token
    const tokenRes = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: `${process.env.DASHBOARD_URL || 'http://localhost:3000'}/auth/discord/callback`,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const { access_token } = tokenRes.data;

    // Get user info
    const userRes = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    // Get user's guilds
    const guildsRes = await axios.get('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const user = userRes.data;
    const guilds = guildsRes.data;

    // Filter guilds where user has admin permission
    const adminGuilds = guilds.filter((g) => (g.permissions & 0x8) === 0x8);

    // If bot is connected, further filter to mutual guilds
    let mutualGuilds = adminGuilds;
    if (botClient && botClient.guilds.cache.size > 0) {
      const botGuildIds = botClient.guilds.cache.map((g) => g.id);
      const filtered = adminGuilds.filter((g) => botGuildIds.includes(g.id));
      if (filtered.length > 0) {
        mutualGuilds = filtered;
      }
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      discriminator: user.discriminator,
      avatar: user.avatar,
      guilds: mutualGuilds,
      accessToken: access_token,
    };

    res.redirect('/');
  } catch (err) {
    console.error('OAuth2 에러:', err.response?.data || err.message);
    res.redirect('/?error=auth_failed');
  }
});

// Get current user
app.get('/api/auth/user', (req, res) => {
  if (!req.session.user) {
    return res.json({ loggedIn: false });
  }
  const { accessToken, ...user } = req.session.user;
  res.json({ loggedIn: true, user });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ============================================
// Server Info Routes
// ============================================

// Get server info
app.get('/api/guilds/:guildId', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    // Check user has access
    const userGuild = req.session.user.guilds.find((g) => g.id === guild.id);
    if (!userGuild) return res.status(403).json({ error: '접근 권한이 없습니다.' });

    const members = await guild.members.fetch();
    const onlineMembers = members.filter(
      (m) => m.presence?.status && m.presence.status !== 'offline'
    );

    res.json({
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ dynamic: true }),
      memberCount: guild.memberCount,
      onlineCount: onlineMembers.size,
      boostLevel: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount || 0,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
      createdAt: guild.createdAt,
      ownerId: guild.ownerId,
    });
  } catch (err) {
    console.error('서버 정보 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Channel Routes
// ============================================

// Get channels
app.get('/api/guilds/:guildId/channels', requireAuth, requireBot, (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const channels = guild.channels.cache.map((ch) => ({
      id: ch.id,
      name: ch.name,
      type: ch.type,
      parentId: ch.parentId,
      parentName: ch.parent?.name || null,
      position: ch.position,
    }));

    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create channel
app.post('/api/guilds/:guildId/channels', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { name, type, parentId } = req.body;
    const channel = await guild.channels.create({
      name,
      type: type || 0, // 0 = text, 2 = voice
      parent: parentId || undefined,
      reason: `대시보드에서 ${req.session.user.username}에 의해 생성`,
    });

    res.json({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete channel
app.delete('/api/guilds/:guildId/channels/:channelId', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const channel = guild.channels.cache.get(req.params.channelId);
    if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });

    await channel.delete(`대시보드에서 ${req.session.user.username}에 의해 삭제`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Role Routes
// ============================================

// Get roles
app.get('/api/guilds/:guildId/roles', requireAuth, requireBot, (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const roles = guild.roles.cache
      .filter((r) => r.name !== '@everyone')
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        name: r.name,
        color: r.hexColor,
        members: r.members.size,
        hoist: r.hoist,
        position: r.position,
        permissions: r.permissions.toArray(),
      }));

    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create role
app.post('/api/guilds/:guildId/roles', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { name, color, hoist } = req.body;
    const role = await guild.roles.create({
      name,
      color: color || '#000000',
      hoist: hoist || false,
      reason: `대시보드에서 ${req.session.user.username}에 의해 생성`,
    });

    res.json({
      id: role.id,
      name: role.name,
      color: role.hexColor,
      members: 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete role
app.delete('/api/guilds/:guildId/roles/:roleId', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const role = guild.roles.cache.get(req.params.roleId);
    if (!role) return res.status(404).json({ error: '역할을 찾을 수 없습니다.' });

    await role.delete(`대시보드에서 ${req.session.user.username}에 의해 삭제`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Member Routes
// ============================================

// Get members
app.get('/api/guilds/:guildId/members', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const members = await guild.members.fetch({ limit: 100, force: true });
    const memberList = members
      .filter((m) => !m.user.bot)
      .map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL({ dynamic: true, size: 64 }),
        roles: m.roles.cache
          .filter((r) => r.name !== '@everyone')
          .sort((a, b) => b.position - a.position)
          .map((r) => ({ id: r.id, name: r.name, color: r.hexColor })),
        status: m.presence?.status || 'offline',
        joinedAt: m.joinedAt,
      }))
      .sort((a, b) => {
        const order = { online: 0, idle: 1, dnd: 2, offline: 3 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3);
      });

    res.json(memberList);
  } catch (err) {
    console.error('멤버 조회 오류:', err);
    res.status(500).json({ error: err.message });
  }
});

// Kick member
app.post('/api/guilds/:guildId/members/:memberId/kick', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const member = await guild.members.fetch(req.params.memberId);
    if (!member) return res.status(404).json({ error: '멤버를 찾을 수 없습니다.' });

    const reason = req.body.reason || `대시보드에서 ${req.session.user.username}에 의해 추방`;
    await member.kick(reason);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ban member
app.post('/api/guilds/:guildId/members/:memberId/ban', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const member = await guild.members.fetch(req.params.memberId);
    if (!member) return res.status(404).json({ error: '멤버를 찾을 수 없습니다.' });

    const reason = req.body.reason || `대시보드에서 ${req.session.user.username}에 의해 차단`;
    await member.ban({ reason });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Timeout member
app.post('/api/guilds/:guildId/members/:memberId/timeout', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const member = await guild.members.fetch(req.params.memberId);
    if (!member) return res.status(404).json({ error: '멤버를 찾을 수 없습니다.' });

    const minutes = req.body.minutes || 5;
    await member.timeout(minutes * 60 * 1000, `대시보드에서 ${req.session.user.username}에 의해 타임아웃`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Assign role to member
app.post('/api/guilds/:guildId/members/:memberId/roles/:roleId', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const member = await guild.members.fetch(req.params.memberId);
    const role = guild.roles.cache.get(req.params.roleId);

    if (!member || !role) return res.status(404).json({ error: '멤버 또는 역할을 찾을 수 없습니다.' });

    await member.roles.add(role);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove role from member
app.delete('/api/guilds/:guildId/members/:memberId/roles/:roleId', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const member = await guild.members.fetch(req.params.memberId);
    const role = guild.roles.cache.get(req.params.roleId);

    if (!member || !role) return res.status(404).json({ error: '멤버 또는 역할을 찾을 수 없습니다.' });

    await member.roles.remove(role);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Server Setup (Templates) Route
// ============================================

app.post('/api/guilds/:guildId/setup', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { templateId, clearExisting } = req.body;
    const templates = require('../src/templates/serverTemplates');
    const template = templates[templateId];

    if (!template) return res.status(400).json({ error: '템플릿을 찾을 수 없습니다.' });

    const { clearServer, createRoles, createChannels } = require('../src/utils/serverSetup');

    if (clearExisting) {
      await clearServer(guild);
    }

    const createdRoles = await createRoles(guild, template.roles);
    const createdChannels = await createChannels(guild, template.categories, createdRoles);

    res.json({
      success: true,
      roles: Object.keys(createdRoles).length,
      channels: Object.keys(createdChannels).length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Patch Notes Route
// ============================================

app.post('/api/guilds/:guildId/patchnotes/check', requireAuth, requireBot, async (req, res) => {
  try {
    const { forceGetLatestPatch } = require('../src/services/patchCrawler');
    const { sendPatchToChannel } = require('../src/services/patchScheduler');

    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { channelId } = req.body;
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return res.status(404).json({ error: '채널을 찾을 수 없습니다.' });

    const patchData = await forceGetLatestPatch();
    if (!patchData) return res.status(404).json({ error: '패치노트를 가져올 수 없습니다.' });

    await sendPatchToChannel(channel, patchData);
    res.json({ success: true, title: patchData.title });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get patch status
app.get('/api/patchnotes/status', requireAuth, (req, res) => {
  try {
    const { loadLastPatch } = require('../src/services/patchCrawler');
    const lastPatch = loadLastPatch();
    res.json({
      ...lastPatch,
      aiEnabled: !!process.env.ANTHROPIC_API_KEY,
      schedulerEnabled: !!process.env.LOL_PATCH_CHANNEL_ID,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Server Settings Routes
// ============================================

app.patch('/api/guilds/:guildId/settings', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { name, verificationLevel, defaultMessageNotifications } = req.body;

    if (name) await guild.setName(name);
    if (verificationLevel !== undefined) await guild.setVerificationLevel(verificationLevel);
    if (defaultMessageNotifications !== undefined)
      await guild.setDefaultMessageNotifications(defaultMessageNotifications);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Leaderboard Route (공개 - 인증 불필요)
// ============================================

app.get('/api/guilds/:guildId/leaderboard', requireBot, async (req, res) => {
  try {
    const { getLeaderboard, xpForNextLevel } = require('../src/services/levelService');
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const top = await getLeaderboard(req.params.guildId, 50);

    const enriched = await Promise.all(
      top.map(async (user, i) => {
        let member;
        try { member = await guild.members.fetch(user.userId); } catch (e) {}

        const nextXp = xpForNextLevel(user.level);
        const progress = nextXp > 0 ? Math.round((user.xp / nextXp) * 100) : 100;

        return {
          rank: i + 1,
          userId: user.userId,
          displayName: member?.displayName || member?.user.username || `유저 ${user.userId}`,
          avatar: member?.user.displayAvatarURL({ size: 128, extension: 'webp' }) || null,
          level: user.level,
          xp: user.xp,
          nextLevelXp: nextXp,
          progress,
          messageCount: user.messageCount,
        };
      })
    );

    res.json({
      guildId: req.params.guildId,
      guildName: guild.name,
      guildIcon: guild.iconURL({ size: 64 }),
      leaderboard: enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Stats Route (for dashboard)
// ============================================

app.get('/api/guilds/:guildId/stats', requireAuth, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    // Basic stats from guild
    const members = await guild.members.fetch();
    const onlineMembers = members.filter(
      (m) => m.presence?.status && m.presence.status !== 'offline'
    );
    const botMembers = members.filter((m) => m.user.bot);

    res.json({
      totalMembers: guild.memberCount,
      onlineMembers: onlineMembers.size,
      botCount: botMembers.size,
      channelCount: guild.channels.cache.size,
      roleCount: guild.roles.cache.size,
      boostLevel: guild.premiumTier,
      boostCount: guild.premiumSubscriptionCount || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Membership Routes (봇 오너 전용)
// ============================================

function requireOwner(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: '로그인이 필요합니다.' });
  }
  if (req.session.user.id !== process.env.BOT_OWNER_ID) {
    return res.status(403).json({ error: '봇 오너만 접근 가능합니다.' });
  }
  next();
}

// 봇 오너 여부 확인 API
app.get('/api/auth/is-owner', requireAuth, (req, res) => {
  res.json({ isOwner: req.session.user.id === process.env.BOT_OWNER_ID });
});

// 전체 멤버십 통계
app.get('/api/membership/stats', requireOwner, async (req, res) => {
  try {
    const { getMembershipStats } = require('../src/services/membershipService');
    const stats = await getMembershipStats();

    // 서버 이름 매핑
    if (botClient) {
      for (const guildId of Object.keys(stats.serverStats)) {
        const guild = botClient.guilds.cache.get(guildId);
        stats.serverStats[guildId].name = guild?.name || `알 수 없는 서버 (${guildId})`;
      }
    }

    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 전체 서버 멤버십 데이터
app.get('/api/membership', requireOwner, async (req, res) => {
  try {
    const { getAllMembershipData } = require('../src/services/membershipService');
    const data = await getAllMembershipData();

    // 서버 이름 + 유저 이름 매핑
    const result = {};
    for (const [guildId, users] of Object.entries(data)) {
      const guild = botClient?.guilds.cache.get(guildId);
      result[guildId] = {
        guildName: guild?.name || `알 수 없는 서버`,
        users: {},
      };
      for (const [userId, info] of Object.entries(users)) {
        const member = guild?.members.cache.get(userId);
        result[guildId].users[userId] = {
          ...info,
          username: member?.user.username || member?.user.tag || `유저 ${userId}`,
          displayName: member?.displayName || `유저 ${userId}`,
        };
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 서버 멤버십 데이터
app.get('/api/membership/:guildId', requireOwner, requireBot, async (req, res) => {
  try {
    const { getGuildMembershipData } = require('../src/services/membershipService');
    const guildId = req.params.guildId;
    const guild = botClient.guilds.cache.get(guildId);
    const users = await getGuildMembershipData(guildId);

    // 멤버 정보 fetch
    if (guild) {
      try { await guild.members.fetch(); } catch (e) { /* 무시 */ }
    }

    const result = {};
    for (const [userId, info] of Object.entries(users)) {
      const member = guild?.members.cache.get(userId);
      result[userId] = {
        ...info,
        username: member?.user.username || `유저 ${userId}`,
        displayName: member?.displayName || `유저 ${userId}`,
        avatar: member?.user.displayAvatarURL({ dynamic: true, size: 64 }) || null,
      };
    }

    res.json({
      guildId,
      guildName: guild?.name || '알 수 없는 서버',
      users: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 봇이 참여한 전체 서버 목록 (수동 충전 대상 서버 선택용)
app.get('/api/membership/guilds', requireOwner, requireBot, (req, res) => {
  try {
    const guilds = botClient.guilds.cache.map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.iconURL({ dynamic: true, size: 64 }),
      memberCount: g.memberCount,
    }));
    res.json(guilds);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 특정 서버 전체 멤버 목록 (멤버십 데이터 없는 유저도 포함)
app.get('/api/membership/guilds/:guildId/members', requireOwner, requireBot, async (req, res) => {
  try {
    const guild = botClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: '서버를 찾을 수 없습니다.' });

    const { getGuildMembershipData } = require('../src/services/membershipService');
    const membershipData = await getGuildMembershipData(req.params.guildId);

    const members = await guild.members.fetch();
    const memberList = members
      .filter((m) => !m.user.bot)
      .map((m) => ({
        id: m.id,
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL({ dynamic: true, size: 64 }),
        credits: membershipData[m.id]?.credits || 0,
        hasMembership: !!membershipData[m.id],
      }))
      .sort((a, b) => b.credits - a.credits);

    res.json(memberList);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 크레딧 충전 (봇 오너) + 유저 DM 알림
app.post('/api/membership/:guildId/:userId/charge', requireOwner, requireBot, async (req, res) => {
  try {
    const { chargeCredits, TIERS } = require('../src/services/membershipService');
    const { guildId, userId } = req.params;
    const { amount, tier, sendDm } = req.body;

    if (!amount || amount <= 0) {
      return res.status(400).json({ error: '충전할 크레딧 수를 입력해주세요.' });
    }

    // 티어 이름 판별
    let tierName = tier || '커스텀';
    if (!tier) {
      for (const [, t] of Object.entries(TIERS)) {
        if (t.credits === amount) {
          tierName = t.name;
          break;
        }
      }
    }

    const result = await chargeCredits(guildId, userId, amount, tierName, process.env.BOT_OWNER_ID);

    // 유저에게 DM 알림 전송
    let dmSent = false;
    if (sendDm !== false) {
      try {
        const { EmbedBuilder } = require('discord.js');
        const targetUser = await botClient.users.fetch(userId);
        const guild = botClient.guilds.cache.get(guildId);
        const serverName = guild?.name || '서버';

        await targetUser.send({
          embeds: [
            new EmbedBuilder()
              .setTitle('✅ 크레딧 충전 완료!')
              .setDescription(
                `**${serverName}**에서 크레딧이 충전되었습니다!\n\n` +
                  `🏷️ 티어: ${tierName}\n` +
                  `➕ 충전: ${amount}회\n` +
                  `💳 잔여 크레딧: **${result.credits}회**\n\n` +
                  '`/멤버십 정보`로 확인할 수 있습니다.'
              )
              .setColor(0x57f287)
              .setTimestamp(),
          ],
        });
        dmSent = true;
      } catch (dmErr) {
        console.error('충전 DM 전송 실패:', dmErr.message);
      }
    }

    res.json({ success: true, dmSent, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// Intro Page
// ============================================
app.get('/intro', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'intro.html'));
});

// ============================================
// SPA Fallback
// ============================================
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============================================
// Start Server
// ============================================
function startDashboard(client) {
  setBotClient(client);

  app.listen(PORT, () => {
    console.log(`\n🌐 대시보드: http://localhost:${PORT}`);
    console.log(`🔗 OAuth2 콜백: http://localhost:${PORT}/auth/discord/callback`);
    console.log('');
  });
}

module.exports = { startDashboard, setBotClient };