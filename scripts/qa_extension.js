const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const SOURCE_FILES = [
  "src/background.js",
  "src/content.js",
  "src/popup.js",
  "src/options.js",
  "src/shared.js"
];
const HTML_FILES = [
  "popup.html",
  "options.html"
];
const EXPECTED_ICON_SIZES = [16, 32, 48, 128, 256, 512];
const REQUIRED_API_PERMISSIONS = [
  { pattern: /\bchrome\.alarms\b/, permission: "alarms" },
  { pattern: /\bchrome\.scripting\b/, permission: "scripting" },
  { pattern: /\bchrome\.storage\b/, permission: "storage" },
  { pattern: /\bchrome\.tabs\b/, permission: "tabs" },
  { pattern: /\bchrome\.windows\b/, permission: "windows" }
];

const failures = [];

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    failures.push(message);
  }
}

function assertFileExists(relativePath, source) {
  assert(
    fs.existsSync(path.join(ROOT, relativePath)),
    `${source} references missing file: ${relativePath}`
  );
}

function walkFiles(directory) {
  const files = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git") {
      continue;
    }

    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }

  return files;
}

function loadManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (error) {
    failures.push(`manifest.json is not valid JSON: ${error.message}`);
    return null;
  }
}

function validateManifestFiles(manifest) {
  assertFileExists(manifest.background && manifest.background.service_worker, "manifest.background.service_worker");
  assertFileExists(manifest.action && manifest.action.default_popup, "manifest.action.default_popup");
  assertFileExists(manifest.options_page, "manifest.options_page");

  for (const [size, iconPath] of Object.entries(manifest.icons || {})) {
    assertFileExists(iconPath, `manifest.icons.${size}`);
  }

  for (const [size, iconPath] of Object.entries((manifest.action && manifest.action.default_icon) || {})) {
    assertFileExists(iconPath, `manifest.action.default_icon.${size}`);
  }
}

function getPngSize(relativePath) {
  const buffer = fs.readFileSync(path.join(ROOT, relativePath));
  const signature = buffer.subarray(0, 8).toString("hex");

  if (signature !== "89504e470d0a1a0a") {
    return null;
  }

  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20)
  };
}

function validateIconSizes() {
  for (const size of EXPECTED_ICON_SIZES) {
    const iconPath = `icons/icon_${size}.png`;
    const dimensions = fs.existsSync(path.join(ROOT, iconPath)) ? getPngSize(iconPath) : null;

    assert(
      dimensions && dimensions.width === size && dimensions.height === size,
      `${iconPath} must be a ${size}x${size} PNG`
    );
  }
}

function validateNoPemFiles() {
  const pemFiles = walkFiles(ROOT)
    .filter((filePath) => path.extname(filePath).toLowerCase() === ".pem")
    .map((filePath) => path.relative(ROOT, filePath));

  assert(
    pemFiles.length === 0,
    `Chrome rejects unpacked extensions containing private key files: ${pemFiles.join(", ")}`
  );
}

function validateApiPermissions(manifest) {
  const permissions = new Set(manifest.permissions || []);
  const source = SOURCE_FILES.map(readText).join("\n");

  for (const rule of REQUIRED_API_PERMISSIONS) {
    if (rule.pattern.test(source)) {
      assert(
        permissions.has(rule.permission),
        `manifest.json is missing "${rule.permission}" permission used by chrome.${rule.permission}`
      );
    }
  }
}

function validateJavaScriptSyntax() {
  for (const relativePath of SOURCE_FILES) {
    const result = spawnSync(process.execPath, ["--check", relativePath], {
      cwd: ROOT,
      encoding: "utf8"
    });

    assert(
      result.status === 0,
      `${relativePath} failed node --check:\n${result.stderr || result.stdout}`
    );
  }
}

function getElementIds(html) {
  const ids = new Set();
  const idPattern = /\bid=["']([^"']+)["']/g;
  let match;

  while ((match = idPattern.exec(html))) {
    ids.add(match[1]);
  }

  return ids;
}

function validateDomSelectors(htmlPath, jsPath) {
  const ids = getElementIds(readText(htmlPath));
  const script = readText(jsPath);
  const selectorPattern = /querySelector(?:All)?\(["']#([A-Za-z0-9_-]+)["']\)/g;
  let match;

  while ((match = selectorPattern.exec(script))) {
    assert(
      ids.has(match[1]),
      `${jsPath} queries #${match[1]}, but ${htmlPath} does not define it`
    );
  }
}

function validateHtmlAssets() {
  for (const htmlPath of HTML_FILES) {
    const html = readText(htmlPath);
    const assetPattern = /\b(?:src|href)=["']([^"']+)["']/g;
    let match;

    while ((match = assetPattern.exec(html))) {
      const assetPath = match[1];

      if (/^(?:https?:|data:|#)/.test(assetPath)) {
        continue;
      }

      assertFileExists(assetPath, htmlPath);
    }
  }
}

function main() {
  const manifest = loadManifest();

  if (manifest) {
    validateManifestFiles(manifest);
    validateApiPermissions(manifest);
  }

  validateIconSizes();
  validateNoPemFiles();
  validateJavaScriptSyntax();
  validateDomSelectors("popup.html", "src/popup.js");
  validateDomSelectors("options.html", "src/options.js");
  validateHtmlAssets();

  if (failures.length) {
    console.error(`Extension QA failed with ${failures.length} issue(s):`);

    for (const failure of failures) {
      console.error(`- ${failure}`);
    }

    process.exit(1);
  }

  console.log("Extension QA passed.");
}

main();
