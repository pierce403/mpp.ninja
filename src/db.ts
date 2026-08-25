import type { CatalogService, OpenApiOffer, PaymentOffer } from "./model";
import { MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE, MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE } from "./budgets";
import { ScanSafetyError, normalizeDiscoveryUrl, normalizeUrl, redactJsonValue, redactText, redactUrlForStorage, safeJson, sha256 } from "./security";

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ACTIVE_ENDPOINT_SQL = "e.published=1 AND EXISTS (SELECT 1 FROM services visible_service WHERE visible_service.id=e.service_id AND visible_service.published=1) AND EXISTS (SELECT 1 FROM active_endpoint_sources aes WHERE aes.endpoint_id=e.id)";
export const SOURCE_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1_000;
const STALE_SNAPSHOT_CLEANUP_LIMIT = 10;
export type SourceSnapshotStatus = "running" | "complete" | "failed";

export interface ListParams {
  q?: string;
  method?: string;
  chain?: string;
  implementation?: string;
  securityState?: string;
  limit: number;
  offset: number;
}

export interface DetailParams { limit: number; offset: number }
const DETAIL_OFFER_LIMIT = 12;
const DETAIL_SOURCE_LIMIT = 100;
const DETAIL_SECURITY_LIMIT = 250;
const DETAIL_CHANGE_LIMIT = 50;
const SERVICE_PAYMENT_METHOD_LIMIT = 16;

export function encodeCursor(offset: number): string {
  return btoa(String(offset)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const encoded=cursor.replace(/-/g, "+").replace(/_/g, "/");
    const value = Number(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,"=")));
    return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : 0;
  } catch {
    return 0;
  }
}

export function parsePage(url: URL): ListParams {
  const limit = parseLimit(url.searchParams.get("limit"),25);
  return {
    q: clean(url.searchParams.get("q"), 120),
    method: clean(url.searchParams.get("method"), 40),
    chain: clean(url.searchParams.get("chain"), 80),
    implementation: clean(url.searchParams.get("implementation"), 40),
    securityState: clean(url.searchParams.get("security"), 40),
    limit,
    offset: decodeCursor(url.searchParams.get("cursor")),
  };
}

export function parseDetailPage(url:URL):DetailParams{return{limit:Math.min(50,parseLimit(url.searchParams.get("limit"),25)),offset:decodeCursor(url.searchParams.get("cursor"))};}

function clean(value: string | null, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function whereForServices(params: ListParams): { sql: string; binds: unknown[] } {
  const clauses: string[] = ["s.published=1"];
  const binds: unknown[] = [];
  if (params.q) {
    // D1 limits LIKE/GLOB patterns to 50 bytes. `instr` provides literal
    // substring search without turning a long public query into a 500.
    clauses.push("(instr(lower(s.name),lower(?))>0 OR instr(lower(s.description),lower(?))>0 OR instr(lower(s.origin),lower(?))>0)");
    const q = params.q;
    binds.push(q, q, q);
  }
  if (params.method) {
    clauses.push("EXISTS (SELECT 1 FROM endpoints fe JOIN active_endpoint_sources fes ON fes.endpoint_id=fe.id JOIN active_payment_offers fp ON fp.endpoint_id=fe.id WHERE fe.service_id=s.id AND lower(fp.method)=lower(?))");
    binds.push(params.method);
  }
  if (params.chain) {
    clauses.push("EXISTS (SELECT 1 FROM endpoints ce JOIN active_endpoint_sources ces ON ces.endpoint_id=ce.id JOIN active_payment_offers cp ON cp.endpoint_id=ce.id WHERE ce.service_id=s.id AND lower(cp.chain_id)=lower(?))");
    binds.push(params.chain);
  }
  if (params.implementation) {
    clauses.push("lower(s.implementation)=lower(?)");
    binds.push(params.implementation);
  }
  if (params.securityState) {
    clauses.push("EXISTS (SELECT 1 FROM security_properties sp WHERE sp.service_id=s.id AND sp.state=?)");
    binds.push(params.securityState);
  }
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", binds };
}

export async function listServices(db: D1Database, params: ListParams): Promise<Record<string, unknown>> {
  const where = whereForServices(params);
  const base = `
    FROM services s
    ${where.sql}
  `;
  const [rows, count] = await Promise.all([
    db.prepare(`
      SELECT s.*,
        (SELECT COUNT(*) FROM endpoints e WHERE e.service_id=s.id AND ${ACTIVE_ENDPOINT_SQL}) AS endpoint_count,
        (SELECT COUNT(*) FROM security_properties sp WHERE sp.service_id=s.id AND sp.state='tested-fail') AS failed_checks,
        (SELECT group_concat(method) FROM (
          SELECT po.method AS method FROM endpoints e JOIN active_payment_offers po ON po.endpoint_id=e.id
          WHERE e.service_id=s.id AND ${ACTIVE_ENDPOINT_SQL}
          GROUP BY po.method ORDER BY po.method LIMIT ${SERVICE_PAYMENT_METHOD_LIMIT}
        )) AS payment_methods,
        (SELECT COUNT(DISTINCT po.method) FROM endpoints e JOIN active_payment_offers po ON po.endpoint_id=e.id WHERE e.service_id=s.id AND ${ACTIVE_ENDPOINT_SQL}) AS payment_method_count
      ${base}
      ORDER BY s.last_seen DESC, s.name ASC, s.id ASC
      LIMIT ? OFFSET ?
    `).bind(...where.binds, params.limit, params.offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS total ${base}`).bind(...where.binds).first<{ total: number }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return {
    data: rows.results.map(hydrateServiceRow),
    pagination: {
      limit: params.limit,
      total,
      nextCursor: params.offset + rows.results.length < total ? encodeCursor(params.offset + rows.results.length) : null,
    },
    limits: { paymentMethodsPerService: SERVICE_PAYMENT_METHOD_LIMIT },
  };
}

export async function getService(db: D1Database, id: string, requested:Partial<DetailParams>={}): Promise<Record<string, unknown> | null> {
  const service = await db.prepare("SELECT * FROM services WHERE id=? AND published=1").bind(id).first<Record<string, unknown>>();
  if (!service) return null;
  const limit=Math.min(50,Math.max(1,Math.trunc(requested.limit??25)));
  const offset=Math.min(1_000_000,Math.max(0,Math.trunc(requested.offset??0)));
  const [endpoints, sources, security, changes, counts] = await Promise.all([
    db.prepare(`SELECT e.*,
      (SELECT json_group_array(json_object('id',p.id,'method',p.method,'intent',p.intent,'currency',p.currency,'chainId',p.chain_id,'recipient',p.recipient,'amount',p.amount,'decimals',p.decimals,'unitType',p.unit_type,'session',json(p.session_json),'sourceType',p.source_type,'sourceRef',p.source_ref,'sourceOrdinal',p.source_ordinal,'firstSeen',p.first_seen,'lastSeen',p.last_seen)) FROM (SELECT * FROM active_payment_offers po WHERE po.endpoint_id=e.id ORDER BY po.source_type,po.source_ref,po.source_ordinal,po.id LIMIT ${DETAIL_OFFER_LIMIT}) p) AS offers_json,
      (SELECT COUNT(*) FROM active_payment_offers p WHERE p.endpoint_id=e.id) AS offer_count,
      (SELECT json_group_array(json_object('type',es.source_type,'ref',es.source_ref,'firstSeen',es.first_seen,'lastSeen',es.last_seen)) FROM (SELECT * FROM active_endpoint_sources ess WHERE ess.endpoint_id=e.id ORDER BY ess.source_type,ess.source_ref LIMIT 32) es) AS active_sources_json,
      (SELECT COUNT(*) FROM active_endpoint_sources es WHERE es.endpoint_id=e.id) AS active_source_count
      FROM endpoints e WHERE e.service_id=? AND ${ACTIVE_ENDPOINT_SQL} ORDER BY e.path,e.http_method,e.id LIMIT ? OFFSET ?`).bind(id,limit,offset).all<Record<string, unknown>>(),
    db.prepare("SELECT source_kind,source_url,evidence_json,first_seen,last_seen FROM sources WHERE service_id=? ORDER BY source_kind,source_url LIMIT ?").bind(id,DETAIL_SOURCE_LIMIT).all<Record<string, unknown>>(),
    db.prepare("SELECT property_key,state,evidence,basis,advisory_ref,observed_at,endpoint_id FROM security_properties WHERE service_id=? ORDER BY observed_at DESC,property_key LIMIT ?").bind(id,DETAIL_SECURITY_LIMIT).all<Record<string, unknown>>(),
    db.prepare("SELECT id,endpoint_id,changed_at,change_type,field_name,old_value,new_value,evidence FROM changes WHERE service_id=? ORDER BY changed_at DESC,id LIMIT ?").bind(id,DETAIL_CHANGE_LIMIT).all<Record<string, unknown>>(),
    db.prepare(`SELECT
      (SELECT COUNT(*) FROM endpoints e WHERE e.service_id=? AND ${ACTIVE_ENDPOINT_SQL}) AS endpoints,
      (SELECT COUNT(*) FROM sources WHERE service_id=?) AS sources,
      (SELECT COUNT(*) FROM security_properties WHERE service_id=?) AS security,
      (SELECT COUNT(*) FROM changes WHERE service_id=?) AS changes`).bind(id,id,id,id).first<{endpoints:number;sources:number;security:number;changes:number}>(),
  ]);
  const endpointTotal=Number(counts?.endpoints??0);
  return {
    ...hydrateServiceRow(service),
    endpoints: endpoints.results.map(hydrateEndpointRow),
    endpointPagination:{limit,total:endpointTotal,nextCursor:offset+endpoints.results.length<endpointTotal?encodeCursor(offset+endpoints.results.length):null},
    sources: sources.results.map((row) => withoutJsonColumn(row,"evidence_json","evidence",{})),
    sourcePagination:{limit:DETAIL_SOURCE_LIMIT,total:Number(counts?.sources??0),truncated:Number(counts?.sources??0)>sources.results.length},
    security: security.results,
    securityPagination:{limit:DETAIL_SECURITY_LIMIT,total:Number(counts?.security??0),truncated:Number(counts?.security??0)>security.results.length},
    changes: changes.results,
    changePagination:{limit:DETAIL_CHANGE_LIMIT,total:Number(counts?.changes??0),truncated:Number(counts?.changes??0)>changes.results.length},
  };
}

export async function listEndpoints(db: D1Database, url: URL): Promise<Record<string, unknown>> {
  const limit = Math.min(50,parseLimit(url.searchParams.get("limit"),50));
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const method = clean(url.searchParams.get("method"), 16);
  const serviceId = clean(url.searchParams.get("service"), 100);
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (method) { clauses.push("e.http_method=upper(?)"); binds.push(method); }
  if (serviceId) { clauses.push("e.service_id=?"); binds.push(serviceId); }
  clauses.push(ACTIVE_ENDPOINT_SQL);
  const where = `WHERE ${clauses.join(" AND ")}`;
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT e.*,s.name AS service_name,s.implementation,
      (SELECT json_group_array(json_object('method',p.method,'intent',p.intent,'currency',p.currency,'chainId',p.chain_id,'recipient',p.recipient,'amount',p.amount,'decimals',p.decimals,'unitType',p.unit_type,'session',json(p.session_json),'sourceType',p.source_type,'sourceRef',p.source_ref,'sourceOrdinal',p.source_ordinal)) FROM (SELECT * FROM active_payment_offers po WHERE po.endpoint_id=e.id ORDER BY po.source_type,po.source_ref,po.source_ordinal,po.id LIMIT ${DETAIL_OFFER_LIMIT}) p) AS offers_json,
      (SELECT COUNT(*) FROM active_payment_offers p WHERE p.endpoint_id=e.id) AS offer_count,
      (SELECT json_group_array(json_object('type',es.source_type,'ref',es.source_ref,'firstSeen',es.first_seen,'lastSeen',es.last_seen)) FROM (SELECT * FROM active_endpoint_sources ess WHERE ess.endpoint_id=e.id ORDER BY ess.source_type,ess.source_ref LIMIT 32) es) AS active_sources_json,
      (SELECT COUNT(*) FROM active_endpoint_sources es WHERE es.endpoint_id=e.id) AS active_source_count
      FROM endpoints e JOIN services s ON s.id=e.service_id ${where} ORDER BY e.last_seen DESC,e.id LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS total FROM endpoints e ${where}`).bind(...binds).first<{ total: number }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return { data: rows.results.map(hydrateEndpointRow), pagination: { limit, total, nextCursor: offset + rows.results.length < total ? encodeCursor(offset + rows.results.length) : null },limits:{offersPerEndpoint:DETAIL_OFFER_LIMIT} };
}

export async function listImplementations(db: D1Database): Promise<Record<string, unknown>> {
  const result = await db.prepare(`SELECT implementation,COUNT(*) AS services,ROUND(AVG(implementation_confidence),3) AS average_confidence,SUM(CASE WHEN implementation_confidence>=0.8 THEN 1 ELSE 0 END) AS high_confidence FROM services WHERE published=1 GROUP BY implementation ORDER BY services DESC,implementation`).all<Record<string, unknown>>();
  const total = result.results.reduce((sum, row) => sum + Number(row.services), 0);
  return { data: result.results.map((row) => ({ ...row, concentration: total > 0 ? Number(row.services) / total : 0 })), totalServices: total };
}

export async function listChanges(db: D1Database, url: URL): Promise<Record<string, unknown>> {
  const limit = parseLimit(url.searchParams.get("limit"),50);
  const offset = decodeCursor(url.searchParams.get("cursor"));
  const service = clean(url.searchParams.get("service"), 100);
  const where = service ? "WHERE s.published=1 AND c.service_id=?" : "WHERE s.published=1";
  const binds = service ? [service] : [];
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT c.*,s.name AS service_name FROM changes c JOIN services s ON s.id=c.service_id ${where} ORDER BY c.changed_at DESC,c.id LIMIT ? OFFSET ?`).bind(...binds, limit, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS total FROM changes c JOIN services s ON s.id=c.service_id ${where}`).bind(...binds).first<{ total: number }>(),
  ]);
  const total = Number(count?.total ?? 0);
  return { data: rows.results, pagination: { limit, total, nextCursor: offset + rows.results.length < total ? encodeCursor(offset + rows.results.length) : null } };
}

