// npm installs only the optional native packages for the machine that runs it.
// This script also installs the ones for each platform in PLATFORMS, so that one
// node_modules works on the macOS host and in the Linux arm64 sandbox.
// It reads the versions, URLs and integrity hashes from package-lock.json.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PLATFORMS = [
  { os: "darwin", cpu: "arm64" },
  { os: "linux", cpu: "arm64", libc: "glibc" },
];

if (process.env.CI) {
  process.exit(0);
}

const root = join(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));

// The lockfile has no libc field, so the package name tells musl from glibc.
function libcOf(path) {
  return /musl/.test(path) ? "musl" : "glibc";
}

function matches(path, entry) {
  return PLATFORMS.some(
    (p) =>
      entry.os?.includes(p.os) &&
      entry.cpu?.includes(p.cpu) &&
      (p.os !== "linux" || libcOf(path) === p.libc),
  );
}

const missing = Object.entries(lock.packages).filter(
  ([path, entry]) => entry.optional && entry.os && entry.cpu && entry.resolved && matches(path, entry) && !existsSync(join(root, path)),
);

const tmp = mkdtempSync(join(tmpdir(), "platform-bindings-"));
try {
  await Promise.all(
    missing.map(async ([path, entry], i) => {
      const res = await fetch(entry.resolved);
      if (!res.ok) {
        throw new Error(`${entry.resolved}: HTTP ${res.status}`);
      }
      const data = Buffer.from(await res.arrayBuffer());
      const [algo, expected] = entry.integrity.split("-");
      const actual = createHash(algo).update(data).digest("base64");
      if (actual !== expected) {
        throw new Error(`${path}: integrity check failed`);
      }
      const file = join(tmp, `${i}.tgz`);
      writeFileSync(file, data);
      const dest = join(root, path);
      mkdirSync(dest, { recursive: true });
      execFileSync("tar", ["-xzf", file, "-C", dest, "--strip-components=1"]);
      console.log(`installed ${path.replace(/^.*node_modules\//, "")}@${entry.version}`);
    }),
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
