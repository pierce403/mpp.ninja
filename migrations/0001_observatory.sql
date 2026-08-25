PRAGMA foreign_keys = ON;

CREATE TABLE services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  homepage_url TEXT,
  service_url TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  categories_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  implementation TEXT NOT NULL DEFAULT 'unknown',
  implementation_confidence REAL NOT NULL DEFAULT 0,
  fingerprint_evidence_json TEXT NOT NULL DEFAULT '[]',
  fingerprint_observed_at TEXT,
  published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
  catalog_ingest_at TEXT,
  openapi_ingest_at TEXT,
  catalog_seen_at TEXT,
  openapi_seen_at TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_probe_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE endpoints (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paid-api',
  description TEXT NOT NULL DEFAULT '',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_probe_at TEXT,
  last_status INTEGER,
  content_type TEXT,
  tls_state TEXT NOT NULL DEFAULT 'not-tested',
  redirect_count INTEGER,
  challenge_format TEXT,
  published INTEGER NOT NULL DEFAULT 1 CHECK (published IN (0,1)),
  catalog_seen_at TEXT,
  openapi_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(service_id, url, http_method)
);

CREATE TABLE endpoint_sources (
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT 'legacy',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY(endpoint_id, source_type, source_ref)
);

CREATE TABLE payment_offers (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL REFERENCES endpoints(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  intent TEXT NOT NULL,
  currency TEXT,
  chain_id TEXT,
  recipient TEXT,
  amount TEXT,
  decimals INTEGER,
  unit_type TEXT,
  session_json TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT 'legacy',
  source_ordinal INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  observed_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(service_id, source_kind, source_url)
);

CREATE TABLE observations (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  endpoint_id TEXT REFERENCES endpoints(id) ON DELETE SET NULL,
  observed_at TEXT NOT NULL,
  request_method TEXT NOT NULL,
  requested_url TEXT NOT NULL,
  final_url TEXT,
  status INTEGER,
  headers_json TEXT NOT NULL DEFAULT '{}',
  challenge_json TEXT,
  dns_json TEXT,
  tls_json TEXT,
  redirect_count INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL DEFAULT 0,
  body_sha256 TEXT NOT NULL DEFAULT '',
  raw_r2_key TEXT,
  error_code TEXT,
  error_detail TEXT
);

CREATE TABLE security_properties (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  endpoint_id TEXT REFERENCES endpoints(id) ON DELETE CASCADE,
  property_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('observed','inferred','tested-pass','tested-fail','unknown','not-tested')),
  evidence TEXT NOT NULL,
  basis TEXT NOT NULL,
  advisory_ref TEXT,
  observed_at TEXT NOT NULL,
  UNIQUE(service_id, endpoint_id, property_key)
);

CREATE TABLE changes (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  endpoint_id TEXT REFERENCES endpoints(id) ON DELETE SET NULL,
  changed_at TEXT NOT NULL,
  change_type TEXT NOT NULL,
  field_name TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  evidence TEXT NOT NULL
);

CREATE TABLE source_snapshots (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog','openapi','api-catalog')),
  source_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  expected_items INTEGER NOT NULL CHECK (expected_items >= 0 AND expected_items <= 10000),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','complete','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  error_detail TEXT
);

CREATE TABLE source_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, item_id)
);

-- Catalog and OpenAPI records are staged until every bounded item in a
-- document snapshot has completed. Reconciliation publishes the staged rows,
-- source membership, withdrawals, history triggers, and snapshot state in one
-- D1 batch, so public readers see the old document or the new document but
-- never a partially processed mixture.
CREATE TABLE source_snapshot_service_stage (
  snapshot_id TEXT PRIMARY KEY REFERENCES source_snapshots(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  name TEXT,
  homepage_url TEXT,
  service_url TEXT,
  origin TEXT,
  description TEXT,
  categories_json TEXT,
  tags_json TEXT,
  status TEXT,
  full_replace INTEGER NOT NULL DEFAULT 0 CHECK (full_replace IN (0,1))
);

CREATE TABLE source_snapshot_endpoint_stage (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  endpoint_id TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  http_method TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog','openapi')),
  source_ref TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, endpoint_id)
);

