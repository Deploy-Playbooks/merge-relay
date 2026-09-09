# Merge Relay

GitHub App that automatically manages PR merge queue. When a deploy completes, picks the next open PR, merges the base branch into it — triggering CI. When CI passes, the PR auto-merges.

**No tokens needed for users** — just install the app on your repo.

## How it works

```
Your deploy completes (push to main)
        ↓
GitHub sends workflow_run webhook → Merge Relay Worker
        ↓
Worker picks oldest open PR in your repo (FIFO queue)
        ↓
Merges base branch into PR branch (server-side, no code checkout)
        ↓
Push triggers CI in your repo automatically
        ↓
CI passes → auto-merge job in your ci.yml squash-merges
        ↓
New deploy → webhook → next PR in queue
```

## Install

→ [Install Merge Relay](https://github.com/apps/merge-relay)

Select which repos to give access to. Done — no config files, no secrets, no workflow changes needed.

## Optional: auto-merge job in your CI

Add this job to your CI workflow so PRs auto-merge when CI passes:

```yaml
auto-merge:
  needs: [your-ci-job]          # replace with your actual CI job name
  if: success() && github.event_name == 'pull_request'
  runs-on: ubuntu-latest
  steps:
    - name: Merge if up-to-date
      run: |
        PR=${{ github.event.pull_request.number }}
        BEHIND=$(gh pr view $PR --json behindBy -q .behindBy)
        if [ "$BEHIND" = "0" ]; then
          gh pr merge $PR --squash --delete-branch
        fi
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Without this job, Merge Relay still updates branches — but you merge PRs manually.

## Conflict resolution

If a conflict is detected, Merge Relay:
1. Skips the conflicting PR
2. Posts a comment: `⚠️ Merge Relay: conflict when updating from main. Manual resolution needed.`
3. Tries the next PR in queue

Future: automatic conflict resolution via LLM (Claude Haiku).

## Self-hosting

```bash
git clone https://github.com/Deploy-Playbooks/merge-relay
cd merge-relay

# Set secrets
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_PRIVATE_KEY
wrangler secret put GITHUB_WEBHOOK_SECRET

# Deploy
wrangler deploy
```

## Claude Code Instructions

Single Cloudflare Worker in `src/worker.js`. No build step, no dependencies.

- Auth: GitHub App JWT (RS256) → installation token per repo
- Queue: FIFO by PR creation date, one PR processed per deploy event
- Conflict: comment + skip, try next PR
- Secrets: `GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` via wrangler
