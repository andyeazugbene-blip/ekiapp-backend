# Backup & Restore Proof

## Status: EXTERNAL SETUP REQUIRED

## Database: Neon PostgreSQL

### Point-in-Time Recovery (PITR)

Neon provides built-in PITR on paid plans:

| Feature | Free Tier | Pro Plan |
|---------|-----------|----------|
| Branching | ✅ | ✅ |
| PITR window | 24 hours | 7-30 days (configurable) |
| Automated backups | ✅ (daily) | ✅ (continuous WAL) |

### Verification Steps

1. Log in to [Neon Console](https://console.neon.tech)
2. Select project → Settings → Storage
3. Confirm:
   - Plan: Pro (or higher)
   - PITR retention: ≥7 days
   - WAL archiving: enabled

### Restore Drill Template

| Field | Value |
|-------|-------|
| Restore target | Neon branch (non-destructive) |
| Source | Production database |
| Target date/time | [FILL: e.g., 2026-05-22T14:00:00Z] |
| RTO (Recovery Time Objective) | <15 minutes (Neon branch creation) |
| RPO (Recovery Point Objective) | <1 minute (continuous WAL) |
| Result | [FILL: PASS/FAIL] |
| Verified by | [FILL: Name] |
| Date performed | [FILL: Date] |

### How to Perform a Restore Drill

```bash
# 1. Create a branch from a point in time (Neon CLI)
neonctl branches create \
  --project-id YOUR_PROJECT_ID \
  --name restore-drill-$(date +%Y%m%d) \
  --parent main \
  --point-in-time "2026-05-22T14:00:00Z"

# 2. Get the connection string for the new branch
neonctl connection-string --branch restore-drill-$(date +%Y%m%d)

# 3. Verify data integrity
psql $RESTORED_DB_URL -c "SELECT COUNT(*) FROM \"User\";"
psql $RESTORED_DB_URL -c "SELECT COUNT(*) FROM \"Order\";"
psql $RESTORED_DB_URL -c "SELECT MAX(\"createdAt\") FROM \"Order\";"

# 4. Clean up drill branch
neonctl branches delete restore-drill-$(date +%Y%m%d) --project-id YOUR_PROJECT_ID
```

## File Storage: Cloudflare R2

### Bucket Versioning

| Setting | Recommended | Status |
|---------|-------------|--------|
| Object versioning | Enabled | ❌ VERIFY |
| Lifecycle rules | Keep 30 days of versions | ❌ VERIFY |

### Setup Steps

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. R2 → Select bucket → Settings
3. Enable **Object Versioning**
4. Add lifecycle rule:
   - Delete non-current versions after 30 days
   - Delete incomplete multipart uploads after 7 days

### R2 Backup Strategy

For critical data (product images, verification documents):
- Object versioning protects against accidental overwrites/deletes
- Cross-region replication (if available on plan) for disaster recovery
- Consider periodic export to separate bucket for cold storage

## Verification Checklist

- [ ] Neon Pro plan active with PITR ≥7 days
- [ ] Restore drill performed and documented (fill template above)
- [ ] R2 bucket versioning enabled
- [ ] R2 lifecycle rules configured
- [ ] Restore procedure documented in team runbook
- [ ] RTO/RPO targets defined and achievable

## Disaster Recovery Summary

| Component | Backup Method | RTO | RPO |
|-----------|--------------|-----|-----|
| Database (Neon) | Continuous WAL + PITR | <15 min | <1 min |
| File storage (R2) | Object versioning | <5 min | 0 (versioned) |
| Application code | Git (GitHub) | <5 min (redeploy) | 0 |
| Environment config | Vercel env vars | <5 min | Manual |
| Secrets | Vercel encrypted env | <5 min | Manual |
