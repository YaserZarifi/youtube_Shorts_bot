export async function generateMetadata(env, userText, extraGuidance = []) {
  const guidanceList = Array.isArray(extraGuidance) ? extraGuidance : [extraGuidance].filter(Boolean);
  const guidanceBlock = guidanceList.length
    ? `\n\nAdditional instructions from the creator for this regeneration (apply ALL of these, most recent last):\n${guidanceList.map((g, i) => `${i + 1}. ${g}`).join("\n")}\n`
    : "";
//   const prompt = `You are helping write a YouTube Shorts upload.
// The creator gave this short note about the video: "${userText}"

// Write:
// - A punchy, clickable title under 90 characters
// - A 2-3 sentence description
// - A list of 5-8 relevant, viral hashtags (words only, no # symbol)

// Respond ONLY with valid JSON, no markdown, no explanation, in this exact shape:
// {"title": "...", "description": "...", "hashtags": ["tag1", "tag2"]}`;
// const prompt = `You are an expert YouTube Shorts content writer and SEO specialist.

// The creator uploads Persian (Farsi) YouTube Shorts focused on:
// - Persian poetry
// - Emotional music
// - Deep quotes
// - Sad, romantic, nostalgic, motivational, and meaningful content

// The audience is primarily Persian-speaking viewers. All generated text MUST be in natural, fluent Persian unless the user explicitly requests another language.

// The creator's note about this video:
// "${userText}"

// Generate:

// 1. title
// - Write a highly clickable YouTube Shorts title.
// - Maximum 90 characters.
// - Emotional and curiosity-driven.
// - Sound natural, not clickbait or spam.
// - Match the video's mood.


// 2. description
// - Write 2-3 engaging Persian sentences.
// - Encourage viewers to like, comment, and subscribe naturally.
// - Include relevant keywords for YouTube search.
// - Do not use excessive emojis (maximum 1).
// - if the "userText" contains #شعر hashtag, make sure to include the exact "usertext" in top of the description!

// 3. hashtags
// - Return 5-8 highly relevant hashtags.
// - Persian hashtags are preferred.
// - Mix niche and popular hashtags.
// - Return words only, WITHOUT the # symbol.
// - No duplicates.

// Return ONLY valid JSON.
// Do not include markdown, explanations, or extra text.

// Use exactly this schema:

// {
//   "title": "...",
//   "description": "...",
//   "hashtags": ["...", "..."]
// }`;

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
- Maximum 90 characters minimum 30 characters.
- Emotional and curiosity-driven.
- Sound natural, not clickbait or spam.
- Match the video's mood.

2. description
- Write 2-3 engaging Persian sentences.
- Encourage viewers to like, comment, and subscribe naturally.
- Include relevant keywords for YouTube search.
- Do not use excessive emojis (maximum 1).

Special rule for poetry videos:

If the creator's note contains the exact hashtag "#شعر", treat everything after that hashtag as the original poem/text.

In that case:
- Remove the "#شعر" hashtag itself.
- Place the extracted poem/text at the VERY TOP of the description exactly as provided.
- Preserve the original formatting and line breaks.
- Do NOT rewrite, summarize, correct, translate, or modify the poem in any way.
- Leave one blank line after the poem, then write the generated description below it.

If "#شعر" is not present, generate the description normally.

3. hashtags
Generate 7-10 hashtags following these rules:

Always include these static hashtags:
- shorts
- youtubeshorts
- شعر
- موسیقی

Then generate the remaining hashtags dynamically based on the creator's note and the video's content. Consider:
- The poem's emotion (love, sadness, hope, nostalgia, loneliness, motivation, spirituality, etc.)
- The poet (if mentioned)
- The music style
- The video's subject
- The overall mood

Rules:
- Prefer Persian hashtags whenever possible.
- English hashtags should only be internationally recognized ones (like shorts and youtubeshorts).
- Do NOT use generic hashtags such as:
  viral, fyp, foryou, explore, trending, xyzbca
- Do not generate duplicate hashtags.
- Return hashtags WITHOUT the # symbol.
${guidanceBlock}
Return ONLY valid JSON.
Do not include markdown, explanations, or extra text.

Use exactly this schema:

{
  "title": "...",
  "description": "...",
  "hashtags": [
    "shorts",
    "youtubeshorts",
    "شعر",
    "موسیقی",
    "...",
    "..."
  ]
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

  const staticTags = ["shorts", "youtubeshorts", "شعر", "موسیقی"];
  const aiTags = Array.isArray(parsed?.hashtags) ? parsed.hashtags.map((t) => String(t).replace(/^#/, "")) : [];
  const hashtags = [...new Set([...staticTags, ...aiTags])];

  const baseTitle = (parsed?.title && parsed.title.trim()) ? parsed.title.slice(0, 100) : fallbackTitle;
  const TITLE_SUFFIX = " #shorts #persian #فارسی";

let finalTitle = baseTitle;

if (finalTitle.length + TITLE_SUFFIX.length <= 100) {
  finalTitle += TITLE_SUFFIX;
}

  const hashtagsText = hashtags.map((h) => `#${h}`).join(" ");
  const baseDescription = parsed?.description?.trim() || "";
  const finalDescription = `${baseDescription}\n\n${hashtagsText}`.trim();

  return {
    title: finalTitle,
    description: finalDescription,
    hashtags,
    aiFailed: !parsed,
  };
}

// Pure, code-only checks on already-generated metadata — no AI/API calls.
// generateMetadata() already truncates the title, dedupes hashtags, and
// falls back to the raw caption on a JSON parse failure, so this only needs
// to catch what that fallback can't: AI commentary/JSON leaking into the
// text, and content that isn't actually Persian. Returns warnings only —
// nothing here blocks a draft from being queued, it just surfaces a heads-up
// in the preview message before the person taps Accept.
export function validateAIMetadata(meta) {
  const warnings = [];
  const title = meta.title || "";
  const description = meta.description || "";
  const combined = `${title} ${description}`;

  if (meta.aiFailed) {
    warnings.push("AI response couldn't be parsed — using your original caption as the title instead.");
  }

  if (/[{}[\]]|```/.test(combined)) {
    warnings.push("Title/description looks like it may contain leftover JSON or code formatting — worth a check.");
  }

  const commentaryPhrases = ["here is the title", "here's the title", "sure, here", "as an ai", "i cannot", "i can't"];
  const lower = combined.toLowerCase();
  if (commentaryPhrases.some((p) => lower.includes(p))) {
    warnings.push("Title/description may contain leftover AI commentary — worth a check.");
  }

  const persianChars = (combined.match(/[\u0600-\u06FF]/g) || []).length;
  const alphaChars = (combined.match(/[A-Za-z\u0600-\u06FF]/g) || []).length;
  if (alphaChars >= 10 && persianChars / alphaChars < 0.2) {
    warnings.push("AI responded mostly in English — check before accepting.");
  }

  if (/\S{40,}/.test(combined)) {
    warnings.push("Title/description contains an unusually long unbroken word — may be garbled output.");
  }

  return warnings;
}