export async function getStats(db: D1Database): Promise<Record<string, unknown>> {
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM services WHERE published=1) AS services,
    (SELECT COUNT(*) FROM endpoints e WHERE ${ACTIVE_ENDPOINT_SQL}) AS endpoints,
    (SELECT COUNT(*) FROM active_payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE ${ACTIVE_ENDPOINT_SQL}) AS offers,
    (SELECT COUNT(*) FROM observations observation JOIN services observed_service ON observed_service.id=observation.service_id WHERE observed_service.published=1) AS observations,
    (SELECT COUNT(*) FROM services WHERE published=1 AND last_probe_at IS NOT NULL) AS probed_services,
    (SELECT COUNT(*) FROM services WHERE published=1 AND status='candidate') AS candidate_services,
    (SELECT COUNT(*) FROM services s WHERE s.published=1 AND (s.status='observed-mpp' OR EXISTS (SELECT 1 FROM endpoints e JOIN active_endpoint_sources es ON es.endpoint_id=e.id AND es.source_type='challenge' WHERE e.service_id=s.id AND e.challenge_format='mpp-payment-auth'))) AS challenge_services,
    (SELECT COUNT(DISTINCT e.service_id) FROM endpoints e WHERE e.last_status IS NOT NULL AND ${ACTIVE_ENDPOINT_SQL}) AS endpoint_probed_services,
    (SELECT COUNT(*) FROM security_properties property JOIN services secured_service ON secured_service.id=property.service_id WHERE secured_service.published=1 AND property.state='tested-fail') AS tested_fail,
    (SELECT COUNT(DISTINCT p.method) FROM active_payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE ${ACTIVE_ENDPOINT_SQL}) AS payment_methods,
    (SELECT COUNT(*) FROM changes c JOIN services cs ON cs.id=c.service_id WHERE cs.published=1) AS changes,
    (SELECT COUNT(*) FROM submissions) AS submissions,
    (SELECT MAX(observation.observed_at) FROM observations observation JOIN services observed_service ON observed_service.id=observation.service_id WHERE observed_service.published=1) AS last_observation,
    (SELECT MAX(finished_at) FROM discovery_runs WHERE status='complete') AS last_discovery
  `).first<Record<string, unknown>>();
  return row ?? {};
}

export async function upsertDiscoveredServiceUrl(db:D1Database,rawUrl:string,sourceKind:string,sourceUrl:string,observedAt:string):Promise<string>{
  const serviceUrl=normalizeDiscoveryUrl(rawUrl);
  if(redactUrlForStorage(serviceUrl)!==serviceUrl)throw new ScanSafetyError("credential-shaped-service-url","Credential-shaped service URLs are not persisted or probed");
  const url=new URL(serviceUrl);
  const existing=await db.prepare("SELECT id FROM services WHERE service_url=?").bind(serviceUrl).first<{id:string}>();
  const candidateId=existing?.id??`${slug(sourceKind)}-${(await sha256(serviceUrl)).slice(0,24)}`;
  const displayPath=url.pathname==="/"?"":` ${url.pathname}`;
  await db.prepare("INSERT INTO services (id,name,homepage_url,service_url,origin,description,status,first_seen,last_seen) VALUES (?,?,?,?,?,?,'candidate',?,?) ON CONFLICT(service_url) DO UPDATE SET published=1,last_seen=excluded.last_seen,updated_at=CURRENT_TIMESTAMP WHERE excluded.last_seen>=services.last_seen").bind(candidateId,`${url.hostname}${displayPath}`.slice(0,200),url.origin,serviceUrl,url.origin,"Public discovery candidate; runtime MPP not yet established",observedAt,observedAt).run();
  const actual=await db.prepare("SELECT id FROM services WHERE service_url=?").bind(serviceUrl).first<{id:string}>();
  if(!actual)throw new Error("discovered-service-upsert-failed");
  const provenanceId=await sha256(`${actual.id}|${sourceKind}|${sourceUrl}`);
  await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,last_seen=excluded.last_seen WHERE excluded.last_seen>=sources.last_seen").bind(provenanceId,actual.id,sourceKind,sourceUrl,boundedJson({discoveredUrl:stripQueryForEvidence(serviceUrl)},4_096),observedAt,observedAt).run();
  return actual.id;
}

export async function upsertCatalogService(db: D1Database, service: CatalogService, sourceUrl: string, observedAt: string, snapshotManaged=false, snapshotId?:string, snapshotExpectedItems=Math.max(1,service.endpoints?.length??0)): Promise<{ serviceId: string; endpointIds: string[] }> {
  const serviceUrl = normalizeDiscoveryUrl(service.serviceUrl);
  if(redactUrlForStorage(serviceUrl)!==serviceUrl)throw new ScanSafetyError("credential-shaped-service-url","Credential-shaped service URLs are not persisted or probed");
  const origin = new URL(serviceUrl).origin;
  const byUrl = await db.prepare("SELECT id FROM services WHERE service_url=?").bind(serviceUrl).first<{ id: string }>();
  let serviceId = byUrl?.id ?? `catalog-${(await sha256(serviceUrl)).slice(0,48)}`;
  const homepage = optionalUrl(service.url ?? service.docs?.homepage);
  const next = {
    name: redactText(service.name.slice(0, 200)), homepage_url: homepage, service_url: serviceUrl, description: redactText((service.description ?? "").slice(0, 2000)),
    categories_json: boundedJson(service.categories ?? [],8_192), tags_json: boundedJson(service.tags ?? [],8_192), status: (service.status ?? "active").slice(0, 40),
  };
  if(snapshotManaged){
    if(!snapshotId)throw new Error("snapshot-id-required");
    await db.prepare("INSERT INTO services (id,name,homepage_url,service_url,origin,description,categories_json,tags_json,status,published,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,0,?,?) ON CONFLICT(service_url) DO NOTHING")
      .bind(serviceId,next.name,next.homepage_url,next.service_url,origin,next.description,next.categories_json,next.tags_json,next.status,observedAt,observedAt).run();
    serviceId=(await db.prepare("SELECT id FROM services WHERE service_url=?").bind(serviceUrl).first<{id:string}>())?.id??serviceId;
    const existing=await db.prepare("SELECT catalog_seen_at FROM services WHERE id=?").bind(serviceId).first<{catalog_seen_at:string|null}>();
    await startSourceSnapshot(db,{id:snapshotId,serviceId,sourceType:"catalog",sourceRef:sourceUrl,observedAt,expectedItems:snapshotExpectedItems});
    if(await sourceSnapshotStatus(db,snapshotId)!=="running")throw new ScanSafetyError("source-snapshot-closed","Catalog snapshot no longer accepts items");
    if(existing?.catalog_seen_at&&existing.catalog_seen_at>observedAt)return{serviceId,endpointIds:[]};
    await db.prepare(`INSERT INTO source_snapshot_service_stage (snapshot_id,service_id,name,homepage_url,service_url,origin,description,categories_json,tags_json,status,full_replace)
      VALUES (?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(snapshot_id) DO UPDATE SET name=excluded.name,homepage_url=excluded.homepage_url,service_url=excluded.service_url,origin=excluded.origin,description=excluded.description,categories_json=excluded.categories_json,tags_json=excluded.tags_json,status=excluded.status,full_replace=1`)
      .bind(snapshotId,serviceId,next.name,next.homepage_url,next.service_url,origin,next.description,next.categories_json,next.tags_json,next.status).run();
    const sourceId=await sha256(`${serviceId}|catalog|${sourceUrl}`);
    await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,last_seen=excluded.last_seen WHERE excluded.last_seen>=sources.last_seen")
      .bind(sourceId,serviceId,"mpp.dev-catalog",sourceUrl,safeJson({catalogId:service.id,version:1}),observedAt,observedAt).run();
    const endpointIds:string[]=[];
    for(const endpoint of service.endpoints??[]){
      const method=(endpoint.method??"GET").toUpperCase().slice(0,12);
      let endpointUrl:string;
      try{endpointUrl=normalizeDiscoveryUrl(new URL(endpoint.path,serviceUrl.endsWith("/")?serviceUrl:`${serviceUrl}/`).toString());if(redactUrlForStorage(endpointUrl)!==endpointUrl)throw new ScanSafetyError("credential-shaped-catalog-path","Credential-shaped catalog paths are not persisted or probed");}catch{endpointIds.push("");continue;}
      const endpointId=await sha256(`${serviceId}|${method}|${endpointUrl}`);endpointIds.push(endpointId);
      const path=new URL(endpointUrl).pathname;const description=redactText((endpoint.description??"").slice(0,1_000));
      await db.batch([
        db.prepare("INSERT OR IGNORE INTO endpoints (id,service_id,url,http_method,path,kind,description,published,first_seen,last_seen) VALUES (?,?,?,?,?,'paid-api',?,0,?,?)").bind(endpointId,serviceId,endpointUrl,method,path,description,observedAt,observedAt),
        db.prepare(`INSERT INTO source_snapshot_endpoint_stage (snapshot_id,endpoint_id,service_id,url,http_method,path,kind,description,source_type,source_ref,first_seen,last_seen)
          VALUES (?,?,?,?,?,?,'paid-api',?,'catalog',?,?,?)
          ON CONFLICT(snapshot_id,endpoint_id) DO UPDATE SET url=excluded.url,http_method=excluded.http_method,path=excluded.path,description=excluded.description,last_seen=excluded.last_seen`)
          .bind(snapshotId,endpointId,serviceId,endpointUrl,method,path,description,sourceUrl.slice(0,2_048),observedAt,observedAt),
      ]);
      if(endpoint.payment)await stageSnapshotOffer(db,snapshotId,serviceId,endpointId,catalogPayment(endpoint.payment),observedAt,sourceUrl,0);
    }
    return{serviceId,endpointIds};
  }
  const existing = await db.prepare("SELECT name,homepage_url,service_url,description,categories_json,tags_json,status,last_seen,catalog_seen_at FROM services WHERE id=?").bind(serviceId).first<Record<string, unknown>>();
  if(existing?.catalog_seen_at&&String(existing.catalog_seen_at)>observedAt)return{serviceId,endpointIds:[]};
  const written=await db.prepare(`INSERT INTO services (id,name,homepage_url,service_url,origin,description,categories_json,tags_json,status,catalog_ingest_at,catalog_seen_at,first_seen,last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(service_url) DO UPDATE SET name=excluded.name,homepage_url=excluded.homepage_url,origin=excluded.origin,description=excluded.description,categories_json=excluded.categories_json,tags_json=excluded.tags_json,status=excluded.status,catalog_ingest_at=excluded.catalog_ingest_at,catalog_seen_at=excluded.catalog_seen_at,last_seen=CASE WHEN excluded.last_seen>services.last_seen THEN excluded.last_seen ELSE services.last_seen END,updated_at=${NOW_SQL} WHERE services.catalog_ingest_at IS NULL OR excluded.catalog_ingest_at>=services.catalog_ingest_at RETURNING id`).bind(serviceId,next.name,next.homepage_url,next.service_url,origin,next.description,next.categories_json,next.tags_json,next.status,observedAt,observedAt,observedAt,observedAt).first<{id:string}>();
  serviceId=written?.id??(await db.prepare("SELECT id FROM services WHERE service_url=?").bind(serviceUrl).first<{id:string}>())?.id??serviceId;
  const sourceId = await sha256(`${serviceId}|catalog|${sourceUrl}`);
  await db.prepare("INSERT INTO sources (id,service_id,source_kind,source_url,evidence_json,first_seen,last_seen) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET evidence_json=excluded.evidence_json,last_seen=excluded.last_seen WHERE excluded.last_seen>=sources.last_seen").bind(sourceId,serviceId,"mpp.dev-catalog",sourceUrl,safeJson({ catalogId: service.id, version: 1 }),observedAt,observedAt).run();

  const endpointIds: string[] = [];
  for (const endpoint of service.endpoints ?? []) {
    const method = (endpoint.method ?? "GET").toUpperCase().slice(0, 12);
    let endpointUrl:string;
    try{endpointUrl=normalizeDiscoveryUrl(new URL(endpoint.path,serviceUrl.endsWith("/")?serviceUrl:`${serviceUrl}/`).toString());if(redactUrlForStorage(endpointUrl)!==endpointUrl)throw new ScanSafetyError("credential-shaped-catalog-path","Credential-shaped catalog paths are not persisted or probed");}catch{endpointIds.push("");continue;}
    const endpointId = await sha256(`${serviceId}|${method}|${endpointUrl}`);
    endpointIds.push(endpointId);
    const previous = await db.prepare("SELECT url,http_method,path,description,last_seen,catalog_seen_at FROM endpoints WHERE id=?").bind(endpointId).first<Record<string, unknown>>();
    if(previous?.catalog_seen_at&&String(previous.catalog_seen_at)>observedAt)continue;
    const nextEndpoint = { url: endpointUrl, http_method: method, path: new URL(endpointUrl).pathname, description: redactText((endpoint.description ?? "").slice(0, 1000)) };
    const endpointStatements = [
      db.prepare(`INSERT INTO endpoints (id,service_id,url,http_method,path,kind,description,catalog_seen_at,first_seen,last_seen) VALUES (?,?,?,?,?,'paid-api',?,?,?,?) ON CONFLICT(id) DO UPDATE SET url=excluded.url,http_method=excluded.http_method,path=excluded.path,description=excluded.description,catalog_seen_at=excluded.catalog_seen_at,last_seen=CASE WHEN excluded.last_seen>endpoints.last_seen THEN excluded.last_seen ELSE endpoints.last_seen END,updated_at=${NOW_SQL} WHERE endpoints.catalog_seen_at IS NULL OR excluded.catalog_seen_at>=endpoints.catalog_seen_at`).bind(endpointId,serviceId,endpointUrl,method,nextEndpoint.path,nextEndpoint.description,observedAt,observedAt,observedAt),
      endpointSourceStatement(db,endpointId,"catalog",sourceUrl,observedAt,!snapshotManaged),
    ];
    if (endpoint.payment) endpointStatements.push(...await offerStatements(db, serviceId, endpointId, catalogPayment(endpoint.payment), observedAt,sourceUrl,0,snapshotManaged));
    await db.batch(endpointStatements);
  }
  return { serviceId, endpointIds };
}

export async function upsertOpenApiOperation(db: D1Database, serviceId: string, baseUrl: string, operation: { method: string; path: string; description: string; offers: OpenApiOffer[] }, observedAt: string, sourceRef="openapi", offerOffset=0, snapshotManaged=false, snapshotId?:string): Promise<string> {
  const endpointUrl = openApiEndpointUrl(baseUrl,operation.path);
  const endpointId = await sha256(`${serviceId}|${operation.method}|${endpointUrl}`);
  if(snapshotManaged){
    if(!snapshotId)throw new Error("snapshot-id-required");
    const snapshot=await db.prepare("SELECT 1 AS present FROM source_snapshots WHERE id=? AND service_id=? AND source_type='openapi' AND source_ref=? AND observed_at=? AND status='running'").bind(snapshotId,serviceId,sourceRef.slice(0,2_048),observedAt).first();
    if(!snapshot)throw new ScanSafetyError("source-snapshot-closed","OpenAPI snapshot no longer accepts items");
    const newerMembership=await db.prepare("SELECT 1 AS newer FROM endpoint_sources WHERE endpoint_id=? AND source_type='openapi' AND source_ref=? AND last_seen>? UNION ALL SELECT 1 FROM source_snapshot_endpoint_stage WHERE endpoint_id=? AND source_type='openapi' AND source_ref=? AND last_seen>? LIMIT 1")
      .bind(endpointId,sourceRef.slice(0,2_048),observedAt,endpointId,sourceRef.slice(0,2_048),observedAt).first();
    if(newerMembership)return endpointId;
    const retainedEndpoint=await db.prepare(`SELECT 1 AS present FROM endpoint_sources WHERE endpoint_id=? AND source_type='openapi'
      UNION ALL SELECT 1 FROM source_snapshot_endpoint_stage WHERE endpoint_id=? AND source_type='openapi' LIMIT 1`).bind(endpointId,endpointId).first();
    if(!retainedEndpoint){
      const retained=await db.prepare(`SELECT COUNT(DISTINCT endpoint_id) AS count FROM (
        SELECT es.endpoint_id FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='openapi'
        UNION
        SELECT staged.endpoint_id FROM source_snapshot_endpoint_stage staged WHERE staged.service_id=? AND staged.source_type='openapi'
      )`).bind(serviceId,serviceId).first<{count:number}>();
      if(Number(retained?.count??0)>=MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE)throw new ScanSafetyError("openapi-endpoint-budget","Per-service retained OpenAPI endpoint budget is exhausted");
    }
    const requestedOrdinals=new Set(operation.offers.map((_offer,index)=>Math.max(0,Math.min(31,Math.trunc(offerOffset+index)))));
    const existingSlots=await db.prepare(`SELECT source_ordinal FROM payment_offers WHERE endpoint_id=? AND source_type='openapi' AND source_ref=?
      UNION SELECT source_ordinal FROM source_snapshot_offer_stage WHERE endpoint_id=? AND source_type='openapi' AND source_ref=?`).bind(endpointId,sourceRef.slice(0,2_048),endpointId,sourceRef.slice(0,2_048)).all<{source_ordinal:number}>();
    const existingOrdinals=new Set(existingSlots.results.map((row)=>Number(row.source_ordinal)));
    const newOfferSlots=[...requestedOrdinals].filter((ordinal)=>!existingOrdinals.has(ordinal)).length;
    if(newOfferSlots){
      const retained=await db.prepare(`SELECT COUNT(*) AS count FROM (
        SELECT p.id FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='openapi'
        UNION
        SELECT staged.offer_id FROM source_snapshot_offer_stage staged WHERE staged.service_id=? AND staged.source_type='openapi'
      )`).bind(serviceId,serviceId).first<{count:number}>();
      if(Number(retained?.count??0)+newOfferSlots>MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE)throw new ScanSafetyError("openapi-offer-budget","Per-service retained OpenAPI offer budget is exhausted");
    }
    const path=new URL(endpointUrl).pathname;const description=redactText(operation.description.slice(0,1_000));
    await db.batch([
      db.prepare("INSERT OR IGNORE INTO endpoints (id,service_id,url,http_method,path,kind,description,published,first_seen,last_seen) VALUES (?,?,?,?,?,'paid-api',?,0,?,?)").bind(endpointId,serviceId,endpointUrl,operation.method,path,description,observedAt,observedAt),
      db.prepare(`INSERT INTO source_snapshot_endpoint_stage (snapshot_id,endpoint_id,service_id,url,http_method,path,kind,description,source_type,source_ref,first_seen,last_seen)
        VALUES (?,?,?,?,?,?,'paid-api',?,'openapi',?,?,?)
        ON CONFLICT(snapshot_id,endpoint_id) DO UPDATE SET url=excluded.url,http_method=excluded.http_method,path=excluded.path,description=excluded.description,last_seen=excluded.last_seen`)
        .bind(snapshotId,endpointId,serviceId,endpointUrl,operation.method,path,description,sourceRef.slice(0,2_048),observedAt,observedAt),
    ]);
    for(const [sourceOrdinal,offer] of operation.offers.entries())await stageSnapshotOffer(db,snapshotId,serviceId,endpointId,openApiPayment(offer),observedAt,sourceRef,offerOffset+sourceOrdinal);
    return endpointId;
  }
  const previous = await db.prepare("SELECT url,http_method,path,description,last_seen,openapi_seen_at FROM endpoints WHERE id=?").bind(endpointId).first<Record<string, unknown>>();
  const membership=await db.prepare("SELECT last_seen FROM endpoint_sources WHERE endpoint_id=? AND source_type='openapi' AND source_ref=?").bind(endpointId,sourceRef).first<{last_seen:string}>();
  if(membership?.last_seen&&membership.last_seen>observedAt)return endpointId;
  const anyOpenApiMembership=membership??await db.prepare("SELECT last_seen FROM endpoint_sources WHERE endpoint_id=? AND source_type='openapi' LIMIT 1").bind(endpointId).first<{last_seen:string}>();
  if(!anyOpenApiMembership){
    const retained=await db.prepare("SELECT COUNT(DISTINCT es.endpoint_id) AS count FROM endpoint_sources es JOIN endpoints e ON e.id=es.endpoint_id WHERE e.service_id=? AND es.source_type='openapi'").bind(serviceId).first<{count:number}>();
    if(Number(retained?.count??0)>=MAX_RETAINED_OPENAPI_ENDPOINTS_PER_SERVICE)throw new ScanSafetyError("openapi-endpoint-budget","Per-service retained OpenAPI endpoint budget is exhausted");
  }
  const requestedOrdinals=new Set(operation.offers.map((_offer,index)=>Math.max(0,Math.min(31,Math.trunc(offerOffset+index)))));
  const existingSlots=endpointId?await db.prepare("SELECT source_ordinal FROM payment_offers WHERE endpoint_id=? AND source_type='openapi' AND source_ref=?").bind(endpointId,sourceRef.slice(0,2_048)).all<{source_ordinal:number}>():{results:[]};
  const existingOrdinals=new Set(existingSlots.results.map((row)=>Number(row.source_ordinal)));
  const newOfferSlots=[...requestedOrdinals].filter((ordinal)=>!existingOrdinals.has(ordinal)).length;
  if(newOfferSlots){
    const retained=await db.prepare("SELECT COUNT(*) AS count FROM payment_offers p JOIN endpoints e ON e.id=p.endpoint_id WHERE e.service_id=? AND p.source_type='openapi'").bind(serviceId).first<{count:number}>();
    if(Number(retained?.count??0)+newOfferSlots>MAX_RETAINED_OPENAPI_OFFERS_PER_SERVICE)throw new ScanSafetyError("openapi-offer-budget","Per-service retained OpenAPI offer budget is exhausted");
  }
  const next = { url: endpointUrl,http_method:operation.method,path:new URL(endpointUrl).pathname,description:operation.description.slice(0,1000) };
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO endpoints (id,service_id,url,http_method,path,kind,description,openapi_seen_at,first_seen,last_seen) VALUES (?,?,?,?,?,'paid-api',?,?,?,?) ON CONFLICT(id) DO UPDATE SET description=excluded.description,openapi_seen_at=excluded.openapi_seen_at,last_seen=CASE WHEN excluded.last_seen>endpoints.last_seen THEN excluded.last_seen ELSE endpoints.last_seen END,updated_at=${NOW_SQL} WHERE endpoints.openapi_seen_at IS NULL OR excluded.openapi_seen_at>=endpoints.openapi_seen_at`).bind(endpointId,serviceId,endpointUrl,operation.method,next.path,next.description,observedAt,observedAt,observedAt),
    endpointSourceStatement(db,endpointId,"openapi",sourceRef,observedAt,!snapshotManaged),
  ];
  for (const [sourceOrdinal,offer] of operation.offers.entries()) statements.push(...await offerStatements(db,serviceId,endpointId,openApiPayment(offer),observedAt,sourceRef,offerOffset+sourceOrdinal,snapshotManaged));
  try{await db.batch(statements);}catch(error){
    if(error instanceof Error&&/openapi endpoint budget exceeded/i.test(error.message))throw new ScanSafetyError("openapi-endpoint-budget","Per-service retained OpenAPI endpoint budget is exhausted");
    if(error instanceof Error&&/openapi offer budget exceeded/i.test(error.message))throw new ScanSafetyError("openapi-offer-budget","Per-service retained OpenAPI offer budget is exhausted");
    throw error;
  }
  return endpointId;
}