CREATE TABLE source_snapshot_offer_stage (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  offer_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  intent TEXT NOT NULL,
  currency TEXT,
  chain_id TEXT,
  recipient TEXT,
  amount TEXT,
  decimals INTEGER,
  unit_type TEXT,
  session_json TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog','openapi')),
  source_ref TEXT NOT NULL,
  source_ordinal INTEGER NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY(snapshot_id, offer_id)
);

CREATE TRIGGER service_discovery_history
AFTER INSERT ON services
WHEN NEW.published=1
BEGIN
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.first_seen,'service-discovered','service',NULL,'created','normalized discovery source');
END;

CREATE TRIGGER service_publication_history
AFTER UPDATE OF published ON services
WHEN OLD.published=0 AND NEW.published=1
BEGIN
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (lower(hex(randomblob(16))),NEW.id,NEW.last_seen,'service-discovered','service',NULL,'created','completed normalized source snapshot');
END;

CREATE TRIGGER service_metadata_history
AFTER UPDATE OF name,homepage_url,service_url,description,categories_json,tags_json,status ON services
BEGIN
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','name',OLD.name,NEW.name,'clock-guarded source update' WHERE OLD.name IS NOT NEW.name AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','homepage_url',OLD.homepage_url,NEW.homepage_url,'clock-guarded source update' WHERE OLD.homepage_url IS NOT NEW.homepage_url AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','service_url',OLD.service_url,NEW.service_url,'clock-guarded source update' WHERE OLD.service_url IS NOT NEW.service_url AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','description',OLD.description,NEW.description,'clock-guarded source update' WHERE OLD.description IS NOT NEW.description AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','categories',OLD.categories_json,NEW.categories_json,'clock-guarded source update' WHERE OLD.categories_json IS NOT NEW.categories_json AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','tags',OLD.tags_json,NEW.tags_json,'clock-guarded source update' WHERE OLD.tags_json IS NOT NEW.tags_json AND NEW.published=1;
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'service-updated','status',OLD.status,NEW.status,'clock-guarded source update' WHERE OLD.status IS NOT NEW.status AND NEW.published=1;
END;

CREATE TRIGGER service_fingerprint_history
AFTER UPDATE OF implementation,implementation_confidence,fingerprint_evidence_json,fingerprint_observed_at ON services
WHEN OLD.implementation IS NOT NEW.implementation OR OLD.implementation_confidence IS NOT NEW.implementation_confidence OR OLD.fingerprint_evidence_json IS NOT NEW.fingerprint_evidence_json
BEGIN
  INSERT INTO changes (id,service_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (lower(hex(randomblob(16))),NEW.id,COALESCE(NEW.fingerprint_observed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'fingerprint-changed','implementation',OLD.implementation || ':' || OLD.implementation_confidence,NEW.implementation || ':' || NEW.implementation_confidence,NEW.fingerprint_evidence_json);
END;

CREATE TRIGGER endpoint_discovery_history
AFTER INSERT ON endpoints
WHEN NEW.published=1
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.first_seen,'endpoint-discovered','endpoint',NULL,'created','normalized discovery source');
END;

CREATE TRIGGER endpoint_publication_history
AFTER UPDATE OF published ON endpoints
WHEN OLD.published=0 AND NEW.published=1
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_seen,'endpoint-discovered','endpoint',NULL,'created','completed normalized source snapshot');
END;

