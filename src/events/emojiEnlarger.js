// src/events/emojiEnlarger.js
// 이모지 확대 기능 - 단일 이모지/스티커를 큰 이미지로 표시

const { EmbedBuilder } = require('discord.js');

// 커스텀 이모지 패턴: <:name:id> 또는 <a:name:id> (애니메이션)
const CUSTOM_EMOJI_REGEX = /^<(a?):(\w+):(\d+)>$/;

// 유니코드 이모지 패턴 (단일 이모지만 매칭)
// 참고: 유니코드 이모지는 CDN URL이 없으므로 커스텀 이모지만 처리하거나,
// Twemoji CDN을 활용할 수 있음
const UNICODE_EMOJI_REGEX = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u;

/**
 * 이모지 확대 핸들러
 * @param {import('discord.js').Message} message
 */
async function handleEmojiEnlarge(message) {
    // 봇 메시지 무시
    if (message.author.bot) return;

    const content = message.content.trim();

    // 1. 커스텀 이모지 체크 (서버 이모지, Nitro 이모지)
    const customMatch = content.match(CUSTOM_EMOJI_REGEX);
    if (customMatch) {
        const isAnimated = customMatch[1] === 'a';
        const emojiName = customMatch[2];
        const emojiId = customMatch[3];
        const extension = isAnimated ? 'gif' : 'png';
        const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${extension}?size=256`;

        await sendEnlargedEmoji(message, emojiName, emojiUrl);
        return;
    }

    // 2. 유니코드 이모지 체크 (Twemoji CDN 활용)
    if (UNICODE_EMOJI_REGEX.test(content)) {
        const codePoints = getEmojiCodePoints(content);
        if (codePoints) {
            const twemojiUrl = `https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/${codePoints}.png`;
            
            await sendEnlargedEmoji(message, content, twemojiUrl);
            return;
        }
    }

    // 3. 스티커 체크 (메시지에 스티커만 있는 경우)
    if (!content && message.stickers.size === 1) {
        const sticker = message.stickers.first();
        const stickerUrl = sticker.url;

        if (stickerUrl) {
            await sendEnlargedSticker(message, sticker.name, stickerUrl);
        }
    }
}

/**
 * 확대된 이모지를 Embed로 전송
 */
async function sendEnlargedEmoji(message, emojiName, emojiUrl) {
    try {
        const embed = new EmbedBuilder()
            .setAuthor({
                name: message.member?.displayName || message.author.displayName || message.author.username,
                iconURL: message.author.displayAvatarURL({ dynamic: true, size: 32 })
            })
            .setImage(emojiUrl)
            .setColor(message.member?.displayColor || 0x5865F2);

        // 원본 메시지 삭제 후 봇이 대신 전송
        await message.delete().catch(() => {});
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('[이모지 확대] 전송 실패:', error.message);
    }
}

/**
 * 확대된 스티커를 Embed로 전송
 */
async function sendEnlargedSticker(message, stickerName, stickerUrl) {
    try {
        const embed = new EmbedBuilder()
            .setAuthor({
                name: message.member?.displayName || message.author.displayName || message.author.username,
                iconURL: message.author.displayAvatarURL({ dynamic: true, size: 32 })
            })
            .setImage(stickerUrl)
            .setColor(message.member?.displayColor || 0x5865F2);

        await message.delete().catch(() => {});
        await message.channel.send({ embeds: [embed] });
    } catch (error) {
        console.error('[스티커 확대] 전송 실패:', error.message);
    }
}

/**
 * 유니코드 이모지를 Twemoji용 코드포인트 문자열로 변환
 * 예: '😀' → '1f600', '🇰🇷' → '1f1f0-1f1f7'
 */
function getEmojiCodePoints(emoji) {
    try {
        const codePoints = [...emoji]
            .map(char => char.codePointAt(0).toString(16))
            .filter(cp => cp !== 'fe0f') // variation selector 제거
            .join('-');
        return codePoints || null;
    } catch {
        return null;
    }
}

module.exports = { handleEmojiEnlarge };