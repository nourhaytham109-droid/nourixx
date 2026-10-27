const { spawn } = require("node:child_process");
const { access, cp, mkdir, readdir, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const releaseDirectory = path.join(root, "release");
const applicationDirectory = path.join(releaseDirectory, "win-unpacked");
const packageDirectory = path.join(releaseDirectory, "Nourix-Windows-Setup");
const stagedApplicationDirectory = path.join(packageDirectory, "Nourix POS");
const outputFile = path.join(releaseDirectory, "Nourix-Setup-Windows-1.0.0.zip");

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findArchiver() {
  const candidates = [
    process.env.NOURIX_7ZIP_PATH,
    ...String(process.env.PATH || "")
      .split(path.delimiter)
      .flatMap((directory) => ["7zz", "7z", "zip"].map((name) => path.join(directory, name))),
  ].filter(Boolean);

  const cacheDirectory = path.join(os.homedir(), ".cache", "electron-builder", "7zip@1.0.0");
  if (await exists(cacheDirectory)) {
    for (const entry of await readdir(cacheDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(path.join(cacheDirectory, entry.name, "bin", "7zz"));
    }
  }

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }

  throw new Error(
    "A ZIP archiver is required. Install 7-Zip, or set NOURIX_7ZIP_PATH to its executable."
  );
}

async function archiveWith(archiver) {
  const executableName = path.basename(archiver).toLowerCase();
  const args = executableName === "zip"
    ? ["-r", "-6", outputFile, "."]
    : ["a", "-tzip", "-mx=5", outputFile, "."];
  const child = spawn(archiver, args, {
    cwd: packageDirectory,
    stdio: "inherit",
    windowsHide: true,
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error(`ZIP archiver exited with code ${exitCode}.`);
  }
}

async function main() {
  if (!(await exists(path.join(applicationDirectory, "Nourix POS.exe")))) {
    throw new Error(
      "The Windows application build is missing. Run `npm run build:win:dir` first."
    );
  }

  await rm(packageDirectory, { recursive: true, force: true });
  await mkdir(stagedApplicationDirectory, { recursive: true });
  await cp(applicationDirectory, stagedApplicationDirectory, { recursive: true });
  await cp(
    path.join(root, "packaging", "windows", "Setup.bat"),
    path.join(packageDirectory, "Setup.bat")
  );
  await cp(
    path.join(root, "packaging", "windows", "Install-Nourix.ps1"),
    path.join(packageDirectory, "Install-Nourix.ps1")
  );
  await cp(
    path.join(root, "packaging", "windows", "Uninstall-Nourix.ps1"),
    path.join(packageDirectory, "Uninstall-Nourix.ps1")
  );

  const guidePath = path.join(root, "docs", "nourix-pos-guide-ar.pdf");
  if (await exists(guidePath)) {
    await cp(guidePath, path.join(packageDirectory, "دليل Nourix POS.pdf"));
  }

  const archiver = await findArchiver();
  await rm(outputFile, { force: true });
  await archiveWith(archiver);
  console.log(`Created Windows install kit: ${outputFile}`);
  console.log("Extract the ZIP, then double-click Setup.bat to install Nourix POS.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