CREATE TRIGGER endpoint_metadata_history
AFTER UPDATE OF url,http_method,path,description ON endpoints
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'endpoint-updated','url',OLD.url,NEW.url,'clock-guarded source update' WHERE OLD.url IS NOT NEW.url AND NEW.published=1;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'endpoint-updated','http_method',OLD.http_method,NEW.http_method,'clock-guarded source update' WHERE OLD.http_method IS NOT NEW.http_method AND NEW.published=1;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'endpoint-updated','path',OLD.path,NEW.path,'clock-guarded source update' WHERE OLD.path IS NOT NEW.path AND NEW.published=1;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,COALESCE(CASE WHEN NEW.catalog_seen_at IS NOT OLD.catalog_seen_at THEN NEW.catalog_seen_at WHEN NEW.openapi_seen_at IS NOT OLD.openapi_seen_at THEN NEW.openapi_seen_at END,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'endpoint-updated','description',OLD.description,NEW.description,'clock-guarded source update' WHERE OLD.description IS NOT NEW.description AND NEW.published=1;
END;

CREATE TRIGGER endpoint_probe_history
AFTER UPDATE OF last_status,content_type,tls_state,redirect_count,challenge_format ON endpoints
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_probe_at,'probe-observation','last_status',OLD.last_status,NEW.last_status,'harmless unauthenticated HTTP observation' WHERE OLD.last_status IS NOT NEW.last_status;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_probe_at,'probe-observation','content_type',OLD.content_type,NEW.content_type,'harmless unauthenticated HTTP observation' WHERE OLD.content_type IS NOT NEW.content_type;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_probe_at,'probe-observation','tls_state',OLD.tls_state,NEW.tls_state,'harmless unauthenticated HTTP observation' WHERE OLD.tls_state IS NOT NEW.tls_state;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_probe_at,'probe-observation','redirect_count',OLD.redirect_count,NEW.redirect_count,'harmless unauthenticated HTTP observation' WHERE OLD.redirect_count IS NOT NEW.redirect_count;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence) SELECT lower(hex(randomblob(16))),NEW.service_id,NEW.id,NEW.last_probe_at,'probe-observation','challenge_format',OLD.challenge_format,NEW.challenge_format,'harmless unauthenticated HTTP observation' WHERE OLD.challenge_format IS NOT NEW.challenge_format;
END;

CREATE TRIGGER payment_offer_discovery_history
AFTER INSERT ON payment_offers
WHEN NEW.active=1
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  SELECT lower(hex(randomblob(16))), e.service_id, NEW.endpoint_id, CASE WHEN NEW.observed_at='' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NEW.observed_at END,
    'payment-offer-discovered', 'offer', NULL,
    json_object('method',NEW.method,'intent',NEW.intent,'currency',NEW.currency,'chainId',NEW.chain_id,'recipient',NEW.recipient,'amount',NEW.amount,'decimals',NEW.decimals,'unitType',NEW.unit_type,'session',json(NEW.session_json),'sourceType',NEW.source_type,'sourceRef',NEW.source_ref,'sourceOrdinal',NEW.source_ordinal),
    NEW.source_type || ' payment metadata'
  FROM endpoints e WHERE e.id=NEW.endpoint_id;
END;

CREATE TRIGGER payment_offer_active_history
AFTER UPDATE OF active ON payment_offers
WHEN OLD.active<>NEW.active
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  SELECT lower(hex(randomblob(16))), e.service_id, NEW.endpoint_id, CASE WHEN NEW.observed_at='' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NEW.observed_at END,
    CASE WHEN NEW.active=1 AND NEW.first_seen=NEW.last_seen THEN 'payment-offer-discovered' WHEN NEW.active=1 THEN 'payment-offer-restored' ELSE 'payment-offer-withdrawn' END,
    'offer-active', CAST(OLD.active AS TEXT), CAST(NEW.active AS TEXT),
    NEW.source_type || ' source ' || NEW.source_ref
  FROM endpoints e WHERE e.id=NEW.endpoint_id;
END;

CREATE TRIGGER endpoint_source_discovery_history
AFTER INSERT ON endpoint_sources
WHEN NEW.active=1
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  SELECT lower(hex(randomblob(16))), e.service_id, NEW.endpoint_id, CASE WHEN NEW.observed_at='' THEN NEW.last_seen ELSE NEW.observed_at END,
    'endpoint-source-discovered', 'source:' || NEW.source_type, NULL, 'active', NEW.source_ref
  FROM endpoints e WHERE e.id=NEW.endpoint_id;
