/**
 * Merge Relay — GitHub App webhook handler
 *
 * Env vars (set via wrangler secret):
 *   GITHUB_APP_ID         — numeric App ID from GitHub App settings
 *   GITHUB_PRIVATE_KEY    — PEM private key (full content, newlines as \n)
 *   GITHUB_WEBHOOK_SECRET — webhook secret set when creating the App
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "merge-relay" });
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    const body = await request.text();

    // Verify GitHub webhook signature
    if (!await verifySignature(body, request.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const event = request.headers.get("x-github-event");
    const payload = JSON.parse(body);

    // Only handle workflow_run completed with success
    if (event !== "workflow_run") {
      return Response.json({ ok: true, skipped: `event: ${event}` });
    }
    if (payload.action !== "completed" || payload.workflow_run?.conclusion !== "success") {
      return Response.json({ ok: true, skipped: `conclusion: ${payload.workflow_run?.conclusion}` });
    }
    // Only trigger on push to default branch (not on PR runs)
    if (payload.workflow_run?.event !== "push") {
      return Response.json({ ok: true, skipped: "not a push run" });
    }

    const owner = payload.repository.owner.login;
    const repo = payload.repository.name;
    const baseBranch = payload.repository.default_branch;

    // Process async — return 200 immediately so GitHub doesn't retry
    env.ctx?.waitUntil(processQueue(env, owner, repo, baseBranch));

    return Response.json({ ok: true, queued: `${owner}/${repo}` });
  },
};

// ── GitHub App Auth ───────────────────────────────────────────────────────────

async function generateJWT(appId, privateKeyPem) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: String(appId) }));

  const pem = privateKeyPem.replace(/-----[^-]+-----/g, "").replace(/\s/g, "");
  const keyBytes = Uint8Array.from(atob(pem), c => c.charCodeAt(0));

  const key = await crypto.subtle.importKey(
    "pkcs8", keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5", key,
    new TextEncoder().encode(`${header}.${payload}`)
  );

  return `${header}.${payload}.${b64url(sig)}`;
}

function b64url(data) {
  const str = typeof data === "string" ? btoa(data)
    : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function getInstallationToken(jwt, owner, repo) {
  const headers = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "Merge-Relay/1.0",
  };

  const installResp = await ghFetch(`/repos/${owner}/${repo}/installation`, { headers });
  if (!installResp.ok) return null;
  const { id } = await installResp.json();

  const tokenResp = await ghFetch(`/app/installations/${id}/access_tokens`, {
    method: "POST", headers,
  });
  if (!tokenResp.ok) return null;
  return (await tokenResp.json()).token;
}

// ── Queue Logic ───────────────────────────────────────────────────────────────

async function processQueue(env, owner, repo, baseBranch) {
  try {
    const jwt = await generateJWT(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
    const token = await getInstallationToken(jwt, owner, repo);
    if (!token) {
      console.log(`[merge-relay] No installation found for ${owner}/${repo}`);
      return;
    }

    const headers = {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Merge-Relay/1.0",
      "Content-Type": "application/json",
    };

    // Get open PRs targeting base branch, FIFO order
    const prsResp = await ghFetch(
      `/repos/${owner}/${repo}/pulls?state=open&base=${baseBranch}&sort=created&direction=asc&per_page=20`,
      { headers }
    );
    if (!prsResp.ok) return;
    const prs = await prsResp.json();

    if (prs.length === 0) {
      console.log(`[merge-relay] Queue empty for ${owner}/${repo}`);
      return;
    }

    for (const pr of prs) {
      // Get detailed PR info to check merge state
      const detail = await (await ghFetch(`/repos/${owner}/${repo}/pulls/${pr.number}`, { headers })).json();

      if (detail.mergeable_state === "clean") {
        // Already up-to-date and mergeable — CI will handle the merge
        console.log(`[merge-relay] PR #${pr.number} already clean — skipping`);
        break;
      }

      if (detail.mergeable_state === "behind") {
        console.log(`[merge-relay] Updating PR #${pr.number} (${pr.head.ref})`);

        const updateResp = await ghFetch(
          `/repos/${owner}/${repo}/pulls/${pr.number}/update-branch`,
          {
            method: "PUT",
            headers,
            body: JSON.stringify({ expected_head_sha: detail.head.sha }),
          }
        );

        if (updateResp.status === 202) {
          console.log(`[merge-relay] PR #${pr.number} branch update queued ✓`);
          break; // Process one at a time — next deploy will pick next PR
        }

        if (updateResp.status === 422) {
          // Merge conflict — comment and try next PR
          const err = await updateResp.json();
          await ghFetch(`/repos/${owner}/${repo}/issues/${pr.number}/comments`, {
            method: "POST",
            headers,
            body: JSON.stringify({
              body: `⚠️ **Merge Relay**: conflict when updating from \`${baseBranch}\`. Manual resolution needed.\n> ${err.message || "merge conflict"}`,
            }),
          });
          console.log(`[merge-relay] PR #${pr.number} conflict — skipped, trying next`);
          continue;
        }
      }
    }
  } catch (err) {
    console.error(`[merge-relay] Error processing ${owner}/${repo}:`, err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function ghFetch(path, opts = {}) {
  return fetch(`https://api.github.com${path}`, opts);
}

async function verifySignature(body, sig, secret) {
  if (!secret) return true; // dev mode
  if (!sig) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const expected = "sha256=" + Array.from(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))
  ).map(b => b.toString(16).padStart(2, "0")).join("");
  return sig === expected;
}
