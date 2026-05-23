/**
 * Module Test Coverage Map
 * Lists all src/modules/* and checks whether each has direct tests.
 *
 * Usage: npx tsx scripts/module-test-coverage.ts
 */
import fs from "fs";
import path from "path";

const MODULES_DIR = path.resolve("src/modules");
const TESTS_DIR = path.resolve("src/tests");

const MONEY_ADJACENT = new Set([
  "payments", "stripe", "paystack", "buyer-wallet", "payouts",
  "orders", "subscriptions", "referrals", "promos",
]);

function main() {
  console.log("=== MODULE TEST COVERAGE MAP ===\n");

  const modules = fs.readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  const testFiles = fs.existsSync(TESTS_DIR)
    ? fs.readdirSync(TESTS_DIR).filter(f => f.endsWith(".test.ts"))
    : [];

  const testContent = testFiles.map(f => ({
    name: f,
    content: fs.readFileSync(path.join(TESTS_DIR, f), "utf-8").toLowerCase(),
  }));

  const results: { module: string; status: string; money: boolean }[] = [];

  for (const mod of modules) {
    const money = MONEY_ADJACENT.has(mod);
    // Check for direct test file
    const directTest = testFiles.some(f => f.includes(mod.replace(/-/g, "")));
    // Check for transitive coverage (module name mentioned in any test)
    const transitive = testContent.some(t => t.content.includes(mod.replace(/-/g, "")));

    let status: string;
    if (directTest) status = "DIRECT_TESTED";
    else if (transitive) status = "TRANSITIVE_ONLY";
    else status = "UNTESTED";

    results.push({ module: mod, status, money });
  }

  // Output
  console.log("| Module | Status | Money-Adjacent |");
  console.log("|--------|--------|----------------|");
  for (const r of results) {
    const icon = r.status === "DIRECT_TESTED" ? "✅" : r.status === "TRANSITIVE_ONLY" ? "⚠️" : "❌";
    console.log(`| ${r.module} | ${icon} ${r.status} | ${r.money ? "💰 YES" : "—"} |`);
  }

  const untested = results.filter(r => r.status === "UNTESTED");
  const untestedMoney = results.filter(r => r.status === "UNTESTED" && r.money);

  console.log(`\nTotal modules: ${results.length}`);
  console.log(`Direct tested: ${results.filter(r => r.status === "DIRECT_TESTED").length}`);
  console.log(`Transitive only: ${results.filter(r => r.status === "TRANSITIVE_ONLY").length}`);
  console.log(`Untested: ${untested.length}`);

  if (untestedMoney.length > 0) {
    console.log(`\n⚠️  UNTESTED MONEY-ADJACENT MODULES: ${untestedMoney.map(r => r.module).join(", ")}`);
  }

  console.log(untestedMoney.length === 0 ? "\n✅ All money-adjacent modules have test coverage" : "");
}

main();
