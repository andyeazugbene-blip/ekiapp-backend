# Support Workflow Live Proof

## Status: EXTERNAL SETUP REQUIRED

## Support Infrastructure

| Component | Status | Details |
|-----------|--------|---------|
| Support inbox | ❌ NOT CONFIGURED | Needs: support@your-domain.com |
| Auto-reply template | ❌ NOT CONFIGURED | See template below |
| Ticket numbering | ❌ NOT CONFIGURED | Recommend: Freshdesk, Zendesk, or Linear |
| Refund SLA | ✅ DOCUMENTED | See `docs/REFUND_SLA.md` |
| Escalation path | ⚠️ DRAFT | See below |

## Recommended Setup

### Option A: Freshdesk (Recommended for Marketplaces)
- Free tier available (up to 10 agents)
- Built-in ticket numbering
- Auto-reply and SLA management
- Marketplace-specific features (multi-brand support)

### Option B: Linear + Email Forwarding
- Forward support@domain → Linear inbox
- Auto-assign based on keywords
- Lightweight, developer-friendly

### Option C: Shared Gmail + Manual Tracking
- Minimum viable for soft launch
- Not recommended for public launch

## Support Email Setup

1. Create `support@your-domain.com` (via domain registrar or Google Workspace)
2. Configure auto-reply (see template below)
3. Forward to ticketing system
4. Set `OPS_ALERT_EMAIL` in Vercel env vars

## Auto-Reply Template

```
Subject: We received your request [#{ticket_number}]

Hi {customer_name},

Thank you for contacting Eki Marketplace support.

We've received your request and assigned it ticket number #{ticket_number}.

Our team will respond within:
- General inquiries: 24 hours
- Payment issues: 4 hours
- Account security: 1 hour

In the meantime, you can check our FAQ at: https://your-domain.com/faq

Best regards,
Eki Marketplace Support Team
```

## Ticket Number Flow

1. Customer emails support@domain
2. Ticketing system assigns sequential ID (e.g., EKI-1234)
3. Auto-reply sent with ticket number
4. Agent triages and responds
5. Resolution → close ticket → satisfaction survey

## Refund SLA (from docs/REFUND_SLA.md)

| Scenario | Response Time | Resolution Time |
|----------|--------------|-----------------|
| Undelivered order | 4 hours | 24 hours |
| Damaged goods | 4 hours | 48 hours |
| Wrong item | 4 hours | 48 hours |
| Buyer remorse (if policy allows) | 24 hours | 72 hours |
| Disputed escrow | 4 hours | 72 hours |

## Escalation Path

| Level | Responder | Trigger |
|-------|-----------|---------|
| L1 | Support agent | All incoming tickets |
| L2 | Senior support / Ops | Unresolved after 24h, payment disputes |
| L3 | Engineering | Technical issues, data inconsistencies |
| L4 | Management | Legal threats, fraud patterns, PR issues |

## Action Items

1. [ ] Register support@your-domain.com
2. [ ] Choose and configure ticketing system (Freshdesk recommended)
3. [ ] Set up auto-reply template
4. [ ] Configure SLA rules in ticketing system
5. [ ] Set `OPS_ALERT_EMAIL=support@your-domain.com` in Vercel
6. [ ] Add support link to app footer and error pages
7. [ ] Create FAQ/Help Center page