END;

CREATE TRIGGER endpoint_source_active_history
AFTER UPDATE OF active ON endpoint_sources
WHEN OLD.active<>NEW.active
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  SELECT lower(hex(randomblob(16))), e.service_id, NEW.endpoint_id, CASE WHEN NEW.observed_at='' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE NEW.observed_at END,
    CASE WHEN NEW.active=1 AND NEW.first_seen=NEW.last_seen THEN 'endpoint-source-discovered' WHEN NEW.active=1 THEN 'endpoint-source-restored' ELSE 'endpoint-source-withdrawn' END,
    'source:' || NEW.source_type, CAST(OLD.active AS TEXT), CAST(NEW.active AS TEXT), NEW.source_ref
  FROM endpoints e WHERE e.id=NEW.endpoint_id;
END;

CREATE TRIGGER payment_offer_update_history
AFTER UPDATE OF method,intent,currency,chain_id,recipient,amount,decimals,unit_type,session_json ON payment_offers
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','method',OLD.method,NEW.method,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.method IS NOT NEW.method;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','intent',OLD.intent,NEW.intent,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.intent IS NOT NEW.intent;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','currency',OLD.currency,NEW.currency,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.currency IS NOT NEW.currency;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','chain_id',OLD.chain_id,NEW.chain_id,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.chain_id IS NOT NEW.chain_id;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','recipient',OLD.recipient,NEW.recipient,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.recipient IS NOT NEW.recipient;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','amount',OLD.amount,NEW.amount,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.amount IS NOT NEW.amount;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','decimals',OLD.decimals,NEW.decimals,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.decimals IS NOT NEW.decimals;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','unit_type',OLD.unit_type,NEW.unit_type,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.unit_type IS NOT NEW.unit_type;
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
    SELECT lower(hex(randomblob(16))),e.service_id,NEW.endpoint_id,NEW.last_seen,'payment-offer-updated','session_json',OLD.session_json,NEW.session_json,NEW.source_type || ' payment metadata' FROM endpoints e WHERE e.id=NEW.endpoint_id AND OLD.session_json IS NOT NEW.session_json;
END;

CREATE TRIGGER security_property_change_history
AFTER UPDATE OF state,evidence,basis ON security_properties
WHEN OLD.state<>NEW.state OR OLD.evidence<>NEW.evidence OR OLD.basis<>NEW.basis
BEGIN
  INSERT INTO changes (id,service_id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence)
  VALUES (
    lower(hex(randomblob(16))), NEW.service_id, NEW.endpoint_id, NEW.observed_at,
    'security-property-changed', 'security:' || NEW.property_key,
    json_object('state',OLD.state,'evidence',OLD.evidence,'basis',OLD.basis),
    json_object('state',NEW.state,'evidence',NEW.evidence,'basis',NEW.basis),
    'Repeated harmless observation changed the modeled property'
  );
END;

CREATE TABLE submissions (
  normalized_url TEXT PRIMARY KEY,
  origin TEXT NOT NULL,
  service_id TEXT REFERENCES services(id) ON DELETE SET NULL,
  submitted_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  candidate_expires_at TEXT NOT NULL,
  confirmed_at TEXT,
  source_note TEXT,
  last_error TEXT
);

CREATE TABLE submission_rate_windows (
  window_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL
);

