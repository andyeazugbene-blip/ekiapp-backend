/**
 * AI Scaffolding Phrase Guard
 * Scans src/ for risky placeholder phrases that indicate incomplete implementation.
 * Fails with non-zero exit code if found (except in test files).
 *
 * Usage: npx tsx scripts/check-ai-scaffolding.ts
 */
import fs from "fs";
import path from "path";

const RISKY_PHRASES = [
  "For now",
  "In production this would",
  "TODO: replace",
  "placeholder",
  "mock for development",
  "temporary",
  "fake",
  "stub",
];

const SCAN_DIR = path.resolve("src");
const EXCLUDE_PATTERNS = [/\.test\.ts$/, /tests\//, /\.d\.ts$/];
const ALLOWLIST_FILES = [
  "src/lib/sentry.ts",
  "src/modules/public-stores/public-stores.page.ts", // CSS class names use "placeholder"
];

function scanFile(filePath: string): { file: string; line: number; phrase: string; text: string }[] {
  const relative = path.relative(process.cwd(), filePath).replace(/\\/g, "/");

  // Skip test files and allowlisted files
  if (EXCLUDE_PATTERNS.some(p => p.test(relative))) return [];
  if (ALLOWLIST_FILES.includes(relative)) return [];

  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");
  const findings: { file: string; line: number; phrase: string; text: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments that are legitimate documentation
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;

    for (const phrase of RISKY_PHRASES) {
      if (
        phrase === "placeholder" &&
        (line.includes("placeholder=") || line.includes("example placeholder"))
      ) {
        continue;
      }
      if (line.toLowerCase().includes(phrase.toLowerCase())) {
        findings.push({ file: relative, line: i + 1, phrase, text: line.trim().slice(0, 100) });
      }
    }
  }

  return findings;
}

function walkDir(dir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      files.push(...walkDir(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function main() {
  console.log("=== AI SCAFFOLDING PHRASE CHECK ===\n");
  const files = walkDir(SCAN_DIR);
  const allFindings: ReturnType<typeof scanFile> = [];

  for (const file of files) {
    allFindings.push(...scanFile(file));
  }

  if (allFindings.length === 0) {
    console.log(`Scanned ${files.length} files. No risky phrases found.`);
    console.log("\n✅ PASS");
    process.exit(0);
  }

  console.log(`Found ${allFindings.length} risky phrase(s):\n`);
  for (const f of allFindings) {
    console.log(`  ${f.file}:${f.line} — "${f.phrase}"`);
    console.log(`    ${f.text}\n`);
  }
  console.log(`\n❌ FAIL — ${allFindings.length} scaffolding phrases detected`);
  process.exit(1);
}

main();
