/**
 * Security-relevant cardinality budgets. These values are intentionally kept
 * together so parser, queue, D1, tests, and methodology cannot drift.
 *
 * The live mpp.dev catalog had a maximum of 107 endpoints on 2026-08-25. A
 * 160-operation document budget leaves measured headroom without permitting an
 * advertised discovery tree to grow without bound.
 */
export const MAX_CATALOG_ENDPOINTS_PER_SERVICE = 160;
export const MAX_OPENAPI_OPERATIONS_PER_DOCUMENT = 160;
export const MAX_OPENAPI_OFFERS_PER_DOCUMENT = 512;
export const MAX_API_CATALOG_LINKS_PER_DOCUMENT = 16;

export const MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE = 160;
export const MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE = 512;
export const MAX_ACTIVE_CRAWL_TARGETS_PER_SERVICE = 192;
export const MAX_RETAINED_CRAWL_TARGETS_PER_SERVICE = 256;

export const SUBMISSION_WINDOW_MS = 5 * 60 * 1_000;
export const MAX_SUBMISSIONS_PER_CLIENT_WINDOW = 6;
export const MAX_SUBMISSIONS_GLOBAL_WINDOW = 120;
export const MAX_RETAINED_MANUAL_CANDIDATES_PER_ORIGIN = 8;
export const MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL = 500;
export const MAX_UNCONFIRMED_MANUAL_ATTEMPTS = 3;
export const MANUAL_CANDIDATE_TTL_MS = 24 * 60 * 60 * 1_000;

// Raw/redacted probe documents and repeat observation rows are operational
// evidence, while normalized state and the change feed are the durable public
// history.  Keeping this policy in code lets Cron cleanup, R2 lifecycle
// configuration, documentation, and tests use the same boundary.
export const OBSERVATION_RETENTION_DAYS = 30;
export const COORDINATION_RETENTION_DAYS = 14;
export const RETENTION_PRUNE_BATCH = 5_000;
