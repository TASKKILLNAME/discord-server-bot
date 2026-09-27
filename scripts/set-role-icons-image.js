require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const GUILD_ID = '1268523142897209405';
const ICONS_DIR = path.join(__dirname, '../data/role-icons');

// 파일명(확장자 제외) → 역할 이름 매핑
// data/role-icons/ 폴더에 <파일명>.png 또는 .jpg 넣기
const ROLE_ICON_FILES = {
  'lol':        'LOL',
  'valorant':   'valorant',
  'apex':       'apex',
  'pubg':       'pubg',
  'rainbow6':   'rainbow6',
  'tarkov':     'tarkov',
  'limbus':     '림버스',
  // 방장 아이콘은 공용으로 쓰고 싶으면 파일명 중복 사용 가능
};

function findIconFile(baseName) {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const filePath = path.join(ICONS_DIR, baseName + ext);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}

async function main() {
  if (!fs.existsSync(ICONS_DIR)) {
    fs.mkdirSync(ICONS_DIR, { recursive: true });
    console.log(`📁 폴더 생성: ${ICONS_DIR}`);
    console.log('이 폴더에 다음 이미지 파일을 넣어주세요 (PNG/JPG, 256KB 이하):');
    for (const [file, role] of Object.entries(ROLE_ICON_FILES)) {
      console.log(`  • ${file}.png → ${role} 역할`);
    }
    return;
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  await client.login(process.env.DISCORD_TOKEN);

  const guild = await client.guilds.fetch(GUILD_ID);
  await guild.roles.fetch();

  console.log(`\n🎨 이미지 역할 아이콘 설정 시작\n`);

  let success = 0;
  let skipped = 0;
  let failed = 0;

  for (const [fileName, roleName] of Object.entries(ROLE_ICON_FILES)) {
    const iconPath = findIconFile(fileName);
    if (!iconPath) {
      console.log(`⏭️  이미지 없음 (건너뜀): ${fileName}.png → ${roleName}`);
      skipped++;
      continue;
    }

    const role = guild.roles.cache.find((r) => r.name === roleName);
    if (!role) {
      console.log(`⚠️  역할 없음: ${roleName}`);
      failed++;
      continue;
    }

    const origSize = fs.statSync(iconPath).size;

    try {
      // 자동 리사이징: 128x128, PNG, 품질 조정하여 256KB 이내로
      let buffer = await sharp(iconPath)
        .resize(128, 128, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png({ compressionLevel: 9 })
        .toBuffer();

      // 그래도 초과하면 더 작게
      let size = 128;
      while (buffer.length > 256 * 1024 && size >= 64) {
        size -= 16;
        buffer = await sharp(iconPath)
          .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .png({ compressionLevel: 9 })
          .toBuffer();
      }

      if (buffer.length > 256 * 1024) {
        console.log(`❌ ${roleName}: 압축 후에도 256KB 초과`);
        failed++;
        continue;
      }

      // 이모지 먼저 제거 (이모지와 이미지는 동시에 가질 수 없음)
      await role.edit({ unicodeEmoji: null });
      await role.edit({ icon: buffer });
      console.log(`✅ ${roleName} ← ${path.basename(iconPath)} (${Math.round(origSize / 1024)}KB → ${Math.round(buffer.length / 1024)}KB, ${size}x${size})`);
      success++;
    } catch (err) {
      console.log(`❌ ${roleName}: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n🎉 완료! 성공: ${success}, 건너뜀: ${skipped}, 실패: ${failed}`);
  await client.destroy();
}

main().catch(console.error);
