import {
  MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL,
  MAX_RETAINED_MANUAL_CANDIDATES_PER_ORIGIN,
  MAX_SUBMISSIONS_GLOBAL_WINDOW,
  MAX_SUBMISSIONS_PER_CLIENT_WINDOW,
  MANUAL_CANDIDATE_TTL_MS,
  SUBMISSION_WINDOW_MS,
} from "./budgets";
import { sha256 } from "./security";

export type ManualReservation = "reserved" | "duplicate" | "capacity";

/**
 * Consume short-lived, window-scoped submission capacity without retaining a
 * source address. The client token cannot be correlated across windows and is
 * deleted by Cron after at most two windows.
 */
export async function consumeSubmissionBudget(db: D1Database, request: Request, nowMs = Date.now()): Promise<boolean> {
  const started = Math.floor(nowMs / SUBMISSION_WINDOW_MS) * SUBMISSION_WINDOW_MS;
  const expires = new Date(started + SUBMISSION_WINDOW_MS * 2).toISOString();
  const connectingIp=(request.headers.get("cf-connecting-ip")??"unknown").slice(0,128);
  const clientDigest=await sha256(`submission-window-v1|${started}|${connectingIp}`);
  const clientAccepted=await incrementWindow(db,`client:${started}:${clientDigest.slice(0,32)}`,expires,MAX_SUBMISSIONS_PER_CLIENT_WINDOW);
  if(!clientAccepted)return false;
  return incrementWindow(db,`global:${started}`,expires,MAX_SUBMISSIONS_GLOBAL_WINDOW);
}

/**
 * Atomically reserves retained candidate capacity. Confirmed candidates remain
 * useful provenance but no longer consume the unconfirmed-candidate quota.
 */
export async function reserveManualSubmission(
  db:D1Database,
  input:{normalizedUrl:string;origin:string;submittedAt:string;sourceNote:string|null},
):Promise<ManualReservation>{
  const candidateExpiresAt=new Date(new Date(input.submittedAt).getTime()+MANUAL_CANDIDATE_TTL_MS).toISOString();
  const inserted=await db.prepare(`INSERT INTO submissions (normalized_url,origin,submitted_at,status,candidate_expires_at,source_note,last_error)
    SELECT ?,?,?,'queued',?,?,NULL
    WHERE (SELECT COUNT(*) FROM submissions WHERE confirmed_at IS NULL AND candidate_expires_at>?)<?
      AND (SELECT COUNT(*) FROM submissions WHERE confirmed_at IS NULL AND candidate_expires_at>? AND origin=?)<?
    ON CONFLICT(normalized_url) DO NOTHING
    RETURNING normalized_url`)
    .bind(input.normalizedUrl,input.origin,input.submittedAt,candidateExpiresAt,input.sourceNote,input.submittedAt,MAX_RETAINED_MANUAL_CANDIDATES_GLOBAL,input.submittedAt,input.origin,MAX_RETAINED_MANUAL_CANDIDATES_PER_ORIGIN)
    .first<{normalized_url:string}>();
  if(inserted)return"reserved";
  return await db.prepare("SELECT 1 AS present FROM submissions WHERE normalized_url=?").bind(input.normalizedUrl).first()?"duplicate":"capacity";
}

export async function attachManualSubmissionService(db:D1Database,normalizedUrl:string,serviceId:string):Promise<void>{
  await db.prepare("UPDATE submissions SET service_id=? WHERE normalized_url=? AND service_id IS NULL").bind(serviceId,normalizedUrl).run();
}

export async function markManualServiceConfirmed(db:D1Database,serviceId:string,observedAt:string):Promise<void>{
  await db.prepare("UPDATE submissions SET status='confirmed',confirmed_at=COALESCE(confirmed_at,?),last_error=NULL WHERE service_id=?").bind(observedAt,serviceId).run();
}

/**
 * Derived discovery is allowed only by a current authority, never merely by a
 * historical row in `sources`. A valid runtime challenge is durable observed
 * authority; catalog and MPPScan authority is withdrawn with its target
 * provenance snapshot.
 */
export async function serviceAllowsDerivedDiscovery(db:D1Database,serviceId:string):Promise<boolean>{
  return Boolean(await db.prepare(`SELECT 1 AS allowed FROM services service WHERE service.id=? AND (
    service.status='observed-mpp' OR EXISTS (
      SELECT 1 FROM crawl_targets target
      JOIN crawl_target_sources authority ON authority.target_id=target.id
      WHERE target.service_id=service.id AND authority.active=1 AND authority.source_type IN ('catalog','mppscan')
    )
  )`).bind(serviceId).first());
}

