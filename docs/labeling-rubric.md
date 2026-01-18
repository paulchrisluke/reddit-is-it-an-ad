# Labeling Rubric: "Is It an Ad?"

This rubric defines how to label posts and accounts for the "Is it an ad?" game. The goal is consistent ground truth for model training.

## Labels and mapping

- **likely_shill** (game button: "Yes, it is an ad"): The post feels promotional or coordinated.
- **likely_organic** (game button: "No, it is organic"): The post feels like normal user behavior.
- **unclear** (not in the current UI): Use when evidence is mixed or insufficient.

## Primary indicators for "Yes"

- Direct product or brand promotion with a clear call to action.
- Repeated use of the same external URL or domain across posts.
- Very narrow topic focus combined with high posting cadence.
- Templated or marketing-like language, coupon codes, or affiliate framing.
- Links that appear across multiple accounts in a short window.
- Low conversation signals (mostly links, minimal comments or engagement).

## Indicators for "No"

- Personal story or discussion without a call to action.
- Diverse subreddits and topics over time.
- Comments and participation beyond posting links.
- Links are varied, not repeated, and not brand-focused.
- Posts read like community content, memes, or genuine questions.

## When to use "Unclear"

- News sharing without obvious promotion.
- Posts with minimal context or single brand mention.
- Insufficient account history or mixed signals.

## Notes to capture (when possible)

- Suspected brand or domain.
- Repeated URLs or subreddits.
- Any pattern that influenced the decision.

## Review tips

- If available, scan the author's recent history for URL repetition and subreddit focus.
- Focus on intent: promotion and coordination matter more than a single link.
