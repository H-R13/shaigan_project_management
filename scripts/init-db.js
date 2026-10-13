// Creates all tables (like `python manage.py migrate`) and the four roles.
//   npm run db:init
//
// Safe to run more than once: existing tables and roles are left alone.

require("dotenv").config({ quiet: true });
const { sequelize, Group } = require("../src/models");
const { seedDefaultRules, pruneRoleRules } = require("../src/lib/permissionSetup");
const { ROLES } = require("../src/lib/choices");

async function ensureDatabaseExists() {
  // MySQL/MariaDB: create the database itself if it is missing
  const dialect = sequelize.getDialect();
  if (dialect !== "mysql" && dialect !== "mariadb") return;
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || "127.0.0.1",
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
  });
  const name = process.env.DB_NAME || "project_management";
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${name.replace(/`/g, "")}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.end();
}

async function seedRoles() {
  for (const name of Object.values(ROLES)) {
    const [, created] = await Group.findOrCreate({ where: { name } });
    console.log(created ? `  + role "${name}"` : `  = role "${name}" already exists, left unchanged`);
  }
}

async function main() {
  await ensureDatabaseExists();
  await sequelize.authenticate();
  console.log(`Connected (${sequelize.getDialect()}). Creating tables...`);

  await sequelize.sync();

  // Sessions table used by connect-session-sequelize
  const session = require("express-session");
  const SequelizeStore = require("connect-session-sequelize")(session.Store);
  await new SequelizeStore({ db: sequelize, tableName: "sessions" }).sync();

  console.log("Tables ready. Seeding roles...");
  await seedRoles();

  console.log("Setting up what each role can see...");
  await seedDefaultRules();
  await pruneRoleRules();

  console.log("\nDone. Next: `npm run createsuperuser` (or `npm run import:django` to copy your old data).");
  await sequelize.close();
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error("Database setup failed:", err.message);
    await sequelize.close().catch(() => {});
    process.exit(1);
  });
}

module.exports = { main };