CREATE TABLE crawl_targets (
  id TEXT PRIMARY KEY,
  normalized_url TEXT NOT NULL,
  service_id TEXT REFERENCES services(id) ON DELETE CASCADE,
  endpoint_id TEXT REFERENCES endpoints(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  generation INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  run_observed_at TEXT,
  processing_token TEXT,
  processing_expires_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_due_at TEXT,
  last_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE origin_rate_limits (
  origin TEXT PRIMARY KEY,
  next_allowed_at TEXT NOT NULL,
  last_dns_hash TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE discovery_runs (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL,
  source_url TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  expected_services INTEGER NOT NULL DEFAULT 0,
  discovered_services INTEGER NOT NULL DEFAULT 0,
  discovered_endpoints INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT
);

CREATE TABLE discovery_run_services (
  run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(run_id, service_id)
);

CREATE TABLE crawl_target_sources (
  target_id TEXT NOT NULL REFERENCES crawl_targets(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog','openapi','api-catalog','manual','mppscan')),
  source_ref TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  PRIMARY KEY(target_id, source_type, source_ref)
);

-- Network authority discovered inside a split catalog/OpenAPI barrier is not
-- live until that barrier publishes. The inert crawl_target row reserves the
-- retained-target slot; this table reserves active capacity and supplies the
-- provenance that reconciliation activates atomically with normalized data.
CREATE TABLE source_snapshot_target_stage (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  normalized_url TEXT NOT NULL,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  endpoint_id TEXT,
  target_kind TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('catalog','openapi','api-catalog')),
  source_ref TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  introduced INTEGER NOT NULL DEFAULT 0 CHECK (introduced IN (0,1)),
  PRIMARY KEY(snapshot_id, target_id)
);

CREATE INDEX source_snapshot_target_stage_service
ON source_snapshot_target_stage(service_id, target_id);

CREATE TRIGGER crawl_target_stage_activation_budget
BEFORE INSERT ON source_snapshot_target_stage
WHEN NOT EXISTS (
    SELECT 1 FROM crawl_targets current
    WHERE current.id=NEW.target_id
      AND current.status NOT IN ('retired','rejected')
      AND (
        NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=current.id)
        OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=current.id AND active_source.active=1)
      )
  )
  AND (
    (SELECT COUNT(*) FROM crawl_targets active_target
      WHERE active_target.service_id=NEW.service_id
        AND active_target.status NOT IN ('retired','rejected')
        AND (
          NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
          OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)
        ))
    +
    (SELECT COUNT(DISTINCT staged.target_id) FROM source_snapshot_target_stage staged
      WHERE staged.service_id=NEW.service_id AND staged.target_id<>NEW.target_id
        AND NOT EXISTS (
          SELECT 1 FROM crawl_targets active_staged
          WHERE active_staged.id=staged.target_id
            AND active_staged.status NOT IN ('retired','rejected')
            AND (
              NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_staged.id)
              OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_staged.id AND active_source.active=1)
            )
        ))
  )>=192
BEGIN
  SELECT RAISE(ABORT,'crawl target staging budget exceeded');
END;

-- These storage-level limits mirror src/budgets.ts. Application checks give a
-- useful result; triggers keep concurrent or future writers from exceeding the
-- retained security budgets.
CREATE TRIGGER crawl_target_retention_budget
BEFORE INSERT ON crawl_targets
WHEN NEW.service_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM crawl_targets existing WHERE existing.id=NEW.id)
  AND (
    (SELECT COUNT(*) FROM crawl_targets retained WHERE retained.service_id=NEW.service_id)>=256
    OR
    (SELECT COUNT(*) FROM crawl_targets active_target
      WHERE active_target.service_id=NEW.service_id
        AND active_target.status NOT IN ('retired','rejected')
        AND (
          NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
          OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)
        ))
    + (SELECT COUNT(DISTINCT staged.target_id) FROM source_snapshot_target_stage staged
      WHERE staged.service_id=NEW.service_id
        AND NOT EXISTS (
          SELECT 1 FROM crawl_targets active_staged
          WHERE active_staged.id=staged.target_id
            AND active_staged.status NOT IN ('retired','rejected')
            AND (
              NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_staged.id)
              OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_staged.id AND active_source.active=1)
            )
        ))>=192
  )
BEGIN
  SELECT RAISE(ABORT,'crawl target budget exceeded');
END;

