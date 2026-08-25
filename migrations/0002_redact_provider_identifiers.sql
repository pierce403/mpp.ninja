-- Backfill the provider identifier observed before structured redaction knew
-- this key. Future data is handled before R2/D1 persistence; these bounded
-- paths cover the challenge and normalized-offer shapes already stored by the
-- production schema. Payment-offer updates can emit history, so changes are
-- scrubbed last.

UPDATE observations
SET challenge_json = json_remove(
  challenge_json,
  '$[0].request.stripe_payment_intent_id', '$[0].request.stripePaymentIntentId', '$[0].request.extra.stripe_payment_intent_id', '$[0].request.extra.stripePaymentIntentId', '$[0].request.methodDetails.stripe_payment_intent_id', '$[0].request.methodDetails.stripePaymentIntentId',
  '$[1].request.stripe_payment_intent_id', '$[1].request.stripePaymentIntentId', '$[1].request.extra.stripe_payment_intent_id', '$[1].request.extra.stripePaymentIntentId', '$[1].request.methodDetails.stripe_payment_intent_id', '$[1].request.methodDetails.stripePaymentIntentId',
  '$[2].request.stripe_payment_intent_id', '$[2].request.stripePaymentIntentId', '$[2].request.extra.stripe_payment_intent_id', '$[2].request.extra.stripePaymentIntentId', '$[2].request.methodDetails.stripe_payment_intent_id', '$[2].request.methodDetails.stripePaymentIntentId',
  '$[3].request.stripe_payment_intent_id', '$[3].request.stripePaymentIntentId', '$[3].request.extra.stripe_payment_intent_id', '$[3].request.extra.stripePaymentIntentId', '$[3].request.methodDetails.stripe_payment_intent_id', '$[3].request.methodDetails.stripePaymentIntentId',
  '$[4].request.stripe_payment_intent_id', '$[4].request.stripePaymentIntentId', '$[4].request.extra.stripe_payment_intent_id', '$[4].request.extra.stripePaymentIntentId', '$[4].request.methodDetails.stripe_payment_intent_id', '$[4].request.methodDetails.stripePaymentIntentId',
  '$[5].request.stripe_payment_intent_id', '$[5].request.stripePaymentIntentId', '$[5].request.extra.stripe_payment_intent_id', '$[5].request.extra.stripePaymentIntentId', '$[5].request.methodDetails.stripe_payment_intent_id', '$[5].request.methodDetails.stripePaymentIntentId',
  '$[6].request.stripe_payment_intent_id', '$[6].request.stripePaymentIntentId', '$[6].request.extra.stripe_payment_intent_id', '$[6].request.extra.stripePaymentIntentId', '$[6].request.methodDetails.stripe_payment_intent_id', '$[6].request.methodDetails.stripePaymentIntentId',
  '$[7].request.stripe_payment_intent_id', '$[7].request.stripePaymentIntentId', '$[7].request.extra.stripe_payment_intent_id', '$[7].request.extra.stripePaymentIntentId', '$[7].request.methodDetails.stripe_payment_intent_id', '$[7].request.methodDetails.stripePaymentIntentId'
)
WHERE challenge_json IS NOT NULL
  AND json_valid(challenge_json)
  AND (instr(lower(challenge_json), 'stripe_payment_intent_id') > 0 OR instr(lower(challenge_json), 'stripepaymentintentid') > 0);

UPDATE payment_offers
SET session_json = json_remove(
  session_json,
  '$.stripe_payment_intent_id', '$.stripePaymentIntentId',
  '$.extra.stripe_payment_intent_id', '$.extra.stripePaymentIntentId',
  '$.methodDetails.stripe_payment_intent_id', '$.methodDetails.stripePaymentIntentId'
)
WHERE session_json IS NOT NULL
  AND json_valid(session_json)
  AND (instr(lower(session_json), 'stripe_payment_intent_id') > 0 OR instr(lower(session_json), 'stripepaymentintentid') > 0);

UPDATE source_snapshot_offer_stage
SET session_json = json_remove(
  session_json,
  '$.stripe_payment_intent_id', '$.stripePaymentIntentId',
  '$.extra.stripe_payment_intent_id', '$.extra.stripePaymentIntentId',
  '$.methodDetails.stripe_payment_intent_id', '$.methodDetails.stripePaymentIntentId'
)
WHERE session_json IS NOT NULL
  AND json_valid(session_json)
  AND (instr(lower(session_json), 'stripe_payment_intent_id') > 0 OR instr(lower(session_json), 'stripepaymentintentid') > 0);

UPDATE changes
SET old_value = CASE WHEN json_valid(old_value) THEN json_remove(
      old_value,
      '$.stripe_payment_intent_id', '$.stripePaymentIntentId',
      '$.extra.stripe_payment_intent_id', '$.extra.stripePaymentIntentId',
      '$.methodDetails.stripe_payment_intent_id', '$.methodDetails.stripePaymentIntentId',
      '$.session.stripe_payment_intent_id', '$.session.stripePaymentIntentId',
      '$.session.extra.stripe_payment_intent_id', '$.session.extra.stripePaymentIntentId',
      '$.session.methodDetails.stripe_payment_intent_id', '$.session.methodDetails.stripePaymentIntentId'
    ) ELSE old_value END,
    new_value = CASE WHEN json_valid(new_value) THEN json_remove(
      new_value,
      '$.stripe_payment_intent_id', '$.stripePaymentIntentId',
      '$.extra.stripe_payment_intent_id', '$.extra.stripePaymentIntentId',
      '$.methodDetails.stripe_payment_intent_id', '$.methodDetails.stripePaymentIntentId',
      '$.session.stripe_payment_intent_id', '$.session.stripePaymentIntentId',
      '$.session.extra.stripe_payment_intent_id', '$.session.extra.stripePaymentIntentId',
      '$.session.methodDetails.stripe_payment_intent_id', '$.session.methodDetails.stripePaymentIntentId'
    ) ELSE new_value END
WHERE instr(lower(COALESCE(old_value, '')), 'stripe_payment_intent_id') > 0
   OR instr(lower(COALESCE(old_value, '')), 'stripepaymentintentid') > 0
   OR instr(lower(COALESCE(new_value, '')), 'stripe_payment_intent_id') > 0
   OR instr(lower(COALESCE(new_value, '')), 'stripepaymentintentid') > 0;