export async function offerStatements(db: D1Database, serviceId: string, endpointId: string, offer: PaymentOffer, observedAt: string, sourceRefOrOrdinal:string|number=offer.sourceType, sourceOrdinal=0, deferActivation=false): Promise<D1PreparedStatement[]> {
  const normalized=normalizeOffer(offer);
  const sourceRef=(typeof sourceRefOrOrdinal==="string"?sourceRefOrOrdinal:normalized.sourceType).slice(0,2_048);
  const ordinal=typeof sourceRefOrOrdinal==="number"?sourceRefOrOrdinal:sourceOrdinal;
  const activateImmediately=normalized.sourceType==="challenge"||!deferActivation?1:0;
  const next = { method:normalized.method,intent:normalized.intent,currency:normalized.currency,chain_id:normalized.chainId,recipient:normalized.recipient,amount:normalized.amount,decimals:normalized.decimals,unit_type:normalized.unitType,session_json:normalized.session?boundedJson(normalized.session,4_096):null,source_type:normalized.sourceType,source_ref:sourceRef,source_ordinal:Math.max(0,Math.min(31,Math.trunc(ordinal))) };
  // Source ordinal preserves simultaneous alternatives while keeping a stable
  // slot when method, chain, currency, recipient, price, or session terms move.
  const id = await sha256(safeJson([endpointId,next.source_type,next.source_ref,next.source_ordinal]));
  const values=[id,endpointId,normalized.method,normalized.intent,normalized.currency,normalized.chainId,normalized.recipient,normalized.amount,normalized.decimals,normalized.unitType,next.session_json,normalized.sourceType,next.source_ref,next.source_ordinal,activateImmediately,observedAt,observedAt,observedAt];
  const select=normalized.sourceType==="challenge"?`SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM endpoints guard WHERE guard.id=? AND (guard.last_probe_at IS NULL OR guard.last_probe_at<=?))`:`VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  return [db.prepare(`INSERT INTO payment_offers (id,endpoint_id,method,intent,currency,chain_id,recipient,amount,decimals,unit_type,session_json,source_type,source_ref,source_ordinal,active,first_seen,last_seen,observed_at) ${select} ON CONFLICT(id) DO UPDATE SET method=excluded.method,intent=excluded.intent,currency=excluded.currency,chain_id=excluded.chain_id,recipient=excluded.recipient,amount=excluded.amount,decimals=excluded.decimals,unit_type=excluded.unit_type,session_json=excluded.session_json,source_type=excluded.source_type,source_ref=excluded.source_ref,active=CASE WHEN excluded.active=1 THEN 1 ELSE payment_offers.active END,last_seen=excluded.last_seen,observed_at=excluded.observed_at,updated_at=${NOW_SQL} WHERE excluded.observed_at>=payment_offers.observed_at`).bind(...values,...(normalized.sourceType==="challenge"?[endpointId,observedAt]:[]))];
}

async function stageSnapshotOffer(db:D1Database,snapshotId:string,serviceId:string,endpointId:string,offer:PaymentOffer,observedAt:string,sourceRefOrOrdinal:string|number=offer.sourceType,sourceOrdinal=0):Promise<void>{
  const normalized=normalizeOffer(offer);
  const sourceRef=(typeof sourceRefOrOrdinal==="string"?sourceRefOrOrdinal:normalized.sourceType).slice(0,2_048);
  const ordinal=typeof sourceRefOrOrdinal==="number"?sourceRefOrOrdinal:sourceOrdinal;
  const boundedOrdinal=Math.max(0,Math.min(31,Math.trunc(ordinal)));
  const sessionJson=normalized.session?boundedJson(normalized.session,4_096):null;
  const offerId=await sha256(safeJson([endpointId,normalized.sourceType,sourceRef,boundedOrdinal]));
  await db.prepare(`INSERT INTO source_snapshot_offer_stage (snapshot_id,offer_id,endpoint_id,service_id,method,intent,currency,chain_id,recipient,amount,decimals,unit_type,session_json,source_type,source_ref,source_ordinal,first_seen,last_seen)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(snapshot_id,offer_id) DO UPDATE SET method=excluded.method,intent=excluded.intent,currency=excluded.currency,chain_id=excluded.chain_id,recipient=excluded.recipient,amount=excluded.amount,decimals=excluded.decimals,unit_type=excluded.unit_type,session_json=excluded.session_json,last_seen=excluded.last_seen`)
    .bind(snapshotId,offerId,endpointId,serviceId,normalized.method,normalized.intent,normalized.currency,normalized.chainId,normalized.recipient,normalized.amount,normalized.decimals,normalized.unitType,sessionJson,normalized.sourceType,sourceRef,boundedOrdinal,observedAt,observedAt).run();
}

export async function startSourceSnapshot(db:D1Database,input:{id:string;serviceId:string;sourceType:"catalog"|"openapi"|"api-catalog";sourceRef:string;observedAt:string;expectedItems:number}):Promise<void>{
  await db.prepare("INSERT OR IGNORE INTO source_snapshots (id,service_id,source_type,source_ref,observed_at,expected_items,status) VALUES (?,?,?,?,?,?,'running')").bind(input.id,input.serviceId,input.sourceType,input.sourceRef.slice(0,2_048),input.observedAt,Math.max(0,Math.min(10_000,Math.trunc(input.expectedItems)))).run();
}

export async function sourceSnapshotStatus(db:D1Database,snapshotId:string):Promise<SourceSnapshotStatus|null>{
  const row=await db.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(snapshotId).first<{status:SourceSnapshotStatus}>();
  return row?.status??null;
}

/**
 * Abandon one incomplete document barrier without touching any published source
 * membership. Repeated calls also sweep stage rows left by an in-flight item
 * that lost a race with the first failure transition.
 */
export async function failSourceSnapshot(db:D1Database,snapshotId:string,errorDetail:string,failedAt=new Date().toISOString()):Promise<boolean>{
  const snapshot=await db.prepare("SELECT service_id,source_type,source_ref,observed_at,status FROM source_snapshots WHERE id=?").bind(snapshotId).first<{service_id:string;source_type:string;source_ref:string;observed_at:string;status:SourceSnapshotStatus}>();
  if(!snapshot||snapshot.status==="complete")return false;
  const detail=redactText(errorDetail).slice(0,500)||"source-snapshot-failed";
  await db.batch([
    db.prepare("UPDATE source_snapshots SET status='failed',finished_at=COALESCE(finished_at,?),error_detail=COALESCE(error_detail,?) WHERE id=? AND status IN ('running','failed')").bind(failedAt,detail,snapshotId),
    db.prepare(`DELETE FROM crawl_targets WHERE service_id=? AND last_attempt_at IS NULL
      AND id IN (SELECT introduced.target_id FROM crawl_target_sources introduced
        WHERE introduced.source_type=? AND introduced.source_ref=? AND introduced.first_seen=? AND introduced.observed_at=?)
      AND NOT EXISTS (SELECT 1 FROM crawl_target_sources other WHERE other.target_id=crawl_targets.id
        AND NOT (other.source_type=? AND other.source_ref=? AND other.first_seen=? AND other.observed_at=?))`)
      .bind(snapshot.service_id,snapshot.source_type,snapshot.source_ref,snapshot.observed_at,snapshot.observed_at,snapshot.source_type,snapshot.source_ref,snapshot.observed_at,snapshot.observed_at),
    db.prepare(`DELETE FROM crawl_targets WHERE service_id=? AND last_attempt_at IS NULL
      AND id IN (SELECT target_id FROM source_snapshot_target_stage WHERE snapshot_id=? AND introduced=1)
      AND NOT EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id)
      AND NOT EXISTS (SELECT 1 FROM source_snapshot_target_stage other WHERE other.target_id=crawl_targets.id AND other.snapshot_id<>?)`)
      .bind(snapshot.service_id,snapshotId,snapshotId),
    db.prepare("DELETE FROM source_snapshot_target_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare(`DELETE FROM crawl_targets WHERE service_id=? AND status='retired' AND last_attempt_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id)
      AND NOT EXISTS (SELECT 1 FROM source_snapshot_target_stage staged WHERE staged.target_id=crawl_targets.id)`).bind(snapshot.service_id),
    db.prepare(`DELETE FROM endpoints WHERE service_id=? AND published=0
      AND id IN (SELECT endpoint_id FROM source_snapshot_endpoint_stage WHERE snapshot_id=?)
      AND NOT EXISTS (SELECT 1 FROM endpoint_sources source WHERE source.endpoint_id=endpoints.id)
      AND NOT EXISTS (SELECT 1 FROM observations observation WHERE observation.endpoint_id=endpoints.id)
      AND NOT EXISTS (SELECT 1 FROM crawl_targets target WHERE target.endpoint_id=endpoints.id)
      AND NOT EXISTS (SELECT 1 FROM source_snapshot_endpoint_stage other WHERE other.endpoint_id=endpoints.id AND other.snapshot_id<>?)`).bind(snapshot.service_id,snapshotId,snapshotId),
    db.prepare("DELETE FROM source_snapshot_offer_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("DELETE FROM source_snapshot_endpoint_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("DELETE FROM source_snapshot_service_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("DELETE FROM source_snapshot_items WHERE snapshot_id=?").bind(snapshotId),
  ]);
  return true;
}

/** Bounded Cron backstop for deliveries that disappeared into a DLQ. */
export async function failStaleSourceSnapshots(db:D1Database,now=new Date().toISOString()):Promise<number>{
  const nowMs=Date.parse(now);
  if(!Number.isFinite(nowMs))throw new Error("invalid-snapshot-cleanup-time");
  const cutoff=new Date(nowMs-SOURCE_SNAPSHOT_STALE_MS).toISOString();
  const stale=await db.prepare("SELECT id FROM source_snapshots WHERE status='running' AND observed_at<=? ORDER BY observed_at,id LIMIT ?").bind(cutoff,STALE_SNAPSHOT_CLEANUP_LIMIT).all<{id:string}>();
  for(const snapshot of stale.results)await failSourceSnapshot(db,snapshot.id,"stale-snapshot-timeout",now);
  return stale.results.length;
}

export async function stageOpenApiServiceInfo(db:D1Database,snapshotId:string,serviceId:string,info:{name?:string;description?:string}|null):Promise<void>{
  if(!info)return;
  const before=await db.prepare("SELECT name,description,status FROM services WHERE id=?").bind(serviceId).first<{name:string;description:string;status:string}>();
  if(!before||!["candidate","pending","observed-mpp"].includes(before.status))return;
  const name=info.name?redactText(info.name.slice(0,200)):null;
  const description=info.description?redactText(info.description.slice(0,2_000)):null;
  if(name===null&&description===null)return;
  await db.prepare(`INSERT INTO source_snapshot_service_stage (snapshot_id,service_id,name,description,full_replace)
    SELECT ?,?,?,?,0 WHERE EXISTS (SELECT 1 FROM source_snapshots snapshot WHERE snapshot.id=? AND snapshot.status='running')
    ON CONFLICT(snapshot_id) DO UPDATE SET name=excluded.name,description=excluded.description,full_replace=0`)
    .bind(snapshotId,serviceId,name,description,snapshotId).run();
}

export async function recordSourceSnapshotItem(db:D1Database,snapshotId:string,itemId:string,processedAt:string):Promise<void>{
  await db.prepare("INSERT OR IGNORE INTO source_snapshot_items (snapshot_id,item_id,processed_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM source_snapshots snapshot WHERE snapshot.id=? AND snapshot.status='running')").bind(snapshotId,itemId.slice(0,500),processedAt,snapshotId).run();
  await reconcileSourceSnapshot(db,snapshotId);
}

export async function reconcileSourceSnapshot(db:D1Database,snapshotId:string):Promise<boolean>{
  const snapshot=await db.prepare("SELECT service_id,source_type,source_ref,observed_at,expected_items,status FROM source_snapshots WHERE id=?").bind(snapshotId).first<{service_id:string;source_type:"catalog"|"openapi"|"api-catalog";source_ref:string;observed_at:string;expected_items:number;status:string}>();
  if(!snapshot)return false;
  if(snapshot.status==="complete")return true;
  if(snapshot.status!=="running")return false;
  const progress=await db.prepare("SELECT COUNT(*) AS processed FROM source_snapshot_items WHERE snapshot_id=?").bind(snapshotId).first<{processed:number}>();
  if(Number(progress?.processed??0)<Number(snapshot.expected_items))return false;
  const noNewer="NOT EXISTS (SELECT 1 FROM source_snapshots newer WHERE newer.service_id=? AND newer.source_type=? AND newer.source_ref=? AND newer.observed_at>? AND newer.status='complete')";
  // A completed global catalog run is authoritative even for services it
  // omitted, so a delayed per-service message from an older run must not
  // activate rows that did not exist when the global absence was reconciled.
  const noNewerGlobalCatalog=snapshot.source_type==="catalog"
    ? " AND NOT EXISTS (SELECT 1 FROM discovery_runs newer_run WHERE newer_run.source_kind='mpp.dev-catalog' AND newer_run.source_url=? AND newer_run.started_at>? AND newer_run.status='complete')"
    : "";
  const authority=`${noNewer}${noNewerGlobalCatalog}`;
  const authorityBinds:unknown[]=[snapshot.service_id,snapshot.source_type,snapshot.source_ref,snapshot.observed_at];
  if(snapshot.source_type==="catalog")authorityBinds.push(snapshot.source_ref,snapshot.observed_at);
  const statements:D1PreparedStatement[]=[];
  if(snapshot.source_type!=="api-catalog"){
    const stagedService=await db.prepare("SELECT name,homepage_url,service_url,origin,description,categories_json,tags_json,status,full_replace FROM source_snapshot_service_stage WHERE snapshot_id=?").bind(snapshotId).first<Record<string,unknown>>();
    if(stagedService){
      if(snapshot.source_type==="catalog")statements.push(db.prepare(`UPDATE services SET name=?,homepage_url=?,service_url=?,origin=?,description=?,categories_json=?,tags_json=?,status=?,published=1,catalog_ingest_at=?,catalog_seen_at=?,last_seen=CASE WHEN last_seen<? THEN ? ELSE last_seen END,updated_at=${NOW_SQL} WHERE id=? AND ${authority}`)
        .bind(stagedService.name,stagedService.homepage_url,stagedService.service_url,stagedService.origin,stagedService.description,stagedService.categories_json,stagedService.tags_json,stagedService.status,snapshot.observed_at,snapshot.observed_at,snapshot.observed_at,snapshot.observed_at,snapshot.service_id,...authorityBinds));
      else statements.push(db.prepare(`UPDATE services SET name=COALESCE(?,name),description=COALESCE(?,description),published=1,openapi_ingest_at=?,openapi_seen_at=?,last_seen=CASE WHEN last_seen<? THEN ? ELSE last_seen END,updated_at=${NOW_SQL} WHERE id=? AND ${authority}`)
        .bind(stagedService.name,stagedService.description,snapshot.observed_at,snapshot.observed_at,snapshot.observed_at,snapshot.observed_at,snapshot.service_id,...authorityBinds));
    }
    statements.push(
      db.prepare(`INSERT INTO endpoints (id,service_id,url,http_method,path,kind,description,published,${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"},first_seen,last_seen)
        SELECT staged.endpoint_id,staged.service_id,staged.url,staged.http_method,staged.path,staged.kind,staged.description,1,?,staged.first_seen,staged.last_seen
        FROM source_snapshot_endpoint_stage staged WHERE staged.snapshot_id=? AND ${authority}
        ON CONFLICT(id) DO UPDATE SET url=excluded.url,http_method=excluded.http_method,path=excluded.path,kind=excluded.kind,description=excluded.description,published=1,${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"}=excluded.${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"},last_seen=CASE WHEN excluded.last_seen>endpoints.last_seen THEN excluded.last_seen ELSE endpoints.last_seen END,updated_at=${NOW_SQL}
        WHERE endpoints.${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"} IS NULL OR excluded.${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"}>=endpoints.${snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at"}`)
        .bind(snapshot.observed_at,snapshotId,...authorityBinds),
      db.prepare(`INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active)
        SELECT staged.endpoint_id,staged.source_type,staged.source_ref,staged.first_seen,staged.last_seen,?,1
        FROM source_snapshot_endpoint_stage staged WHERE staged.snapshot_id=? AND ${authority}
        ON CONFLICT(endpoint_id,source_type,source_ref) DO UPDATE SET last_seen=excluded.last_seen,observed_at=excluded.observed_at,active=1
        WHERE excluded.observed_at>=endpoint_sources.observed_at`).bind(snapshot.observed_at,snapshotId,...authorityBinds),
      db.prepare(`INSERT INTO payment_offers (id,endpoint_id,method,intent,currency,chain_id,recipient,amount,decimals,unit_type,session_json,source_type,source_ref,source_ordinal,active,first_seen,last_seen,observed_at)
        SELECT staged.offer_id,staged.endpoint_id,staged.method,staged.intent,staged.currency,staged.chain_id,staged.recipient,staged.amount,staged.decimals,staged.unit_type,staged.session_json,staged.source_type,staged.source_ref,staged.source_ordinal,1,staged.first_seen,staged.last_seen,?
        FROM source_snapshot_offer_stage staged WHERE staged.snapshot_id=? AND ${authority}
        ON CONFLICT(id) DO UPDATE SET method=excluded.method,intent=excluded.intent,currency=excluded.currency,chain_id=excluded.chain_id,recipient=excluded.recipient,amount=excluded.amount,decimals=excluded.decimals,unit_type=excluded.unit_type,session_json=excluded.session_json,source_type=excluded.source_type,source_ref=excluded.source_ref,source_ordinal=excluded.source_ordinal,active=1,last_seen=excluded.last_seen,observed_at=excluded.observed_at,updated_at=${NOW_SQL}
        WHERE excluded.observed_at>=payment_offers.observed_at`).bind(snapshot.observed_at,snapshotId,...authorityBinds),
    );
  }
  statements.push(
    db.prepare(`INSERT INTO crawl_target_sources (target_id,source_type,source_ref,first_seen,last_seen,observed_at,active)
      SELECT staged.target_id,staged.source_type,staged.source_ref,staged.observed_at,staged.observed_at,staged.observed_at,1
      FROM source_snapshot_target_stage staged WHERE staged.snapshot_id=? AND ${authority}
      ON CONFLICT(target_id,source_type,source_ref) DO UPDATE SET last_seen=excluded.last_seen,observed_at=excluded.observed_at,active=1
      WHERE excluded.observed_at>=crawl_target_sources.observed_at`).bind(snapshotId,...authorityBinds),
    db.prepare(`UPDATE crawl_targets SET status='retry',next_due_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE id IN (SELECT target_id FROM source_snapshot_target_stage WHERE snapshot_id=?)
        AND status IN ('retired','rejected')
        AND EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id AND source.active=1)`).bind(snapshotId),
    db.prepare(`UPDATE endpoint_sources SET active=CASE WHEN last_seen>=? THEN 1 ELSE 0 END,observed_at=? WHERE source_type=? AND source_ref=? AND endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?) AND observed_at<=? AND ${authority}`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.source_type,snapshot.source_ref,snapshot.service_id,snapshot.observed_at,...authorityBinds),
    db.prepare(`UPDATE payment_offers SET active=CASE WHEN last_seen>=? THEN 1 ELSE 0 END,observed_at=? WHERE source_type=? AND source_ref=? AND endpoint_id IN (SELECT id FROM endpoints WHERE service_id=?) AND observed_at<=? AND ${authority}`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.source_type,snapshot.source_ref,snapshot.service_id,snapshot.observed_at,...authorityBinds),
    db.prepare(`UPDATE crawl_target_sources SET active=CASE WHEN last_seen>=? THEN 1 ELSE 0 END,observed_at=? WHERE source_type=? AND source_ref=? AND target_id IN (SELECT id FROM crawl_targets WHERE service_id=?) AND observed_at<=? AND ${authority}`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.source_type,snapshot.source_ref,snapshot.service_id,snapshot.observed_at,...authorityBinds),
    // RFC 9727 link targets derive their authority from the API-catalog probe
    // whose URL is stored as source_ref. Retire them before cascading their
    // OpenAPI descendants when that parent loses every active source.
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE source_type='api-catalog' AND active=1 AND observed_at<=? AND target_id IN (
      SELECT child.id FROM crawl_targets child WHERE child.service_id=? AND EXISTS (
        SELECT 1 FROM crawl_targets parent WHERE parent.service_id=child.service_id AND parent.target_kind='api-catalog' AND parent.normalized_url=crawl_target_sources.source_ref
          AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
          AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
      )
    )`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.service_id),
    // When an advertised OpenAPI document loses every active provenance, its
    // derived endpoint records and scheduled child probes are historical, not
    // current. Explicitly deactivate them so the change timeline records the
    // withdrawal and a later restoration must re-probe the document.
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND target_id IN (
      SELECT child.id FROM crawl_targets child WHERE child.service_id=? AND EXISTS (
        SELECT 1 FROM crawl_targets parent WHERE parent.service_id=child.service_id AND parent.target_kind='openapi' AND parent.normalized_url=crawl_target_sources.source_ref
          AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
          AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
      )
    )`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.service_id),
    db.prepare(`UPDATE endpoint_sources SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND endpoint_id IN (
      SELECT e.id FROM endpoints e WHERE e.service_id=? AND EXISTS (
        SELECT 1 FROM crawl_targets parent WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=endpoint_sources.source_ref
          AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
          AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
      )
    )`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.service_id),
    db.prepare(`UPDATE payment_offers SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND endpoint_id IN (
      SELECT e.id FROM endpoints e WHERE e.service_id=? AND EXISTS (
        SELECT 1 FROM crawl_targets parent WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=payment_offers.source_ref
          AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
          AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
      )
    )`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.service_id),
  );
  if(snapshot.source_type!=="api-catalog"){
    const clockColumn=snapshot.source_type==="catalog"?"catalog_seen_at":"openapi_seen_at";
    statements.push(db.prepare(`UPDATE services SET ${clockColumn}=CASE WHEN ${clockColumn} IS NULL OR ${clockColumn}<=? THEN ? ELSE ${clockColumn} END,updated_at=${NOW_SQL} WHERE id=? AND ${authority}`).bind(snapshot.observed_at,snapshot.observed_at,snapshot.service_id,...authorityBinds));
  }
  statements.push(
    db.prepare("DELETE FROM source_snapshot_target_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare(`DELETE FROM crawl_targets WHERE service_id=? AND status='retired' AND last_attempt_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=crawl_targets.id)
      AND NOT EXISTS (SELECT 1 FROM source_snapshot_target_stage staged WHERE staged.target_id=crawl_targets.id)`).bind(snapshot.service_id),
    db.prepare("DELETE FROM endpoints WHERE service_id=? AND published=0 AND id IN (SELECT endpoint_id FROM source_snapshot_endpoint_stage WHERE snapshot_id=?) AND NOT EXISTS (SELECT 1 FROM endpoint_sources es WHERE es.endpoint_id=endpoints.id) AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.endpoint_id=endpoints.id)").bind(snapshot.service_id,snapshotId),
    db.prepare("DELETE FROM source_snapshot_offer_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("DELETE FROM source_snapshot_endpoint_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("DELETE FROM source_snapshot_service_stage WHERE snapshot_id=?").bind(snapshotId),
    db.prepare("UPDATE source_snapshots SET status='complete',finished_at=? WHERE id=? AND status='running'").bind(new Date().toISOString(),snapshotId),
  );
  await db.batch(statements);
  return true;
}

function endpointSourceStatement(db:D1Database,endpointId:string,sourceType:"catalog"|"openapi"|"challenge",sourceRef:string,observedAt:string,activate=sourceType==="challenge"):D1PreparedStatement{
  const activateImmediately=activate?1:0;
  return db.prepare("INSERT INTO endpoint_sources (endpoint_id,source_type,source_ref,first_seen,last_seen,observed_at,active) VALUES (?,?,?,?,?,?,?) ON CONFLICT(endpoint_id,source_type,source_ref) DO UPDATE SET last_seen=excluded.last_seen,observed_at=excluded.observed_at,active=CASE WHEN excluded.active=1 THEN 1 ELSE endpoint_sources.active END WHERE excluded.observed_at>=endpoint_sources.observed_at").bind(endpointId,sourceType,sourceRef.slice(0,2_048),observedAt,observedAt,observedAt,activateImmediately);
}

export async function sourceSnapshotItemProcessed(db:D1Database,snapshotId:string,itemId:string):Promise<boolean>{return Boolean(await db.prepare("SELECT 1 AS present FROM source_snapshot_items WHERE snapshot_id=? AND item_id=?").bind(snapshotId,itemId.slice(0,500)).first());}

export async function recordCatalogRunService(db:D1Database,runId:string,serviceId:string,snapshotId:string,processedAt:string):Promise<boolean>{
  const snapshot=await db.prepare("SELECT status FROM source_snapshots WHERE id=?").bind(snapshotId).first<{status:string}>();
  if(snapshot?.status!=="complete")return false;
  await db.prepare("INSERT OR IGNORE INTO discovery_run_services (run_id,service_id,processed_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM discovery_runs WHERE id=? AND source_kind='mpp.dev-catalog' AND status='processing')").bind(runId,serviceId,processedAt,runId).run();
  return reconcileCatalogRun(db,runId);
}

export async function reconcileCatalogRun(db:D1Database,runId:string):Promise<boolean>{
  const run=await db.prepare("SELECT source_url,started_at,expected_services,status FROM discovery_runs WHERE id=? AND source_kind='mpp.dev-catalog'").bind(runId).first<{source_url:string;started_at:string;expected_services:number;status:string}>();
  if(!run||run.status==="complete")return Boolean(run);
  if(run.status!=="processing")return false;
  const progress=await db.prepare("SELECT COUNT(*) AS processed FROM discovery_run_services WHERE run_id=?").bind(runId).first<{processed:number}>();
  if(Number(progress?.processed??0)<Number(run.expected_services))return false;
  const noNewer="NOT EXISTS (SELECT 1 FROM discovery_runs newer WHERE newer.source_kind='mpp.dev-catalog' AND newer.source_url=? AND newer.started_at>? AND newer.status='complete')";
  await db.batch([
    db.prepare(`UPDATE endpoint_sources SET active=0,observed_at=? WHERE source_type='catalog' AND source_ref=? AND observed_at<=? AND endpoint_id IN (SELECT e.id FROM endpoints e WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=e.service_id)) AND ${noNewer}`).bind(run.started_at,run.source_url,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE payment_offers SET active=0,observed_at=? WHERE source_type='catalog' AND source_ref=? AND observed_at<=? AND endpoint_id IN (SELECT e.id FROM endpoints e WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=e.service_id)) AND ${noNewer}`).bind(run.started_at,run.source_url,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE source_type='catalog' AND source_ref=? AND observed_at<=? AND target_id IN (SELECT ct.id FROM crawl_targets ct WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=ct.service_id)) AND ${noNewer}`).bind(run.started_at,run.source_url,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE source_type='api-catalog' AND active=1 AND observed_at<=? AND target_id IN (
      SELECT child.id FROM crawl_targets child
      WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=child.service_id)
        AND EXISTS (
          SELECT 1 FROM crawl_targets parent WHERE parent.service_id=child.service_id AND parent.target_kind='api-catalog' AND parent.normalized_url=crawl_target_sources.source_ref
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        )
    ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND target_id IN (
      SELECT child.id FROM crawl_targets child
      WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=child.service_id)
        AND EXISTS (
          SELECT 1 FROM crawl_targets parent WHERE parent.service_id=child.service_id AND parent.target_kind='openapi' AND parent.normalized_url=crawl_target_sources.source_ref
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        )
    ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE endpoint_sources SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND endpoint_id IN (
      SELECT e.id FROM endpoints e
      WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=e.service_id)
        AND EXISTS (
          SELECT 1 FROM crawl_targets parent WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=endpoint_sources.source_ref
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        )
    ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE payment_offers SET active=0,observed_at=? WHERE source_type='openapi' AND active=1 AND observed_at<=? AND endpoint_id IN (
      SELECT e.id FROM endpoints e
      WHERE NOT EXISTS (SELECT 1 FROM discovery_run_services seen WHERE seen.run_id=? AND seen.service_id=e.service_id)
        AND EXISTS (
          SELECT 1 FROM crawl_targets parent WHERE parent.service_id=e.service_id AND parent.target_kind='openapi' AND parent.normalized_url=payment_offers.source_ref
            AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
            AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
        )
    ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare("UPDATE discovery_runs SET status='complete',finished_at=? WHERE id=? AND status='processing'").bind(new Date().toISOString(),runId),
  ]);
  return true;
}

/**
 * Records one fully scheduled member of an authoritative anonymous MPPScan run.
 * The run is not authoritative until every normalized origin from the parsed
 * page has reached this point, so a partial Queue delivery cannot withdraw the
 * last-known membership.
 */
export async function recordMppScanRunService(db:D1Database,runId:string,serviceId:string,processedAt:string):Promise<boolean>{
  await db.prepare("INSERT OR IGNORE INTO discovery_run_services (run_id,service_id,processed_at) SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM discovery_runs WHERE id=? AND source_kind='mppscan-html' AND status='processing')").bind(runId,serviceId,processedAt,runId).run();
  return reconcileMppScanRun(db,runId);
}

/**
 * Reconciles MPPScan's current crawl authority after a complete Queue barrier.
 * Historical service/source rows remain available as provenance; only active
 * crawl authority and discovery data derived solely from withdrawn parents are
 * retired. A newer completed run always wins over delayed older deliveries.
 */
export async function reconcileMppScanRun(db:D1Database,runId:string):Promise<boolean>{
  const run=await db.prepare("SELECT source_url,started_at,expected_services,status FROM discovery_runs WHERE id=? AND source_kind='mppscan-html'").bind(runId).first<{source_url:string;started_at:string;expected_services:number;status:string}>();
  if(!run||run.status==="complete")return Boolean(run);
  if(run.status!=="processing")return false;
  const progress=await db.prepare("SELECT COUNT(*) AS processed FROM discovery_run_services WHERE run_id=?").bind(runId).first<{processed:number}>();
  if(Number(progress?.processed??0)<Number(run.expected_services))return false;
  const noNewer="NOT EXISTS (SELECT 1 FROM discovery_runs newer WHERE newer.source_kind='mppscan-html' AND newer.source_url=? AND newer.started_at>? AND newer.status='complete')";
  await db.batch([
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=?
      WHERE source_type='mppscan' AND source_ref=? AND active=1 AND observed_at<=?
        AND target_id IN (
          SELECT target.id FROM crawl_targets target
          WHERE NOT EXISTS (
            SELECT 1 FROM discovery_run_services seen
            WHERE seen.run_id=? AND seen.service_id=target.service_id
          )
        ) AND ${noNewer}`).bind(run.started_at,run.source_url,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=?
      WHERE source_type='api-catalog' AND active=1 AND observed_at<=?
        AND target_id IN (
          SELECT child.id FROM crawl_targets child
          WHERE NOT EXISTS (
              SELECT 1 FROM discovery_run_services seen
              WHERE seen.run_id=? AND seen.service_id=child.service_id
            )
            AND EXISTS (
              SELECT 1 FROM crawl_targets parent
              WHERE parent.service_id=child.service_id
                AND parent.target_kind='api-catalog'
                AND parent.normalized_url=crawl_target_sources.source_ref
                AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
                AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
            )
        ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=?
      WHERE source_type='openapi' AND active=1 AND observed_at<=?
        AND target_id IN (
          SELECT child.id FROM crawl_targets child
          WHERE NOT EXISTS (
              SELECT 1 FROM discovery_run_services seen
              WHERE seen.run_id=? AND seen.service_id=child.service_id
            )
            AND EXISTS (
              SELECT 1 FROM crawl_targets parent
              WHERE parent.service_id=child.service_id
                AND parent.target_kind='openapi'
                AND parent.normalized_url=crawl_target_sources.source_ref
                AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
                AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
            )
        ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE endpoint_sources SET active=0,observed_at=?
      WHERE source_type='openapi' AND active=1 AND observed_at<=?
        AND endpoint_id IN (
          SELECT endpoint.id FROM endpoints endpoint
          WHERE NOT EXISTS (
              SELECT 1 FROM discovery_run_services seen
              WHERE seen.run_id=? AND seen.service_id=endpoint.service_id
            )
            AND EXISTS (
              SELECT 1 FROM crawl_targets parent
              WHERE parent.service_id=endpoint.service_id
                AND parent.target_kind='openapi'
                AND parent.normalized_url=endpoint_sources.source_ref
                AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
                AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
            )
        ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare(`UPDATE payment_offers SET active=0,observed_at=?
      WHERE source_type='openapi' AND active=1 AND observed_at<=?
        AND endpoint_id IN (
          SELECT endpoint.id FROM endpoints endpoint
          WHERE NOT EXISTS (
              SELECT 1 FROM discovery_run_services seen
              WHERE seen.run_id=? AND seen.service_id=endpoint.service_id
            )
            AND EXISTS (
              SELECT 1 FROM crawl_targets parent
              WHERE parent.service_id=endpoint.service_id
                AND parent.target_kind='openapi'
                AND parent.normalized_url=payment_offers.source_ref
                AND EXISTS (SELECT 1 FROM crawl_target_sources any_parent WHERE any_parent.target_id=parent.id)
                AND NOT EXISTS (SELECT 1 FROM crawl_target_sources active_parent WHERE active_parent.target_id=parent.id AND active_parent.active=1)
            )
        ) AND ${noNewer}`).bind(run.started_at,run.started_at,runId,run.source_url,run.started_at),
    db.prepare("UPDATE discovery_runs SET status='complete',finished_at=? WHERE id=? AND status='processing'").bind(new Date().toISOString(),runId),
  ]);
  return true;
}

function catalogPayment(value: Record<string, unknown>): PaymentOffer {
  const details = value.methodDetails && typeof value.methodDetails === "object" ? value.methodDetails as Record<string, unknown> : {};
  return { method:String(value.method??"unknown"),intent:String(value.intent??"charge"),amount:stringOrNull(value.amount),currency:stringOrNull(value.currency),recipient:stringOrNull(value.recipient),chainId:stringOrNull(value.chainId??details.chainId),decimals:numberOrNull(value.decimals??details.decimals),unitType:stringOrNull(value.unitType),session:extractSession(value,details),sourceType:"catalog" };
}

function openApiPayment(value: OpenApiOffer): PaymentOffer {
  const details=objectOrNull(value.methodDetails)??{};
  return { method:String(value.method??"unknown"),intent:String(value.intent??"charge"),amount:stringOrNull(value.amount),currency:stringOrNull(value.currency),recipient:stringOrNull(value.recipient),chainId:stringOrNull(value.chainId??details.chainId),decimals:numberOrNull(value.decimals??details.decimals),unitType:stringOrNull(value.unitType),session:extractSession(value,details),sourceType:"openapi" };
}

function hydrateServiceRow(row: Record<string, unknown>): Record<string, unknown> {
  const {categories_json,tags_json,fingerprint_evidence_json,payment_methods,payment_method_count,...rest}=row;
  return { ...rest, categories: parseJson(categories_json, []), tags: parseJson(tags_json, []), fingerprintEvidence: parseJson(fingerprint_evidence_json, []), paymentMethods: typeof payment_methods === "string" ? payment_methods.split(",") : [], paymentMethodCount: Number(payment_method_count??0) };
}
function parseJson(value: unknown, fallback: unknown): unknown { try { return typeof value === "string" ? JSON.parse(value) : fallback; } catch { return fallback; } }
function stringOrNull(value: unknown): string | null { return typeof value === "string" || typeof value === "number" ? String(value) : null; }
function numberOrNull(value: unknown): number | null { const parsed=Number(value); return Number.isFinite(parsed)?parsed:null; }
function objectOrNull(value: unknown): Record<string,unknown>|null { return value && typeof value==="object" && !Array.isArray(value)?value as Record<string,unknown>:null; }
function slug(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,96) || "service"; }
function optionalUrl(value: string | undefined): string | null { if (!value) return null; try { const normalized=normalizeDiscoveryUrl(value);return redactUrlForStorage(normalized)===normalized?normalized:null; } catch { return null; } }
function parseLimit(value:string|null,fallback:number):number{const parsed=Number(value??fallback);return Number.isFinite(parsed)?Math.min(100,Math.max(1,Math.trunc(parsed)||fallback)):fallback;}
function boundedJson(value:unknown,max:number):string{const serialized=safeJson(redactJsonValue(value));return serialized.length<=max?serialized:safeJson({truncated:true,originalCharacters:serialized.length});}
function normalizeOffer(offer:PaymentOffer):PaymentOffer{return{...offer,method:offer.method.slice(0,40),intent:offer.intent.slice(0,40),currency:clip(offer.currency,200),chainId:clip(offer.chainId,100),recipient:clip(offer.recipient,500),amount:clip(offer.amount,100),unitType:clip(offer.unitType,80),decimals:Number.isSafeInteger(offer.decimals)&&Number(offer.decimals)>=0&&Number(offer.decimals)<=255?offer.decimals:null,session:offer.session?redactJsonValue(offer.session) as Record<string,unknown>:null};}
function clip(value:string|null,max:number):string|null{return value===null?null:value.slice(0,max);}
function extractSession(value:Record<string,unknown>,details:Record<string,unknown>):Record<string,unknown>|null{const known=new Set(["method","intent","amount","currency","recipient","chainId","decimals","unitType","description","methodDetails","offers","protocols","price"]);const nested=objectOrNull(value.session)??{};const extra=Object.fromEntries(Object.entries(value).filter(([key])=>!known.has(key)&&key!=="session"));const detailExtra=Object.fromEntries(Object.entries(details).filter(([key])=>!["chainId","decimals"].includes(key)));const combined={...nested,...extra,...(Object.keys(detailExtra).length?{methodDetails:detailExtra}:{})};return Object.keys(combined).length?combined:null;}
function openApiEndpointUrl(baseUrl:string,path:string):string{if(!path.startsWith("/")||path.length>2_048||/[?#]/.test(path))throw new ScanSafetyError("invalid-openapi-path","OpenAPI paths must be bounded query-free absolute paths");const base=new URL(normalizeDiscoveryUrl(baseUrl));const basePath=base.pathname.replace(/\/$/,"");base.pathname=`${basePath}/${path.replace(/^\//,"")}`.replace(/\/{2,}/g,"/");base.search="";base.hash="";const normalized=normalizeUrl(base.toString());if(redactUrlForStorage(normalized)!==normalized)throw new ScanSafetyError("credential-shaped-openapi-path","Credential-shaped OpenAPI paths are not persisted or probed");return normalized;}
function stripQueryForEvidence(value:string):string{return redactUrlForStorage(value);}
function withoutJsonColumn(row:Record<string,unknown>,column:string,key:string,fallback:unknown):Record<string,unknown>{const copy={...row};const value=copy[column];delete copy[column];copy[key]=parseJson(value,fallback);return copy;}
function hydrateEndpointRow(row:Record<string,unknown>):Record<string,unknown>{const offers=withoutJsonColumn(withoutJsonColumn(row,"offers_json","offers",[]),"active_sources_json","activeSources",[]);const offerTotal=Number(offers.offer_count??0);const sourceTotal=Number(offers.active_source_count??0);delete offers.offer_count;delete offers.active_source_count;return{...offers,offerPagination:{limit:DETAIL_OFFER_LIMIT,total:offerTotal,truncated:offerTotal>DETAIL_OFFER_LIMIT},activeSourcePagination:{limit:32,total:sourceTotal,truncated:sourceTotal>32}};}
