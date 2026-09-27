'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { PermissionFlagsBits } = require('discord.js');

const { loadWithMocks } = require('./helpers/load-with-mocks');

const ROOT = path.resolve(__dirname, '..');
const servicePath = (name) => path.join(ROOT, 'src', 'services', name);

test('XP 지급은 메시지 수와 XP를 갱신하고 레벨업을 판정한다', async (t) => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT \* FROM levels/.test(sql)) {
        return { rows: [{ xp: 90, level: 0, last_xp_time: 0, message_count: 3 }] };
      }
      return { rows: [] };
    },
  };
  t.mock.method(Date, 'now', () => 120000);
  t.mock.method(Math, 'random', () => 0);
  const { addXp } = loadWithMocks(servicePath('levelService.js'), { '../db': { pool } });

  const result = await addXp('g1', 'u1');

  assert.equal(result.xpGain, 15);
  assert.equal(result.newLevel, 1);
  assert.equal(result.leveledUp, true);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[3].values, ['g1', 'u1', 105, 1, 120000]);
});

test('XP cooldown 중에는 메시지 수만 증가한다', async (t) => {
  const calls = [];
  const pool = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (/SELECT \* FROM levels/.test(sql)) {
        return { rows: [{ xp: 500, level: 2, last_xp_time: 90000, message_count: 3 }] };
      }
      return { rows: [] };
    },
  };
  t.mock.method(Date, 'now', () => 120000);
  const { addXp } = loadWithMocks(servicePath('levelService.js'), { '../db': { pool } });

  const result = await addXp('g1', 'u1');

  assert.equal(result.leveledUp, false);
  assert.equal(calls.length, 3);
  assert.match(calls[2].sql, /message_count = message_count \+ 1/);
});

test('칭호 적용은 기존 칭호를 교체하고 Discord 32자 제한을 지킨다', async () => {
  let nickname;
  const member = {
    nickname: '[기존] 매우긴사용자이름입니다매우긴사용자이름입니다',
    user: { displayName: 'fallback' },
    async setNickname(value) { nickname = value; return value; },
  };
  const { applyTitle } = loadWithMocks(servicePath('titleService.js'), {
    '../db': { pool: { query: async () => ({ rows: [] }) } },
  });

  await applyTitle(member, '새칭호');
  assert.ok(nickname.startsWith('[새칭호] '));
  assert.ok(nickname.length <= 32);
  assert.equal(nickname.includes('[기존]'), false);
});

test('Limbus profile upsert는 모든 입력을 SQL parameter로 전달한다', async () => {
  let captured;
  const row = { guild_id: 'g1', user_id: 'u1', level: 50 };
  const pool = {
    async query(sql, values) {
      captured = { sql, values };
      return { rows: [row] };
    },
  };
  const { upsertProfile } = loadWithMocks(servicePath('limbusService.js'), { '../db': { pool } });
  const result = await upsertProfile('g1', 'u1', {
    storyChapter: 7,
    mirrorFloor: 5,
    identityCount: 12,
    egoCount: 8,
    level: 50,
    mainSinner: '이상',
    mainIdentity: '검계',
    note: '메모',
    screenshotUrl: 'https://example.test/a.png',
  });

  assert.equal(result, row);
  assert.match(captured.sql, /ON CONFLICT/);
  assert.deepEqual(captured.values, [
    'g1', 'u1', 7, 5, 12, 8, 50, '이상', '검계', '메모', 'https://example.test/a.png',
  ]);
});

test('환영 embed는 사용자·서버 template 변수를 치환한다', () => {
  const { createWelcomeEmbed } = loadWithMocks(servicePath('welcomeService.js'), {
    '../db': { pool: { query: async () => ({ rows: [] }) } },
  });
  const member = {
    toString: () => '<@u1>',
    displayName: '동제',
    joinedTimestamp: 1000,
    user: {
      username: 'dongj',
      tag: 'dongj#0001',
      displayAvatarURL: () => 'https://example.test/avatar.png',
    },
    guild: { name: '테스트 서버', memberCount: 42 },
  };
  const embed = createWelcomeEmbed(member, {
    message: '{{user}} / {{username}} / {{server}} / {{memberCount}}',
  }).toJSON();

  assert.equal(embed.description, '<@u1> / 동제 / 테스트 서버 / 42');
  assert.equal(embed.fields[1].value, '42명');
});

