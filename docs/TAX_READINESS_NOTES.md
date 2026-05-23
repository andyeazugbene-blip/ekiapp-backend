# Tax Readiness Notes

> ⚠️ This is NOT legal or tax advice. Consult a qualified tax advisor before launch.

## Italian VAT (22%)
- Standard rate: 22%
- Reduced rates: 10% (food), 4% (essentials)
- Marketplace may be "deemed supplier" under EU rules
- If deemed supplier: platform collects and remits VAT

## EU Marketplace / Deemed Supplier
- EU VAT reform (July 2021): platforms facilitating sales may be deemed suppliers
- Applies when: platform sets terms, handles payment, or is involved in delivery
- If applicable: Eki must register for VAT in each EU member state with sales
- Alternative: OSS (One-Stop Shop) for cross-border B2C within EU

## Africa Local VAT

### Nigeria
- VAT rate: 7.5%
- Applies to goods and services
- Marketplace may need to register with FIRS

### Ghana
- VAT rate: 15% (standard) + various levies
- Digital services tax may apply

### Kenya
- VAT rate: 16%
- Digital marketplace tax: 1.5% of gross transaction value

### South Africa
- VAT rate: 15%
- Electronic services regulations apply to marketplaces

## Recommended Data Fields (Future)
```prisma
// Add to Order model when tax is implemented
vatRate       Float?    // e.g. 0.22 for 22%
vatAmount     Int?      // in cents
taxJurisdiction String? // e.g. "IT", "NG"
invoiceNumber String?   // sequential invoice number
invoiceUrl    String?   // link to generated invoice PDF
```

## Invoice Retention
- EU: 10 years minimum
- Nigeria: 6 years
- Generate and store invoices for every completed order
