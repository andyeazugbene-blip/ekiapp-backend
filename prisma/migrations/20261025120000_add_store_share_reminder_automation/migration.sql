-- Notification Orchestration Spec v2, R10: "Store live, never shared."
-- Migrates the pre-spec "handoff V-06 store.link.not.shared" reminder
-- (previously a raw, non-toggleable, non-admin-visible send in
-- vendor-milestone-notifications.service.ts) onto the AutomationRule/
-- AutomationRun framework, same as R01/R03/R05/R06/R11.

ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'STORE_SHARE_REMINDER';
