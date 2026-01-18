# Devvit Readiness Plan (Post‑MVP)

## Summary
Move from MVP labeling to a production‑ready Devvit experience that can surface likely ad/shill accounts, maintain a top‑1,000 leaderboard, and feed labels into the external training pipeline.

## Answers to Key Questions
- **Classifier in production?** Yes, for recommendations/suggestions. It can start as a heuristic scorer and later swap to the trained model.
- **Training outside Devvit?** Yes. Devvit only collects labels; training runs in our own pipeline.

## System Components
- **Devvit App**: UI + labeling, leaderboard view.
- **Worker API**: tasks, labels, leaderboard, model scores.
- **Model Pipeline**: offline training, evaluation, model export.
- **Storage**: D1 for labels/features; optional model artifact store.

## Leaderboard (Top 1,000)
### Definition
Rank accounts by the number of labels marking them as `likely_shill`, with optional weighting by confidence and reviewer reputation.

### Data Model (Worker/D1)
- `review_labels`: already stores label, reviewer, confidence.
- Add materialized view or aggregate query:
  - `shill_votes = SUM(label == likely_shill)`
  - `organic_votes = SUM(label == likely_organic)`
  - `net_score = shill_votes - organic_votes`
  - `rank by net_score DESC, shill_votes DESC`

### API Endpoint (Worker)
- `GET /api/leaderboard?limit=1000`
  - returns `account_id`, `shill_votes`, `organic_votes`, `net_score`.

## Production Classifier
### Phase 1: Heuristic
Use existing signals (domain/subreddit concentration, URL reuse, comment ratio).

### Phase 2: Trained Model
- Train offline from labels + signals.
- Export model artifact + feature list.
- Deploy scorer in Worker (simple logistic regression) or external service.

### Phase 3: Active Learning
Use model confidence to prioritize which posts/accounts Devvit surfaces.

## Devvit UI Additions
- **Leaderboard view**: top 1,000 accounts + vote counts.
- **“Why shown?”** summary (signals + prior labels).
- **Batch mode**: rapid labeling flow for power users.

## Security & Privacy
- Require Devvit authentication before users can access the game.
- Only Devvit can submit labels; require `ADMIN_TOKEN` or service token.
- Anonymize exports via salt; do not publish raw usernames in datasets.
- Rate‑limit label submissions.

## Operational Checklist
- [ ] Devvit app connected to Worker with secret token.
- [ ] Leaderboard endpoint implemented + tested.
- [ ] Heuristic or model score endpoint available.
- [ ] Offline training script documented and repeatable.
- [ ] Dataset export anonymized by default.
- [ ] Basic monitoring (success/fail counts).

## Open Decisions
- Do we weight votes by reviewer trust?
- How often do we refresh leaderboard?
- Where do we store model artifacts (D1 vs object storage)?
