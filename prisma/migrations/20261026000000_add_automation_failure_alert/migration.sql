-- Notification Orchestration Spec v2, R38: "An Eki automation needs
-- attention" — vendor-facing alert when one of their own automations
-- fails to send, distinct from the existing admin-only failure feed.

ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'AUTOMATION_FAILURE_ALERT';
