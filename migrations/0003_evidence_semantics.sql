-- Optional discovery paths being absent is useful evidence, but it is not a
-- failed security validation. Scanner policy refusals likewise describe why
-- the observatory stopped; they are not endpoint failures.
UPDATE security_properties
SET state = 'observed',
    basis = 'scanner policy decision'
WHERE property_key = 'probe_safety'
  AND state = 'tested-fail';

UPDATE security_properties
SET state = 'observed'
WHERE property_key IN ('openapi_parse', 'api_catalog_parse')
  AND state = 'tested-fail'
  AND (
    evidence LIKE '%returned HTTP 404%'
    OR evidence LIKE '%returned HTTP 410%'
    OR evidence LIKE 'Credential-shaped discovery URL%'
  );

-- Older challenge failures retained the count and HTTP status but not whether
-- the failure was structural or the required 402 status. Recrawls replace
-- this neutral note with the exact validation reason.
UPDATE security_properties
SET evidence = evidence || '; challenge validation failed; a fresh observation will record the exact reason'
WHERE property_key = 'challenge_parse'
  AND state = 'tested-fail'
  AND evidence NOT LIKE '%challenge validation failed%'
  AND evidence NOT LIKE '%invalid structure:%';

-- The public evidence-state filter starts with state, then joins by service.
CREATE INDEX IF NOT EXISTS idx_security_state_service
ON security_properties(state, service_id);
