# Devvit Hackathon Plan

## Goal
Ship a Devvit app that lets users label posts as "ad/shill" vs "organic" and feeds those labels into the existing Reddit Tracker pipeline to train a first‑party model.

## Non‑Goals (Hackathon Scope)
- No public leaderboard or gamification beyond basic labels.
- No production classifier on Reddit content yet; just data collection.
- No ML training inside Devvit runtime.

## Dependencies
- Devvit CLI + app scaffold.
- Cloudflare Worker endpoints already live:
  - `GET /api/review/next?reviewer=...&include=item&auto=true`
  - `POST /api/review/submit`
- Admin/service token for write access.
- Devvit secrets for the token (not committed).

## Architecture (MVP)
- **Devvit app** (UI + actions) → calls **Cloudflare Worker** endpoints for tasks and label submission.
- **Worker** stores tasks/labels/snapshots in D1 and KV; training happens off‑platform.

## Data Flow
1. Devvit requests next task from Worker.
2. Worker auto‑selects a post when queue is empty.
3. Devvit renders post (title/permalink/preview) + buttons (Yes/No/Skip).
4. On vote, Devvit submits label to Worker with reviewer id + notes.
5. Worker stores label + snapshot for training.

## Hackathon MVP Checklist
- [ ] Scaffold Devvit app project.
- [ ] Create a single screen: post preview + Yes/No/Skip buttons.
- [ ] Implement fetch wrapper to Worker endpoints.
- [ ] Add Devvit secret for service token.
- [ ] Label submission wired to `/api/review/submit`.
- [ ] Basic error handling + retry UI.
- [ ] Minimal analytics logging (counts + last label).

## Implementation Steps
### 1) Devvit Project Setup
- Create new Devvit app.
- Configure permitted external fetch domains if required.
- Add secret: `REDDIT_TRACKER_TOKEN`.

### 2) UI + Actions
- Show post card with title + subreddit + link.
- Buttons:
  - Yes → `likely_shill`
  - No → `likely_organic`
  - Skip → `unclear`
- Display queue status and last submit result.

### 3) Worker Integration
- Use `Authorization: Bearer <token>` for writes.
- Use reviewer id (Devvit user id or “devvit:<username>”).
- Optional: include signal summary if we want to show “why this was selected.”

### 4) Data Hygiene
- Store labels with notes like “devvit”.
- Keep usernames in worker DB; anonymize when exporting datasets.

### 5) Local/Stage Testing
- Devvit dev with remote Worker base URL.
- Validate: enqueue → view → label → next.

## Stretch Goals
- Add “Why this post?” panel (signals).
- Add sampling controls (subreddit, domain, account).
- Add lightweight onboarding tooltip.

## Risks / Mitigations
- **Rate limits / subrequest limits** → keep Worker calls small, use cached tasks.
- **Token leakage** → use Devvit secret storage only.
- **User privacy** → anonymize exported datasets, limit notes.

## Definition of Done
- Devvit app runs and labels posts.
- Labels stored in D1 and visible in dataset export.
- Reviewer workflow stable enough for daily use.