CREATE TRIGGER crawl_target_activation_budget
BEFORE UPDATE OF active ON crawl_target_sources
WHEN OLD.active=0 AND NEW.active=1
  AND (SELECT status FROM crawl_targets WHERE id=NEW.target_id) NOT IN ('retired','rejected')
  AND (SELECT COUNT(*) FROM crawl_targets active_target
    WHERE active_target.service_id=(SELECT service_id FROM crawl_targets WHERE id=NEW.target_id)
      AND active_target.id<>NEW.target_id
      AND active_target.status NOT IN ('retired','rejected')
      AND (
        NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
        OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)
      ))
  + (SELECT COUNT(DISTINCT staged.target_id) FROM source_snapshot_target_stage staged
    WHERE staged.service_id=(SELECT service_id FROM crawl_targets WHERE id=NEW.target_id)
      AND staged.target_id<>NEW.target_id
      AND NOT EXISTS (
        SELECT 1 FROM crawl_targets active_staged
        WHERE active_staged.id=staged.target_id
          AND active_staged.status NOT IN ('retired','rejected')
          AND (
            NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_staged.id)
            OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_staged.id AND active_source.active=1)
          )
      ))>=192
BEGIN
  SELECT RAISE(ABORT,'crawl target activation budget exceeded');
END;

CREATE TRIGGER crawl_target_status_activation_budget
BEFORE UPDATE OF status ON crawl_targets
WHEN OLD.status IN ('retired','rejected')
  AND NEW.status NOT IN ('retired','rejected')
  AND (
    NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=NEW.id)
    OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=NEW.id AND active_source.active=1)
  )
  AND (SELECT COUNT(*) FROM crawl_targets active_target
    WHERE active_target.service_id=NEW.service_id
      AND active_target.id<>NEW.id
      AND active_target.status NOT IN ('retired','rejected')
      AND (
        NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_target.id)
        OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_target.id AND active_source.active=1)
      ))
  + (SELECT COUNT(DISTINCT staged.target_id) FROM source_snapshot_target_stage staged
    WHERE staged.service_id=NEW.service_id AND staged.target_id<>NEW.id
      AND NOT EXISTS (
        SELECT 1 FROM crawl_targets active_staged
        WHERE active_staged.id=staged.target_id
          AND active_staged.status NOT IN ('retired','rejected')
          AND (
            NOT EXISTS (SELECT 1 FROM crawl_target_sources any_source WHERE any_source.target_id=active_staged.id)
            OR EXISTS (SELECT 1 FROM crawl_target_sources active_source WHERE active_source.target_id=active_staged.id AND active_source.active=1)
          )
      ))>=192
BEGIN
  SELECT RAISE(ABORT,'crawl target status budget exceeded');
END;

CREATE TRIGGER openapi_endpoint_retention_budget
BEFORE INSERT ON endpoint_sources
WHEN NEW.source_type='openapi'
  AND NOT EXISTS (SELECT 1 FROM endpoint_sources existing WHERE existing.endpoint_id=NEW.endpoint_id AND existing.source_type='openapi')
  AND (SELECT COUNT(DISTINCT retained.endpoint_id)
    FROM endpoint_sources retained JOIN endpoints endpoint ON endpoint.id=retained.endpoint_id
    WHERE retained.source_type='openapi'
      AND endpoint.service_id=(SELECT service_id FROM endpoints WHERE id=NEW.endpoint_id))>=160
BEGIN
  SELECT RAISE(ABORT,'openapi endpoint budget exceeded');
END;

CREATE TRIGGER openapi_offer_retention_budget
BEFORE INSERT ON payment_offers
WHEN NEW.source_type='openapi'
  AND NOT EXISTS (SELECT 1 FROM payment_offers existing WHERE existing.id=NEW.id)
  AND (SELECT COUNT(*) FROM payment_offers retained JOIN endpoints endpoint ON endpoint.id=retained.endpoint_id
    WHERE retained.source_type='openapi'
      AND endpoint.service_id=(SELECT service_id FROM endpoints WHERE id=NEW.endpoint_id))>=512
BEGIN
  SELECT RAISE(ABORT,'openapi offer budget exceeded');
END;

