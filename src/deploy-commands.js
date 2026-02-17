const { REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const commands = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs
  .readdirSync(commandsPath)
  .filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
  const command = require(path.join(commandsPath, file));
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
    console.log(`📝 명령어 로드: ${command.data.name}`);
  }
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log(`\n🔄 ${commands.length}개의 슬래시 명령어를 등록합니다...\n`);

    if (process.env.GUILD_ID) {
      // 특정 서버에 등록 (즉시 반영, 테스트용)
      const data = await rest.put(
        Routes.applicationGuildCommands(
          process.env.CLIENT_ID,
          process.env.GUILD_ID
        ),
        { body: commands }
      );
      console.log(`✅ ${data.length}개의 명령어가 테스트 서버에 등록되었습니다!`);
    } else {
      // 글로벌 등록 (반영까지 최대 1시간)
      const data = await rest.put(
        Routes.applicationCommands(process.env.CLIENT_ID),
        { body: commands }
      );
      console.log(
        `✅ ${data.length}개의 명령어가 글로벌로 등록되었습니다! (반영까지 최대 1시간)`
      );
    }
  } catch (error) {
    console.error('❌ 명령어 등록 실패:', error);
  }
})();