test('게임 선택은 선택 role을 추가하고 기존 미선택 role을 제거한다', async () => {
  const { GAME_ROLES, handleGameSelect } = loadWithMocks(servicePath('welcomeService.js'), {
    '../db': { pool: { query: async () => ({ rows: [] }) } },
  });
  const selected = GAME_ROLES[0];
  const old = GAME_ROLES[1];
  const availableRoles = new Map(GAME_ROLES.map((game) => [game.id, { id: game.id }]));
  const existing = new Set([old.id]);
  const added = [];
  const removed = [];
  let reply;
  const interaction = {
    values: [selected.id],
    deferred: false,
    guild: { roles: { cache: availableRoles } },
    member: {
      roles: {
        cache: { has: (id) => existing.has(id) },
        async add(role) { added.push(role.id); },
        async remove(role) { removed.push(role.id); },
      },
    },
    async deferReply() { this.deferred = true; },
    async editReply(value) { reply = value; },
  };

  await handleGameSelect(interaction);
  assert.deepEqual(added, [selected.id]);
  assert.deepEqual(removed, [old.id]);
  assert.match(reply.embeds[0].toJSON().description, /League of Legends/);
});

test('투표는 등록, 변경, 같은 항목 재클릭 취소를 처리한다', async () => {
  const { registerVote, handleVoteButton, getVoteResults, activeVotes } = require('../src/services/voteService');
  const messageId = `vote-${Date.now()}`;
  registerVote(messageId, ['A', 'B'], null);

  const replies = [];
  const interaction = {
    message: { id: messageId },
    customId: 'vote_0',
    user: { id: 'u1' },
    async reply(value) { replies.push(value); },
  };

  await handleVoteButton(interaction);
  assert.deepEqual(getVoteResults(messageId), { A: 1, B: 0 });
  interaction.customId = 'vote_1';
  await handleVoteButton(interaction);
  assert.deepEqual(getVoteResults(messageId), { A: 0, B: 1 });
  await handleVoteButton(interaction);
  assert.deepEqual(getVoteResults(messageId), { A: 0, B: 0 });
  assert.match(replies[2].content, /취소/);
  activeVotes.delete(messageId);
});

test('임시 음성방 staff 판정은 owner와 관리 권한만 허용한다', () => {
  const { isStaff } = require('../src/services/tempVoiceService');
  const makeMember = (id, ownerId, permissions) => ({
    id,
    guild: { ownerId },
    permissions: { has: (permission) => permissions.includes(permission) },
  });

  assert.equal(isStaff(makeMember('owner', 'owner', [])), true);
  assert.equal(isStaff(makeMember('admin', 'owner', [PermissionFlagsBits.ManageGuild])), true);
  assert.equal(isStaff(makeMember('member', 'owner', [PermissionFlagsBits.MoveMembers])), false);
});

test('custom emoji 메시지는 원본을 지우고 CDN image embed로 대체한다', async () => {
  const { handleEmojiEnlarge } = require('../src/events/emojiEnlarger');
  let deleted = false;
  let sent;
  const message = {
    content: '<a:dance:123456789012345678>',
    author: {
      bot: false,
      username: 'tester',
      displayAvatarURL: () => 'https://example.test/avatar.png',
    },
    member: { displayName: '테스터', displayColor: 0x123456 },
    stickers: { size: 0 },
    async delete() { deleted = true; },
    channel: { async send(value) { sent = value; } },
  };

  await handleEmojiEnlarge(message);
  assert.equal(deleted, true);
  assert.equal(
    sent.embeds[0].toJSON().image.url,
    'https://cdn.discordapp.com/emojis/123456789012345678.gif?size=256'
  );
});

test('Project Moon RSS 응답에서 최신 영상 정보를 파싱한다', async () => {
  const xml = `<?xml version="1.0"?><feed><entry><yt:videoId>abc123</yt:videoId><title>A &amp; B</title><link rel="alternate" href="https://youtube.test/watch?v=abc123"/><published>2026-01-01T00:00:00Z</published><media:thumbnail url="https://img.test/a.jpg"/></entry></feed>`;
  const axios = { get: async () => ({ data: xml }) };
  const { fetchLatestVideo } = loadWithMocks(servicePath('projectMoonService.js'), {
    axios,
    'node-cron': { schedule: () => ({ stop() {} }) },
  });

  const video = await fetchLatestVideo();
  assert.deepEqual(video, {
    videoId: 'abc123',
    title: 'A & B',
    published: '2026-01-01T00:00:00Z',
    thumbnail: 'https://img.test/a.jpg',
    author: 'ProjectMoon Official',
    url: 'https://www.youtube.com/watch?v=abc123',
  });
});
