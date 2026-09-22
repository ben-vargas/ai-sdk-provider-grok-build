import { promises as fs } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function filesUnder(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", "coverage", ".git"].includes(entry.name)) {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else files.push(path);
  }
  return files;
}

const allFiles = await filesUnder(root);
const markdownFiles = allFiles.filter((path) => extname(path) === ".md");
const failures = [];
const linkedExamples = new Set();

for (const markdownPath of markdownFiles) {
  const markdown = await fs.readFile(markdownPath, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1]?.split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:|#)/.test(target)) continue;
    const decoded = decodeURIComponent(target.replace(/^<|>$/g, ""));
    const resolved = resolve(dirname(markdownPath), decoded);
    try {
      await fs.access(resolved);
    } catch {
      failures.push(`${markdownPath}: missing link target ${target}`);
    }
  }
}

const examplesReadme = await fs.readFile(
  join(root, "examples", "README.md"),
  "utf8",
);
for (const match of examplesReadme.matchAll(/`([\w-]+\.ts)`/g)) {
  linkedExamples.add(match[1]);
}

const examples = allFiles
  .filter(
    (path) =>
      dirname(path) === join(root, "examples") && extname(path) === ".ts",
  )
  .map((path) => basename(path));
for (const example of examples) {
  if (!linkedExamples.has(example)) {
    failures.push(`examples/README.md does not list ${example}`);
  }
}

const packageJson = JSON.parse(
  await fs.readFile(join(root, "package.json"), "utf8"),
);
const indexSource = await fs.readFile(join(root, "src", "index.ts"), "utf8");
if (!indexSource.includes(`VERSION = "${packageJson.version}"`)) {
  failures.push("src/index.ts VERSION does not match package.json");
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `Validated ${markdownFiles.length} Markdown files and ${examples.length} examples.`,
  );
}
