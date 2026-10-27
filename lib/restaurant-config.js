const os = require("node:os");
const path = require("node:path");

function getDataDirectory(env = process.env, platform = process.platform, homeDirectory = os.homedir()) {
  const override = env.NOURIX_DATA_DIR || env.DATA_DIR;
  if (override) return path.resolve(override);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || env.APPDATA || homeDirectory, "Nourix", "data");
  }
  if (platform === "darwin") {
    return path.join(homeDirectory, "Library", "Application Support", "Nourix", "data");
  }
  return path.join(env.XDG_DATA_HOME || path.join(homeDirectory, ".local", "share"), "Nourix", "data");
}

module.exports = { getDataDirectory };
