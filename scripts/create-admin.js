require("dotenv").config();
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const { Database } = require("../lib/database");
const { hashPassword } = require("../lib/security");

async function main() {
  const pool = new Database();
  const prompt = readline.createInterface({ input: stdin, output: { write() {} } });
  const ask = async (label) => {
    stdout.write(label);
    const answer = await prompt.question("");
    stdout.write("\n");
    return answer;
  };
  try {
    const username = (await ask("اسم الدخول (حروف إنجليزية/أرقام و _ . -): ")).trim().toLowerCase();
    const password = await ask("كلمة المرور (4 أرقام على الأقل): ");
    if (!/^[a-z0-9_.-]{3,40}$/.test(username)) throw new Error("اسم الدخول يجب أن يكون 3-40 حرفًا إنجليزيًا أو رقمًا أو _ . -");
    if (!/^\d{4,200}$/.test(password)) throw new Error("كلمة المرور يجب أن تتكون من 4 أرقام على الأقل.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'");
      if (existing.rows[0].count) throw new Error("يوجد حساب مدير بالفعل. أضف الحسابات الجديدة من صفحة المستخدمين داخل البرنامج.");
      await client.query(
        "INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')",
        [username, await hashPassword(password)]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.log("تم إنشاء حساب المدير. شغّل npm start ثم سجّل الدخول.");
  } finally {
    prompt.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error("تعذر إنشاء حساب المدير:", error.message);
  process.exitCode = 1;
});
