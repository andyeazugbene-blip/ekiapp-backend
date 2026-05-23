# Monthly Disaster Recovery Drill

## Target RTO and RPO
- **RTO (Recovery Time Objective):** 30 minutes
- **RPO (Recovery Point Objective):** 1 hour (Neon PITR granularity)

## Drill 1: Neon Database Restore
1. Create a Neon branch from 24 hours ago
2. Connect to the branch, verify data integrity
3. Run `npm run reconcile:wallets` against the branch
4. Confirm orders, payments, wallets are consistent
5. Delete the test branch
- [ ] Completed | Date: ____ | Duration: ____

## Drill 2: Vercel Rollback
1. Go to Vercel → Deployments
2. Find the deployment from 2 days ago
3. Click "..." → Promote to Production
4. Verify `/api/health/detailed` returns 200
5. Roll forward to current deployment
- [ ] Completed | Date: ____ | Duration: ____

## Drill 3: Stripe Webhook Secret Rotation
1. In Stripe Dashboard → Webhooks → Roll secret
2. Copy new secret
3. Update `STRIPE_WEBHOOK_SECRET` in Vercel
4. Trigger a test event from Stripe CLI or dashboard
5. Verify webhook processes successfully
- [ ] Completed | Date: ____ | Duration: ____

## Drill 4: Paystack Credential Rotation
1. Regenerate API key in Paystack Dashboard
2. Update `PAYSTACK_SECRET_KEY` in Vercel
3. Verify `/api/health/detailed` shows Paystack OK
- [ ] Completed | Date: ____ | Duration: ____

## Drill 5: R2 Object Restore
1. Enable versioning on R2 bucket (if not already)
2. Delete a test object
3. Restore from previous version
4. Verify object accessible at public URL
- [ ] Completed | Date: ____ | Duration: ____

## Sign-off
- Drills completed by: ____
- Date: ____
- Issues found: ____
- Next drill scheduled: ____