export async function hasUnconfirmedManualSubmission(db:D1Database,serviceId:string):Promise<boolean>{
  return Boolean(await db.prepare("SELECT 1 AS pending FROM submissions WHERE service_id=? AND confirmed_at IS NULL LIMIT 1").bind(serviceId).first());
}

/** A manual candidate remains restricted until runtime confirmation or active trusted authority. */
export async function isRestrictedManualCandidate(db:D1Database,serviceId:string):Promise<boolean>{
  const hasManualAuthority=await hasUnconfirmedManualSubmission(db,serviceId)||Boolean(await db.prepare(`SELECT 1 AS manual FROM crawl_targets target
    JOIN crawl_target_sources authority ON authority.target_id=target.id
    WHERE target.service_id=? AND authority.source_type='manual' AND authority.active=1 LIMIT 1`).bind(serviceId).first());
  if(!hasManualAuthority)return false;
  return !await serviceAllowsDerivedDiscovery(db,serviceId);
}

export async function expireManualCandidates(db:D1Database,now=new Date().toISOString()):Promise<void>{
  await db.batch([
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE active=1 AND source_type='manual' AND target_id IN (
      SELECT target.id FROM crawl_targets target JOIN submissions submission ON submission.service_id=target.service_id
      WHERE submission.confirmed_at IS NULL AND submission.candidate_expires_at<=?
    )`).bind(now,now),
    db.prepare(`UPDATE crawl_target_sources SET active=0,observed_at=? WHERE active=1 AND source_type IN ('openapi','api-catalog') AND target_id IN (
      SELECT child.id FROM crawl_targets child JOIN submissions submission ON submission.service_id=child.service_id
      WHERE submission.confirmed_at IS NULL AND submission.candidate_expires_at<=?
        AND source_ref IN (
          SELECT parent.normalized_url FROM crawl_targets parent
          JOIN crawl_target_sources manual_parent ON manual_parent.target_id=parent.id AND manual_parent.source_type='manual'
          WHERE parent.service_id=child.service_id
        )
    )`).bind(now,now),
    db.prepare(`UPDATE crawl_targets SET status='retired',next_due_at=NULL,processing_token=NULL,processing_expires_at=NULL,last_error='manual-candidate-expired',updated_at=CURRENT_TIMESTAMP
      WHERE service_id IN (SELECT service_id FROM submissions WHERE service_id IS NOT NULL AND confirmed_at IS NULL AND candidate_expires_at<=?)
        AND NOT EXISTS (SELECT 1 FROM crawl_target_sources authority WHERE authority.target_id=crawl_targets.id AND authority.active=1)`).bind(now),
    db.prepare(`UPDATE services SET status='unconfirmed',updated_at=CURRENT_TIMESTAMP
      WHERE status IN ('candidate','pending')
        AND id IN (SELECT service_id FROM submissions WHERE service_id IS NOT NULL AND confirmed_at IS NULL AND candidate_expires_at<=?)
        AND NOT EXISTS (
          SELECT 1 FROM crawl_targets target JOIN crawl_target_sources authority ON authority.target_id=target.id
          WHERE target.service_id=services.id AND authority.active=1 AND authority.source_type IN ('catalog','mppscan')
        )`).bind(now),
    db.prepare("UPDATE submissions SET status='expired',last_error=COALESCE(last_error,'candidate-expired') WHERE confirmed_at IS NULL AND candidate_expires_at<=? AND status<>'expired'").bind(now),
  ]);
}

async function incrementWindow(db:D1Database,key:string,expires:string,limit:number):Promise<boolean>{
  const row=await db.prepare(`INSERT INTO submission_rate_windows (window_key,attempt_count,expires_at) VALUES (?,1,?)
    ON CONFLICT(window_key) DO UPDATE SET attempt_count=submission_rate_windows.attempt_count+1,expires_at=excluded.expires_at
    WHERE submission_rate_windows.attempt_count<?
    RETURNING attempt_count`).bind(key,expires,limit).first<{attempt_count:number}>();
  return Boolean(row&&Number(row.attempt_count)<=limit);
}
