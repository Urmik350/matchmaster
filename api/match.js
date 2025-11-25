export default async function handler(req, res) {
  const { matchId } = req.query;

  if (!matchId) {
    res.status(400).json({ error: "Missing matchId" });
    return;
  }

  const apiKey = process.env.FOOTBALL_DATA_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "API key not configured" });
    return;
  }

  const url = `https://api.football-data.org/v4/matches/${matchId}`;

  try {
    const upstreamRes = await fetch(url, {
      headers: {
        "X-Auth-Token": apiKey,
      },
    });

    if (!upstreamRes.ok) {
      const text = await upstreamRes.text();
      console.error(text);
      res.status(500).json({ error: "Upstream API error" });
      return;
    }

    const data = await upstreamRes.json();
    res.status(200).json(data.match || data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Request failed" });
  }
}
