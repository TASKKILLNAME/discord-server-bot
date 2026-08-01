/**
 * 방장 역할에서 "길드 전역 모더레이션 권한"만 걷어낸다 (권한 역전 방지)
 *
 * 문제: 역할 권한으로 Mute/Deafen/Move Members 를 주면 서버 전체에 적용된다.
 *       디스코드는 음성 제재에 역할 계층 검사를 하지 않으므로,
 *       최하위 방장도 관리자를 음소거할 수 있게 된다.
 *       (create-leader-roles.js 가 이 형태로 역할을 만들었다 — 이후 수정됨)
 *
 * 해결: 아래 DANGEROUS 비트만 제거. 채팅/음성 접속 같은 일반 권한은 건드리지 않는다.
 *       방장의 실제 방 통제 권한은 tempVoiceService 가 방 생성 시
 *       "채널 오버라이트"로 부여하므로 기능 손실은 없다.
 *
 * 실행: node scripts/fix-leader-role-perms.js         (미리보기)
 *       node scripts/fix-leader-role-perms.js --apply (실제 적용)
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { REST, Routes, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const GUILD_ID = process.env.GUILD_ID || '1268523142897209405';
const APPLY = process.argv.includes('--apply');

// 방장 역할이 서버 전역으로 들고 있으면 안 되는 권한
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MuteMembers,
  PermissionFlagsBits.DeafenMembers,
  PermissionFlagsBits.MoveMembers,
].reduce((acc, bit) => acc | bit, 0n);

async function main() {
  const roles = await rest.get(Routes.guildRoles(GUILD_ID));
  const leaders = roles.filter(r => r.name.includes('방장'));

  if (leaders.length === 0) {
    console.log('방장 역할을 찾지 못했습니다.');
    return;
  }

  console.log(`${APPLY ? '🔧 적용' : '👀 미리보기'} — 방장 역할 ${leaders.length}개\n`);

  for (const role of leaders) {
    const current = BigInt(role.permissions);
    const offending = current & DANGEROUS;

    if (offending === 0n) {
      console.log(`  ⏭️  ${role.name} — 안전 (전역 모더레이션 권한 없음)`);
      continue;
    }

    const next = current & ~DANGEROUS;
    const removed = new PermissionsBitField(offending).toArray().join(', ');
    console.log(`  ${APPLY ? '✅' : '·'} ${role.name} — 제거: ${removed}`);

    if (APPLY) {
      try {
        await rest.patch(Routes.guildRole(GUILD_ID, role.id), {
          body: { permissions: String(next) },
          reason: '권한 역전 방지 - 방장 권한은 채널 오버라이트로만 부여',
        });
      } catch (err) {
        console.error(`     ❌ 실패: ${err.message}`);
      }
    }
  }

  if (!APPLY) {
    console.log('\n실제로 적용하려면: node scripts/fix-leader-role-perms.js --apply');
  }
}

main().catch(console.error);
