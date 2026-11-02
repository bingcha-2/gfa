import {
  createUser,
  getUserByUsername,
  listUserKeys,
  userCount,
} from "./db.mjs";

const command = process.argv[2];

if (!["create", "sync-anthropic"].includes(command)) {
  console.error("usage: node admin-cli.mjs <create|sync-anthropic>");
  process.exit(2);
}

const username = process.env.BINGCHA_CLI_USERNAME;

if (command === "sync-anthropic") {
  if (!username) {
    console.error("BINGCHA_CLI_USERNAME is required");
    process.exit(2);
  }
  const user = getUserByUsername(username);
  if (!user) {
    console.error("user not found");
    process.exit(1);
  }
  const upstreamApi = String(
    process.env.UPSTREAM_API || "http://185.150.191.36:61100",
  ).replace(/\/+$/, "");
  const sharedUpstreamUsername = String(
    process.env.SHARED_UPSTREAM_USERNAME || "userbingcha2",
  ).trim();
  const keys = listUserKeys(user.id, "anthropic").map((item) => item.key);
  if (!keys.length) {
    console.log(JSON.stringify({ username: user.username, queried: 0, displayed: 0 }));
    process.exit(0);
  }
  const response = await fetch(`${upstreamApi}/api/usage/anthropic`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      key_list: keys.join("\n"),
      date: "",
      hour: "",
      minute: "",
      username: sharedUpstreamUsername,
    }),
  });
  if (!response.ok || !response.body) {
    console.error(`upstream sync failed: ${response.status}`);
    process.exit(1);
  }

  let queried = 0;
  let displayed = 0;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event?.type === "item") displayed += 1;
        if (event?.type === "done") queried = Number(event.queried || keys.length);
      } catch {
        // Ignore malformed progress events.
      }
    }
  }
  console.log(JSON.stringify({ username: user.username, queried, displayed }));
  process.exit(0);
}

const password = process.env.BINGCHA_CLI_PASSWORD;
const role = process.env.BINGCHA_CLI_ROLE || "user";
const upstreamNamespace = process.env.BINGCHA_CLI_NAMESPACE;

if (!username || !password || !upstreamNamespace) {
  console.error("BINGCHA_CLI_USERNAME, BINGCHA_CLI_PASSWORD and BINGCHA_CLI_NAMESPACE are required");
  process.exit(2);
}

const existing = getUserByUsername(username);
if (existing) {
  console.log(JSON.stringify({ created: false, user: existing, userCount: userCount() }));
  process.exit(0);
}

const user = createUser({
  username,
  password,
  role,
  upstreamNamespace,
});
console.log(JSON.stringify({ created: true, user, userCount: userCount() }));
