require("dotenv").config();
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { Database } = require("../lib/database");

async function main() {
  const pool = new Database();
  try {
    const schema = await readFile(path.join(__dirname, "..", "schema.sql"), "utf8");
    await pool.query(schema);
    console.log("تم إنشاء/تحديث جداول قاعدة البيانات بنجاح.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("فشل إعداد قاعدة البيانات المحلية:", error.message);
  process.exitCode = 1;
});
