/**
 * Cleanup Scenario Products
 * Deactivates ALL products matching QA/test prefixes via Prisma.
 * Safe: only touches products with known test prefixes, never real products.
 *
 * Usage: npx tsx scripts/cleanup-scenario-products.ts
 *        npm run cleanup:scenario
 */
import { PrismaClient } from "@prisma/client";
import "dotenv/config";

const prisma = new PrismaClient();

const QA_PREFIXES = [
  "SCENARIO_QA_",
  "R3PNG",
  "R3P",
  "QA ",
  "QA_",
  "TEST",
  "Test ",
  "Demo",
  "NG Prod",
  "UK Prod",
  "Sample Marketplace",
];

// Real products that must NEVER be touched
const PROTECTED_TITLES = [
  "Olio Extra Vergine di Oliva",
  "Sugo al Basilico",
  "Spaghetti di Gragnano",
];

async function main() {
  console.log("=== SCENARIO PRODUCT CLEANUP ===\n");

  // Find all active products
  const allProducts = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, title: true },
  });

  console.log(`Total active products: ${allProducts.length}`);

  // Filter to QA products only
  const qaProducts = allProducts.filter(p => {
    // Never touch protected products
    if (PROTECTED_TITLES.includes(p.title)) return false;
    // Match any QA prefix (case-insensitive for some)
    return QA_PREFIXES.some(prefix => p.title.startsWith(prefix)) ||
      /^(test|qa|demo|r\d+)/i.test(p.title);
  });

  console.log(`QA/test products to deactivate: ${qaProducts.length}\n`);

  if (qaProducts.length === 0) {
    console.log("✅ No QA products found. Catalog is clean.");
    await prisma.$disconnect();
    return;
  }

  // Deactivate in batch
  const result = await prisma.product.updateMany({
    where: { id: { in: qaProducts.map(p => p.id) } },
    data: { isActive: false },
  });

  console.log(`Deactivated: ${result.count}`);

  // Verify
  const remaining = await prisma.product.findMany({
    where: { isActive: true },
    select: { id: true, title: true },
  });

  const stillQA = remaining.filter(p =>
    !PROTECTED_TITLES.includes(p.title) &&
    (QA_PREFIXES.some(prefix => p.title.startsWith(prefix)) || /^(test|qa|demo|r\d+)/i.test(p.title))
  );

  if (stillQA.length > 0) {
    console.log(`\n⚠️  Still active after cleanup:`);
    stillQA.forEach(p => console.log(`  - ${p.id}: ${p.title}`));
    console.log(`\n❌ FAIL — ${stillQA.length} QA products remain`);
  } else {
    console.log(`\nActive products remaining: ${remaining.length}`);
    remaining.forEach(p => console.log(`  ✓ ${p.title}`));
    console.log(`\n✅ PASS — Catalog clean. Only real products remain.`);
  }

  await prisma.$disconnect();
  process.exit(stillQA.length > 0 ? 1 : 0);
}

main().catch(e => { console.error("FATAL:", e); process.exit(1); });
