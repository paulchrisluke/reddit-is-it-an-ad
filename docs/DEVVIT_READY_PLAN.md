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
Rank accounts by likely‑shill signals with a minimum vote threshold. Avoid net‑score inversions by using a shill‑ratio with a minimum vote count (e.g., rank by `shill_ratio` then `shill_votes`, require `total_votes >= 10`).

### Data Model (Worker/D1)
- `review_labels`: already stores label, reviewer, confidence.
- Add materialized view or aggregate query:
  - `shill_votes = SUM(label == likely_shill)`
  - `organic_votes = SUM(label == likely_organic)`
  - `total_votes = shill_votes + organic_votes`
  - `shill_ratio = shill_votes / total_votes`
  - `rank by shill_ratio DESC, shill_votes DESC`

### API Endpoint (Worker)
- `GET /api/leaderboard?limit=1000&cursor=...`
  - returns `account_hash`, `shill_votes`, `organic_votes`, `total_votes`, `shill_ratio`.
  - authenticated if the leaderboard is non‑public; otherwise ship anonymized identifiers only.

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
- Tokens: short‑lived service token for Devvit; rotate on a schedule; revoke on incident.
- HTTPS‑only for all Worker requests.
- Notes: prefer predefined tags; if free‑text is allowed, warn “no PII” and strip obvious PII.
- Reviewer id: standardize to `devvit:<username>`.
- Anonymize exports via salted hash (e.g., `SHA256(account_id + secret_salt)`); do not publish raw usernames in datasets.
- Data retention: document label retention window and deletion policy.
- Rate‑limit label submissions (e.g., 100 labels/hour per reviewer).

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
