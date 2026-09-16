# Weekly QA review

**What:** every Monday the reconcile worker samples 2% of the previous ISO week's human-answered calls per merchant (at least 1, at most 20) into the staff QA queue (P4-OPS-1, ADR-0010 §11). A person scores each against a fixed rubric. The sample is a hash of the call id and the week: nobody chooses which calls are reviewed, and re-running the job never changes it.

## Doing the reviews

Console → **QA review**. Open a call — this reads the transcript and is **audited against you** (`transcript.accessed`, purpose `qa_review`). Score:

| Rubric item | Fail means |
|---|---|
| AI + recording disclosure first | compliance incident (invariant 7) |
| No order data before identity verified | compliance incident (invariant 17) |
| Followed the approved script (1–5) | script or prompt problem |
| Tone (1–5) | script problem |
| "Stop calling" honoured at once | compliance incident (E-03) |
| Prohibited content (discount, OTP, promise) | compliance incident |
| Extraction matches the conversation | accuracy problem — the outcome or fields recorded are wrong |

**Skip** only when the call cannot be reviewed (media gone, language you cannot judge) and say why. Notes must not contain customer details.

Target: the week's queue is empty by Friday.

## After a review

- **Incident** (the console says so on save): treat it like a complaint. Kill-switch the tenant if the cause could repeat on the next call (`kill-switch.md`), find every call on the same script version, fix the script or prompt, and record what happened in the weekly on-call review.
- **Extraction accuracy below 90%** for a merchant (the table on the QA page, last 28 days): check which outcomes are wrong. A wrong `cancelled`/`confirmed` is a billing problem too — check disputes (`billing-dispute.md`). Fix the extraction schema or the script's branches before the merchant scales.
- Script improvements go to the merchant as a new draft version; with enough volume, run it as an A/B test from the dashboard.

## The job did not run

```sql
select week, count(*), min(sampled_at) from qa_reviews group by week order by week desc limit 4;
```

No row for last week → check the reconcile worker's logs for `weekly QA sample`. The Redis key `qa-sample:<YYYY-Www>` marks the week as taken; if a run crashed it is released and the next tick retries. Merchants with no human-answered calls, or whose media was already purged by retention, have nothing to sample.
