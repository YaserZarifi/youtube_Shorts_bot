export async function generateMetadata(env, userText) {
//   const prompt = `You are helping write a YouTube Shorts upload.
// The creator gave this short note about the video: "${userText}"

// Write:
// - A punchy, clickable title under 90 characters
// - A 2-3 sentence description
// - A list of 5-8 relevant, viral hashtags (words only, no # symbol)

// Respond ONLY with valid JSON, no markdown, no explanation, in this exact shape:
// {"title": "...", "description": "...", "hashtags": ["tag1", "tag2"]}`;
const prompt = `You are an expert YouTube Shorts content writer and SEO specialist.

The creator uploads Persian (Farsi) YouTube Shorts focused on:
- Persian poetry
- Emotional music
- Deep quotes
- Sad, romantic, nostalgic, motivational, and meaningful content

The audience is primarily Persian-speaking viewers. All generated text MUST be in natural, fluent Persian unless the user explicitly requests another language.

The creator's note about this video:
"${userText}"

Generate:

1. title
- Write a highly clickable YouTube Shorts title.
- Maximum 90 characters.
- Emotional and curiosity-driven.
- Sound natural, not clickbait or spam.
- Match the video's mood.


2. description
- Write 2-3 engaging Persian sentences.
- Encourage viewers to like, comment, and subscribe naturally.
- Include relevant keywords for YouTube search.
- Do not use excessive emojis (maximum 1).
- if the "userText" contains #شعر hashtag, make sure to include the exact "usertext" in top of the description!

3. hashtags
- Return 5-8 highly relevant hashtags.
- Persian hashtags are preferred.
- Mix niche and popular hashtags.
- Return words only, WITHOUT the # symbol.
- No duplicates.

Return ONLY valid JSON.
Do not include markdown, explanations, or extra text.

Use exactly this schema:

{
  "title": "...",
  "description": "...",
  "hashtags": ["...", "..."]
}`;

  const result = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1024,
  });

  console.log("Raw AI result:", JSON.stringify(result));
  console.log("userText received:", JSON.stringify(userText));

  let rawText;
  if (typeof result === "string") {
    rawText = result;
  } else if (typeof result?.response === "string") {
    rawText = result.response;
  } else if (result?.response?.content) {
    rawText = result.response.content;
  } else if (result?.choices?.[0]?.message?.content) {
    rawText = result.choices[0].message.content;
  } else {
    rawText = JSON.stringify(result?.response ?? result);
  }

  console.log("Extracted rawText:", rawText);

  // Pull out just the {...} block in case the model added extra text around it
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  const cleaned = jsonMatch ? jsonMatch[0] : rawText.trim();

  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error("JSON parse failed:", err.message, "cleaned was:", cleaned);
  }

  const fallbackTitle = (userText || "Untitled").slice(0, 90);

  return {
    title: (parsed?.title && parsed.title.trim()) ? parsed.title.slice(0, 100) : fallbackTitle,
    description: parsed?.description?.trim() || "",
    hashtags: Array.isArray(parsed?.hashtags) && parsed.hashtags.length > 0 ? parsed.hashtags : [],
  };
}
