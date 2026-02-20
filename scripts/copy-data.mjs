import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const rootDir = process.cwd();
const sourcePath = resolve(rootDir, "data.xls");
const publicDir = resolve(rootDir, "public");
const targetPath = resolve(publicDir, "data.xls");

try {
  await mkdir(publicDir, { recursive: true });
  await copyFile(sourcePath, targetPath);
  console.log("[prepare:data] copied data.xls to public/data.xls");
} catch (error) {
  console.error("[prepare:data] failed to copy data.xls");
  console.error(error);
  process.exit(1);
}