-- Withdrawing the last authoritative source immediately revokes any in-flight
-- lease and prevents the target from recurring. A later source restoration
-- must explicitly allocate a fresh crawl generation.
CREATE TRIGGER crawl_target_source_withdrawal
AFTER UPDATE OF active ON crawl_target_sources
WHEN OLD.active=1 AND NEW.active=0
BEGIN
  UPDATE crawl_targets
  SET status='retired', next_due_at=NULL, processing_token=NULL,
      processing_expires_at=NULL, last_error='source-withdrawn',
      updated_at=CURRENT_TIMESTAMP
  WHERE id=NEW.target_id
    AND NOT EXISTS (
      SELECT 1 FROM crawl_target_sources active_source
      WHERE active_source.target_id=NEW.target_id AND active_source.active=1
    );
END;

CREATE VIEW active_endpoint_sources AS
SELECT es.* FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id
WHERE es.active=1 AND e.published=1 AND (
  es.source_type<>'openapi'
  OR NOT EXISTS (
    SELECT 1 FROM crawl_targets parent JOIN crawl_target_sources parent_source ON parent_source.target_id=parent.id
    WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=es.source_ref
  )
  OR EXISTS (
    SELECT 1 FROM crawl_targets parent JOIN crawl_target_sources parent_source ON parent_source.target_id=parent.id AND parent_source.active=1
    WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=es.source_ref
  )
);

CREATE VIEW active_payment_offers AS
SELECT p.* FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id
WHERE p.active=1 AND e.published=1 AND (
  p.source_type<>'openapi'
  OR NOT EXISTS (
    SELECT 1 FROM crawl_targets parent JOIN crawl_target_sources parent_source ON parent_source.target_id=parent.id
    WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=p.source_ref
  )
  OR EXISTS (
    SELECT 1 FROM crawl_targets parent JOIN crawl_target_sources parent_source ON parent_source.target_id=parent.id AND parent_source.active=1
    WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=p.source_ref
  )
);

CREATE INDEX idx_services_last_seen ON services(last_seen DESC);
CREATE INDEX idx_services_origin ON services(origin);
CREATE INDEX idx_services_implementation ON services(implementation, implementation_confidence DESC);
CREATE INDEX idx_endpoints_service ON endpoints(service_id, last_seen DESC);
CREATE INDEX idx_endpoints_status ON endpoints(last_status, last_probe_at DESC);
CREATE INDEX idx_endpoint_sources_active ON endpoint_sources(endpoint_id, active, source_type);
CREATE INDEX idx_offers_endpoint ON payment_offers(endpoint_id);
CREATE INDEX idx_offers_method_currency ON payment_offers(active, method, currency);
CREATE INDEX idx_sources_service ON sources(service_id);
CREATE INDEX idx_observations_service_time ON observations(service_id, observed_at DESC);
CREATE INDEX idx_observations_target_time ON observations(service_id, requested_url, request_method, observed_at DESC);
CREATE INDEX idx_observations_retention ON observations(observed_at, raw_r2_key);
CREATE INDEX idx_security_service ON security_properties(service_id, property_key);
CREATE INDEX idx_changes_time ON changes(changed_at DESC);
CREATE INDEX idx_changes_service_time ON changes(service_id, changed_at DESC);
CREATE INDEX idx_crawl_due ON crawl_targets(status, next_due_at);
CREATE INDEX idx_crawl_url ON crawl_targets(normalized_url);
CREATE INDEX idx_crawl_retention ON crawl_targets(status, updated_at);
CREATE INDEX idx_source_snapshots_status ON source_snapshots(status, observed_at);
CREATE INDEX idx_snapshot_endpoint_stage_service ON source_snapshot_endpoint_stage(service_id, source_type, endpoint_id);
CREATE INDEX idx_snapshot_offer_stage_service ON source_snapshot_offer_stage(service_id, source_type, offer_id);
CREATE INDEX idx_discovery_run_services ON discovery_run_services(run_id, service_id);
CREATE INDEX idx_crawl_target_sources_active ON crawl_target_sources(target_id, active, source_type);
CREATE INDEX idx_submissions_unconfirmed_origin ON submissions(confirmed_at, origin);
CREATE INDEX idx_submissions_active_expiry ON submissions(confirmed_at, candidate_expires_at, status, origin);
