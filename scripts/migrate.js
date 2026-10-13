// Brings an existing database up to date without touching your data:
// adds new columns and tables, and removes the ones the app no longer uses.
//   node scripts/migrate.js
//
// Safe to run more than once.

require("dotenv").config({ quiet: true });
const { DataTypes } = require("sequelize");
const { sequelize, SubtaskMember, RolePermission } = require("../src/models");
const { seedDefaultRules, pruneRoleRules } = require("../src/lib/permissionSetup");

// No longer used: removed at the end (after their data has been carried over)
const OLD_USER_COLUMNS = [
  "is_staff", "can_add", "can_change", "can_delete",
  "task_add", "task_edit", "task_status", "task_comment", "task_delete",
  "subtask_add", "subtask_edit", "subtask_status", "subtask_comment", "subtask_delete",
];
const OLD_TABLES = ["field_rules", "user_restrictions", "perm_actions", "perm_modules", "group_permissions", "user_permissions"];

// [table, column, definition]
const COLUMNS = [
  ["tasks", "follow_up_date", { type: DataTypes.DATEONLY, allowNull: true }],
  ["subtasks", "follow_up_date", { type: DataTypes.DATEONLY, allowNull: true }],
  ["comments", "subtask_id", { type: DataTypes.INTEGER, allowNull: true }],
];

async function main() {
  await sequelize.authenticate();
  const qi = sequelize.getQueryInterface();
  console.log(`Connected (${sequelize.getDialect()}).`);

  for (const [table, column, definition] of COLUMNS) {
    const existing = await qi.describeTable(table);
    if (existing[column]) {
      console.log(`  = ${table}.${column} already exists`);
    } else {
      await qi.addColumn(table, column, definition);
      console.log(`  + added ${table}.${column}`);
    }
  }

  // New tables (created only if missing)
  const tables = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName).toLowerCase());
  for (const Model of [SubtaskMember, RolePermission]) {
    const name = Model.getTableName().toString().toLowerCase();
    if (tables.includes(name)) {
      console.log(`  = table ${name} already exists`);
    } else {
      await Model.sync();
      console.log(`  + created table ${name}`);
    }
  }

  // Starting rules for the four roles (first run only)
  await seedDefaultRules();

  // Per-person access (Users & access): the Admin tick on users, and one
  // row per right in user_rights. When user_rights is first created, each
  // person gets the rights that match what they could do before.
  const { User, UserGroup, UserRight } = require("../src/models");
  const { ACCESS_DOCS, engineActions } = require("../src/lib/accessDocs");
  const { scopesFor } = require("../src/lib/permissions");
  const userCols = await qi.describeTable("users");
  let manageAdded = false;
  if (!userCols.can_manage) {
    await qi.addColumn("users", "can_manage", { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
    console.log("  + added users.can_manage");
    manageAdded = true;
  }
  const tablesNow = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName).toLowerCase());
  if (!tablesNow.includes("user_rights")) {
    await UserRight.sync();
    console.log("  + created table user_rights");
    const rules = await RolePermission.findAll({ raw: true });
    const links = await UserGroup.findAll({ raw: true });
    // ticks saved by earlier versions of this screen, if any
    const oldRows = await sequelize.query("SELECT * FROM users", { type: "SELECT" });
    const oldById = new Map(oldRows.map((r) => [r.id, r]));
    const flag = (row, col) => (row && col in row ? !!Number(row[col]) : undefined);
    const rows = [];
    for (const u of await User.findAll()) {
      const scopes = scopesFor(rules, new Set(links.filter((l) => l.user_id === u.id).map((l) => l.group_id)));
      const old = oldById.get(u.id);
      const sees = (doc) => scopes.has(`${doc}:read`) || (doc === "subtask" && scopes.has("task:read"));
      for (const doc of ACCESS_DOCS) {
        for (const tick of doc.actions) {
          let on = flag(old, `${doc.key}_${tick}`); // per-column ticks
          if (on === undefined && (doc.key === "task" || doc.key === "subtask")) {
            const simple = tick === "add" ? "can_add" : tick === "delete" ? "can_delete" : tick === "comment" ? null : "can_change";
            if (simple) on = flag(old, simple); // simple ticks
          }
          if (on === undefined) {
            on = tick === "comment" ? sees(doc.key) : engineActions(doc, tick).some((a) => scopes.has(`${doc.key}:${a}`));
          }
          if (on) rows.push({ user_id: u.id, doc: doc.key, action: tick });
        }
      }
      if (manageAdded) await u.update({ can_manage: scopes.has("administration:read") });
    }
    if (rows.length) await UserRight.bulkCreate(rows);
    console.log(`  + gave each person the rights they had before (${rows.length} rights)`);
  }

  // ---- Clean up what the app no longer uses ----
  const pruned = await pruneRoleRules();
  if (pruned) console.log(`  - removed ${pruned} old role rules (only "what they can see" is kept)`);
  const cols = await qi.describeTable("users");
  for (const col of OLD_USER_COLUMNS) {
    if (cols[col]) {
      if (sequelize.getDialect() === "sqlite") await sequelize.query(`ALTER TABLE users DROP COLUMN ${col}`);
      else await qi.removeColumn("users", col); // also drops SQL Server default constraints
      console.log(`  - removed users.${col}`);
    }
  }
  const tablesLeft = (await qi.showAllTables()).map((t) => (typeof t === "string" ? t : t.tableName).toLowerCase());
  for (const table of OLD_TABLES) {
    if (tablesLeft.includes(table)) {
      await qi.dropTable(table);
      console.log(`  - removed table ${table}`);
    }
  }

  console.log("Done.");
  await sequelize.close();
}

main().catch(async (err) => {
  console.error("Migration failed:", err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});