require('dotenv').config();
const { moderateComment } = require('../comment_moderation');

(async () => {
  const r = await moderateComment("привет, тест", {
    gptApiKey: process.env.OPENAI_API_KEY,
    gptApiUrl: process.env.GPT_MODERATION_URL,
    gptModel: process.env.GPT_MODERATION_MODEL
  });
  console.log('TEST RESULT:', r);
})();
