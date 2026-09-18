import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const version = process.env.DSH_JRE_VERSION || "17";
const target = process.env.DSH_JRE_TARGET || `${process.platform}-${process.arch}`;
const outputRoot = join(process.cwd(), "resources", "agent", "runtime");

const platformMap = {
  "darwin-x64": { image: "mac", arch: "x64", extension: "tar.gz" },
  "darwin-arm64": { image: "mac", arch: "aarch64", extension: "tar.gz" },
  "win32-x64": { image: "windows", arch: "x64", extension: "zip" },
  "win32-arm64": { image: "windows", arch: "aarch64", extension: "zip" },
  "linux-x64": { image: "linux", arch: "x64", extension: "tar.gz" },
  "linux-arm64": { image: "linux", arch: "aarch64", extension: "tar.gz" },
};

const platform = platformMap[target];
if (!platform) {
  throw new Error(`不支持的 JRE 目标平台：${target}。可用值：${Object.keys(platformMap).join(", ")}`);
}

const url = `https://api.adoptium.net/v3/binary/latest/${version}/ga/${platform.image}/${platform.arch}/jre/hotspot/normal/eclipse?project=jdk`;
const temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-jre-"));
const archive = join(temporaryRoot, `java17-runtime.${platform.extension}`);
const unpacked = join(temporaryRoot, "unpacked");

async function download(file, destination) {
  const response = await fetch(file, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`下载 JRE 失败：HTTP ${response.status} ${file}`);
  }
  await pipeline(response.body, createWriteStream(destination));
}

async function extract() {
  await mkdir(unpacked, { recursive: true });
  if (platform.extension === "zip") {
    await execFileAsync("tar", ["-xf", archive, "-C", unpacked]);
  } else {
    await execFileAsync("tar", ["-xzf", archive, "-C", unpacked]);
  }
}

async function findJava(directory) {
  const javaName = platform.image === "windows" ? "java.exe" : "java";
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === javaName) {
        return dirname(dirname(candidate));
      }
    }
  }
  throw new Error(`JRE 压缩包中未找到 ${javaName}`);
}

try {
  console.log(`下载 ${target} 的 Java 17 Runtime：${url}`);
  await download(url, archive);
  await extract();
  const javaHome = await findJava(unpacked);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(dirname(outputRoot), { recursive: true });
  await cp(javaHome, outputRoot, { recursive: true });
  await rm(javaHome, { recursive: true, force: true });
  if (platform.image !== "windows") {
    await chmod(join(outputRoot, "bin", "java"), 0o755);
  }
  console.log(`Java 17 Runtime 已准备到 ${outputRoot}`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
