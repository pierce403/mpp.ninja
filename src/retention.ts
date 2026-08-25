import {
  COORDINATION_RETENTION_DAYS,
  OBSERVATION_RETENTION_DAYS,
  RETENTION_PRUNE_BATCH,
} from "./budgets";

export interface RetentionResult {
  expiredObjectPointers: number;
  repeatObservations: number;
  inactiveEndpoints: number;
  retiredTargets: number;
  manualOnlyServices: number;
  terminalSubmissions: number;
  originLeases: number;
  sourceSnapshots: number;
  discoveryRuns: number;
}

/**
 * Bounds operational D1 state without erasing the normalized current view or
 * the append-only change feed. R2 independently expires the corresponding
 * `observations/` objects at the same 30-day boundary; D1 retains the latest
 * observation per target plus its body digest after the object pointer ends.
 */
export async function pruneRetainedData(db:D1Database,now=new Date()):Promise<RetentionResult>{
  const observationCutoff=new Date(now.getTime()-OBSERVATION_RETENTION_DAYS*86_400_000).toISOString();
  const coordinationCutoff=new Date(now.getTime()-COORDINATION_RETENTION_DAYS*86_400_000).toISOString();
  const leaseCutoff=new Date(now.getTime()-86_400_000).toISOString();
  const statements=[
    db.prepare(`UPDATE observations SET raw_r2_key=NULL WHERE id IN (
      SELECT id FROM observations WHERE observed_at<? AND raw_r2_key IS NOT NULL
      ORDER BY observed_at,id LIMIT ?
    )`).bind(observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM observations WHERE id IN (
      SELECT old.id FROM observations old WHERE old.observed_at<? AND EXISTS (
        SELECT 1 FROM observations newer
        WHERE newer.service_id=old.service_id AND newer.requested_url=old.requested_url
          AND newer.request_method=old.request_method
          AND (newer.observed_at>old.observed_at OR (newer.observed_at=old.observed_at AND newer.id>old.id))
      ) ORDER BY old.observed_at,old.id LIMIT ?
    )`).bind(observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM endpoints WHERE id IN (
      SELECT endpoint.id FROM endpoints endpoint
      WHERE endpoint.last_seen<?
        AND NOT EXISTS (SELECT 1 FROM endpoint_sources source WHERE source.endpoint_id=endpoint.id AND source.active=1)
        AND NOT EXISTS (SELECT 1 FROM observations recent WHERE recent.endpoint_id=endpoint.id AND recent.observed_at>=?)
        AND NOT EXISTS (SELECT 1 FROM source_snapshot_endpoint_stage staged WHERE staged.endpoint_id=endpoint.id)
      ORDER BY endpoint.last_seen,endpoint.id LIMIT ?
    )`).bind(observationCutoff,observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM crawl_targets WHERE id IN (
      SELECT target.id FROM crawl_targets target
      WHERE target.status IN ('retired','rejected') AND target.updated_at<?
        AND NOT EXISTS (SELECT 1 FROM crawl_target_sources source WHERE source.target_id=target.id AND source.active=1)
        AND NOT EXISTS (SELECT 1 FROM source_snapshot_target_stage staged WHERE staged.target_id=target.id)
      ORDER BY target.updated_at,target.id LIMIT ?
    )`).bind(observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM services WHERE id IN (
      SELECT service.id FROM services service
      WHERE service.status IN ('candidate','pending','unconfirmed') AND service.last_seen<?
        AND EXISTS (SELECT 1 FROM submissions submission WHERE submission.service_id=service.id AND submission.confirmed_at IS NULL AND submission.submitted_at<?)
        AND NOT EXISTS (SELECT 1 FROM submissions submission WHERE submission.service_id=service.id AND submission.confirmed_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM crawl_targets target JOIN crawl_target_sources source ON source.target_id=target.id
          WHERE target.service_id=service.id AND source.active=1 AND source.source_type IN ('catalog','mppscan')
        )
      ORDER BY service.last_seen,service.id LIMIT ?
    )`).bind(observationCutoff,observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM submissions WHERE normalized_url IN (
      SELECT normalized_url FROM submissions
      WHERE service_id IS NULL AND confirmed_at IS NULL AND submitted_at<?
        AND status IN ('unconfirmed','expired','rejected')
      ORDER BY submitted_at,normalized_url LIMIT ?
    )`).bind(observationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM origin_rate_limits WHERE origin IN (
      SELECT origin FROM origin_rate_limits WHERE next_allowed_at<? AND updated_at<?
      ORDER BY updated_at,origin LIMIT ?
    )`).bind(now.toISOString(),leaseCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM source_snapshots WHERE id IN (
      SELECT old.id FROM source_snapshots old
      WHERE old.status IN ('complete','failed') AND old.finished_at<? AND EXISTS (
        SELECT 1 FROM source_snapshots newer
        WHERE newer.service_id=old.service_id AND newer.source_type=old.source_type
          AND newer.source_ref=old.source_ref AND newer.status='complete'
          AND newer.observed_at>old.observed_at
      ) ORDER BY old.finished_at,old.id LIMIT ?
    )`).bind(coordinationCutoff,RETENTION_PRUNE_BATCH),
    db.prepare(`DELETE FROM discovery_runs WHERE id IN (
      SELECT old.id FROM discovery_runs old
      WHERE old.status IN ('complete','failed') AND old.finished_at<? AND EXISTS (
        SELECT 1 FROM discovery_runs newer
        WHERE newer.source_kind=old.source_kind AND newer.source_url=old.source_url
          AND newer.status='complete' AND newer.started_at>old.started_at
      ) ORDER BY old.finished_at,old.id LIMIT ?
    )`).bind(coordinationCutoff,RETENTION_PRUNE_BATCH),
  ];
  const results=await db.batch(statements);
  const changes=(index:number)=>Number(results[index]?.meta.changes??0);
  return{
    expiredObjectPointers:changes(0),repeatObservations:changes(1),inactiveEndpoints:changes(2),
    retiredTargets:changes(3),manualOnlyServices:changes(4),terminalSubmissions:changes(5),
    originLeases:changes(6),sourceSnapshots:changes(7),discoveryRuns:changes(8),
  };
}
