const {
  PermissionFlagsBits,
  ChannelType,
  PermissionsBitField,
} = require('discord.js');

/**
 * 서버의 기존 채널을 모두 삭제 (선택적)
 */
async function clearServer(guild) {
  const channels = guild.channels.cache;
  const deletePromises = [];

  for (const [, channel] of channels) {
    deletePromises.push(
      channel.delete().catch((err) => {
        console.log(`채널 삭제 실패: ${channel.name} - ${err.message}`);
      })
    );
    // Rate limit 방지
    await sleep(300);
  }

  await Promise.allSettled(deletePromises);
}

/**
 * 템플릿 기반으로 역할 생성
 */
async function createRoles(guild, roles) {
  const createdRoles = {};

  for (const roleData of roles) {
    try {
      const permissions = new PermissionsBitField(roleData.permissions || []);

      const role = await guild.roles.create({
        name: roleData.name,
        color: roleData.color || '#000000',
        hoist: roleData.hoist || false,
        permissions: permissions,
        reason: '서버 자동 구성 봇에 의해 생성됨',
      });

      createdRoles[roleData.name] = role;
      console.log(`✅ 역할 생성: ${roleData.name}`);
      await sleep(300);
    } catch (err) {
      console.error(`❌ 역할 생성 실패: ${roleData.name} - ${err.message}`);
    }
  }

  return createdRoles;
}

/**
 * 템플릿 기반으로 카테고리 및 채널 생성
 */
async function createChannels(guild, categories, createdRoles) {
  const createdChannels = {};

  for (const categoryData of categories) {
    try {
      // 카테고리 생성
      const category = await guild.channels.create({
        name: categoryData.name,
        type: ChannelType.GuildCategory,
        reason: '서버 자동 구성 봇에 의해 생성됨',
      });

      console.log(`📁 카테고리 생성: ${categoryData.name}`);
      await sleep(300);

      // 카테고리 내 채널 생성
      for (const channelData of categoryData.channels) {
        try {
          const channelOptions = {
            name: channelData.name,
            type: channelData.type || ChannelType.GuildText,
            parent: category.id,
            reason: '서버 자동 구성 봇에 의해 생성됨',
          };

          // 읽기 전용 채널 권한 설정
          if (channelData.readOnly) {
            channelOptions.permissionOverwrites = [
              {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.SendMessages],
                allow: [PermissionFlagsBits.ViewChannel],
              },
            ];
          }

          // 스태프 전용 채널 권한 설정
          if (channelData.staffOnly) {
            const staffRoles = Object.entries(createdRoles)
              .filter(
                ([name]) =>
                  name.includes('관리자') ||
                  name.includes('직원') ||
                  name.includes('스태프') ||
                  name.includes('PM') ||
                  name.includes('서버장') ||
                  name.includes('운영진') ||
                  name.includes('스터디장') ||
                  name.includes('대표')
              )
              .map(([, role]) => role);

            const overwrites = [
              {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
            ];

            for (const staffRole of staffRoles) {
              overwrites.push({
                id: staffRole.id,
                allow: [
                  PermissionFlagsBits.ViewChannel,
                  PermissionFlagsBits.SendMessages,
                ],
              });
            }

            channelOptions.permissionOverwrites = overwrites;
          }

          const channel = await guild.channels.create(channelOptions);
          createdChannels[channelData.name] = channel;
          console.log(`  📝 채널 생성: ${channelData.name}`);
          await sleep(300);
        } catch (err) {
          console.error(
            `  ❌ 채널 생성 실패: ${channelData.name} - ${err.message}`
          );
        }
      }
    } catch (err) {
      console.error(
        `❌ 카테고리 생성 실패: ${categoryData.name} - ${err.message}`
      );
    }
  }

  return createdChannels;
}

/**
 * 멤버에게 역할 부여
 */
async function assignRole(guild, userId, roleName, createdRoles) {
  try {
    const member = await guild.members.fetch(userId);
    const role = createdRoles[roleName];

    if (!role) {
      return { success: false, message: `역할 "${roleName}"을 찾을 수 없습니다.` };
    }

    await member.roles.add(role);
    return { success: true, message: `${member.displayName}에게 ${roleName} 역할을 부여했습니다.` };
  } catch (err) {
    return { success: false, message: `역할 부여 실패: ${err.message}` };
  }
}

/**
 * Rate limit 방지용 딜레이
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 진행 상황 임베드 생성
 */
function createProgressEmbed(title, description, color = '#00ff00') {
  return {
    embeds: [
      {
        title,
        description,
        color: parseInt(color.replace('#', ''), 16),
        timestamp: new Date().toISOString(),
        footer: { text: '🤖 Server Manager Bot' },
      },
    ],
  };
}

module.exports = {
  clearServer,
  createRoles,
  createChannels,
  assignRole,
  sleep,
  createProgressEmbed,
};