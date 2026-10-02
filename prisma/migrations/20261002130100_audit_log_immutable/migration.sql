-- Handbook 13 L492 / 14.12: audit records are immutable. Rows may be inserted
-- but never updated or deleted by the application role. Dev/test resets use
-- TRUNCATE, which row-level triggers do not intercept.
CREATE OR REPLACE FUNCTION "audit_log_block_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is append-only (% blocked)', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_log_immutable" ON "AuditLog";
CREATE TRIGGER "audit_log_immutable"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION "audit_log_block_mutation"();
