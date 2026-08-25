export const SECURITY_STATES = ["observed", "inferred", "tested-pass", "tested-fail", "unknown", "not-tested"] as const;
export type SecurityState = (typeof SECURITY_STATES)[number];

export type ProbeKind = "endpoint" | "openapi" | "api-catalog" | "homepage";

export interface CrawlMessage {
  type?: "probe";
  runId?: string;
  url: string;
  serviceId?: string;
  endpointId?: string;
  kind: ProbeKind;
  source: "catalog" | "mppscan" | "openapi" | "manual" | "scheduled";
}

export interface CatalogIngestMessage {
  type: "catalog-service";
  service: CatalogService;
  sourceUrl: string;
  observedAt: string;
  discoveryRunId: string;
  snapshotId: string;
  itemId: string;
  expectedItems: number;
}

export interface UrlDiscoveryMessage {
  type: "url-discovery";
  url: string;
  source: "mppscan";
  sourceUrl: string;
  observedAt: string;
  discoveryRunId: string;
}

export interface ApiCatalogLinkMessage {
  type: "api-catalog-link";
  url: string;
  serviceId: string;
  sourceRef: string;
  observedAt: string;
  snapshotId: string;
  itemId: string;
}

export interface DueTargetMessage {
  type: "due-target";
  url: string;
  serviceId?: string;
  endpointId?: string;
  kind: ProbeKind;
}

export interface OpenApiOperationMessage {
  type: "openapi-operation";
  serviceId: string;
  baseUrl: string;
  operation: IngestedOperation;
  offerOffset: number;
  observedAt: string;
  sourceRef: string;
  snapshotId: string;
  itemId: string;
}

export type ObservatoryQueueMessage = CrawlMessage | CatalogIngestMessage | UrlDiscoveryMessage | ApiCatalogLinkMessage | DueTargetMessage | OpenApiOperationMessage;

export interface PaymentOffer {
  method: string;
  intent: string;
  amount: string | null;
  currency: string | null;
  recipient: string | null;
  chainId: string | null;
  decimals: number | null;
  unitType: string | null;
  session: Record<string, unknown> | null;
  sourceType: "catalog" | "openapi" | "challenge";
}

export interface ParsedChallenge {
  method: string;
  intent: string;
  realm: string | null;
  description: string | null;
  expires: string | null;
  idPresent: boolean;
  opaquePresent: boolean;
  opaqueMppxScope: boolean;
  request: Record<string, unknown> | null;
  parseError?: string;
}

export interface DnsEvidence {
  hostname: string;
  addresses: string[];
  stable: boolean;
}

export interface ProbeResult {
  requestedUrl: string;
  finalUrl: string;
  method: "GET" | "HEAD";
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  responseBytes: number;
  redirects: string[];
  dns: DnsEvidence[];
  challenges: ParsedChallenge[];
  observedAt: string;
  tls: { state: SecurityState; httpProtocol: string | null; note: string };
}

export interface Fingerprint {
  implementation: "mppx" | "mpp-rs" | "mpp-proxy" | "custom" | "unknown";
  confidence: number;
  evidence: string[];
}

export interface CatalogService {
  id: string;
  name: string;
  url?: string;
  serviceUrl: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  status?: string;
  docs?: { homepage?: string; llmsTxt?: string; apiReference?: string };
  endpoints?: Array<{
    method?: string;
    path: string;
    description?: string;
    payment?: Record<string, unknown> | null;
  }>;
}

export interface CatalogDocument {
  version: number;
  services: CatalogService[];
}

export interface OpenApiOffer {
  amount?: string | null;
  currency?: string;
  description?: string;
  intent?: string;
  method?: string;
  recipient?: string;
  decimals?: number;
  unitType?: string;
  [key: string]: unknown;
}

export interface IngestedOperation {
  method: string;
  path: string;
  description: string;
  offers: OpenApiOffer[];
}
