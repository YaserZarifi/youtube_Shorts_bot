export async function getAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.YT_CLIENT_ID,
      client_secret: env.YT_CLIENT_SECRET,
      refresh_token: env.YT_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

export async function uploadShort(env, videoBytes, { title, description, tags }) {
  const accessToken = await getAccessToken(env);

  const metadata = {
    snippet: { title, description, tags, categoryId: "22" },
    status: { privacyStatus: env.YT_PRIVACY_STATUS || "public", selfDeclaredMadeForKids: false },
  };

  const boundary = "reelsbotboundary";
  const metaPart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`;
  const videoHeader = `--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`;
  const closing = `\r\n--${boundary}--`;

  const body = new Blob([metaPart, videoHeader, videoBytes, closing]);

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?part=snippet,status&uploadType=multipart",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );

  const data = await res.json();
  if (!data.id) throw new Error("YouTube upload failed: " + JSON.stringify(data));
  return data.id;
}
