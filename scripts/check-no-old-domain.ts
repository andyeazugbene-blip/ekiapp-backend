/**
 * Fail if any production-shipped file still references the old domain.
 *
 * Scans:
 *   - src/        (backend code)
 *   - frontend-snippets/  (Expo snippets shipped to the FE repo)
 *   - docs/       (excluding docs/archive)
 *   - root-level: README.md, .env.example, package.json
 *
 * Allowed places that may still mention "neon.online" or "neon://":
 *   - docs/archive/**            (historical artifacts)
 *   - docs/DOMAIN_MIGRATION_*    (this migration's report by definition)
 *   - CHANGELOG entries          (if a CHANGELOG ever exists)
 *   - this script itself + check-domain-links.ts
 *
 * Also:
 *   - References to "neon.tech" in the README (Neon database hosting) are
 *     allowed because that's a different product (Neon Postgres). The
 *     forbidden token is "neon.online" specifically.
 *
 * Exit code: 1 if any forbidden references are found, 0 otherwise.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const FORBIDDEN = [
  /neon\.online/i,           // primary marker
  /\bneon:\/\/[a-z]/i,        // custom-scheme deep link from the old app
];

const SCAN_DIRS = ["src", "frontend-snippets", "docs"];
const SCAN_FILES = ["README.md", ".env.example", "package.json"];

const ALLOWED_PATH_FRAGMENTS = [
  path.join("docs", "archive") + path.sep,
  // Migration report is allowed to mention what it's replacing.
  "DOMAIN_MIGRATION_",
  // The check scripts themselves contain the forbidden tokens as data.
  path.join("scripts", "check-no-old-domain.ts"),
  path.join("scripts", "check-domain-links.ts"),
];

const SKIP_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".lock"]);

interface Finding {
  file: string;
  line: number;
  match: string;
  preview: string;
}

function isAllowed(relativePath: string): boolean {
  return ALLOWED_PATH_FRAGMENTS.some((frag) => relativePath.includes(frag));
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip node_modules, dist, .git anywhere
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      yield* walk(full);
    } else if (entry.isFile()) {
      if (SKIP_FILE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      yield full;
    }
  }
}

function scanFile(file: string, findings: Finding[]): void {
  const rel = path.relative(ROOT, file);
  if (isAllowed(rel)) return;

  let content: string;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return; // unreadable, skip
  }

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of FORBIDDEN) {
      const m = re.exec(line);
      if (m) {
        findings.push({
          file: rel,
          line: i + 1,
          match: m[0],
          preview: line.trim().slice(0, 200),
        });
      }
    }
  }
}

function main(): void {
  const findings: Finding[] = [];

  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(ROOT, dir))) {
      scanFile(file, findings);
    }
  }
  for (const f of SCAN_FILES) {
    const full = path.join(ROOT, f);
    if (fs.existsSync(full)) scanFile(full, findings);
  }

  if (findings.length === 0) {
    console.log("✅ No production references to the old domain found.");
    return;
  }

  console.log(`❌ Found ${findings.length} forbidden reference(s) to the old domain:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.match}]`);
    console.log(`    ${f.preview}`);
  }
  console.log(
    "\nIf any of these are intentional historical references, move them under docs/archive/ " +
    "or add their path to ALLOWED_PATH_FRAGMENTS in scripts/check-no-old-domain.ts.",
  );
  process.exit(1);
}

main();
