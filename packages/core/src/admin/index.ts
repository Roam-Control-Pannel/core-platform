/**
 * @roam/core/admin — the Roam HQ (super-admin) domain layer.
 *
 * Framework-agnostic aggregations over the whole schema, for the staff dashboard.
 * Every function takes a service-role client (RLS-bypassing) supplied by the api's
 * adminProcedure, which has already verified the caller is Roam HQ staff. This module
 * is observe-only in v1; the one privileged write (the audit log) lands in Phase 3.
 */
export * from "./metrics.js";
export * from "./activity.js";
export * from "./directory.js";
export * from "./safety.js";
