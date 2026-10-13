// Copies all data from the old Django db.sqlite3 into the new SQL database:
// users (with their existing passwords), roles, projects,
// lists, tasks, subtasks, comments and activity logs. IDs are preserved,
// so old links like /task/3/ keep working.
//
//   npm run import:django -- path/to/db.sqlite3
//
// Run `npm run db:init` first. The target database must be empty
// (apart from the four roles created by db:init).

require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs");
const { Sequelize, QueryTypes } = require("sequelize");
const {
  sequelize,
  User,
  Group,
  UserGroup,
  Project,
  ProjectList,
  Task,
  Subtask,
  Comment,
  ActivityLog,
} = require("../src/models");

const file = path.resolve(process.argv[2] || "../ProjectManagement/db.sqlite3");

// Django stores datetimes in UTC as "YYYY-MM-DD HH:MM:SS[.ffffff]"
const dt = (v) => (v ? new Date(`${String(v).replace(" ", "T")}${/[zZ+]/.test(String(v).slice(19)) ? "" : "Z"}`) : null);
const bool = (v) => v === 1 || v === true || v === "1";

async function main() {
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  let source;
  try {
    source = new Sequelize({ dialect: "sqlite", storage: file, logging: false });
    await source.authenticate();
  } catch (err) {
    throw new Error(`Cannot open the Django database (is the "sqlite3" package installed?): ${err.message}`);
  }
  const q = (sql) => source.query(sql, { type: QueryTypes.SELECT });

  await sequelize.authenticate();
  if ((await User.count()) > 0) {
    throw new Error("The target database already has users. Import only into a fresh database.");
  }

  const dialect = sequelize.getDialect();
  console.log(`Importing from ${file} into ${dialect}...`);

  // ---- Read everything from Django ----
  const users = await q("SELECT * FROM auth_user ORDER BY id");
  const groups = await q("SELECT * FROM auth_group ORDER BY id");
  const userGroups = await q("SELECT user_id, group_id FROM auth_user_groups");
  const projects = await q("SELECT * FROM core_project ORDER BY id");
  const lists = await q('SELECT * FROM core_projectlist ORDER BY id');
  const tasks = await q("SELECT * FROM core_task ORDER BY id");
  const subtasks = await q("SELECT * FROM core_subtask ORDER BY id");
  const comments = await q("SELECT * FROM core_comment ORDER BY id");
  const logs = await q("SELECT * FROM core_activitylog ORDER BY id");

  // Insert rows keeping their ids. Passing the model's attributes lets
  // Sequelize wrap the insert in SET IDENTITY_INSERT ON/OFF on SQL Server
  // (it must be in the same batch as the INSERT to take effect).
  // queryInterface.bulkInsert also keeps the original created_at/updated_at.
  async function insert(Model, rows, t) {
    if (!rows.length) return;
    const table = Model.getTableName();
    await sequelize
      .getQueryInterface()
      .bulkInsert(table, rows, { transaction: t }, Model.fieldRawAttributesMap);
    console.log(`  ${table}: ${rows.length}`);
  }

  await sequelize.transaction(async (t) => {
    // Replace the default roles from db:init with the Django ones
    await UserGroup.destroy({ where: {}, transaction: t });
    await Group.destroy({ where: {}, transaction: t });

    await insert(Group, groups.map((g) => ({ id: g.id, name: g.name })), t);
    await insert(
      User,
      users.map((u) => ({
        id: u.id,
        username: u.username,
        password: u.password,
        first_name: u.first_name || "",
        last_name: u.last_name || "",
        email: u.email || "",
        is_superuser: bool(u.is_superuser),
        is_active: bool(u.is_active),
        last_login: dt(u.last_login),
        date_joined: dt(u.date_joined) || new Date(),
      })),
      t
    );

    await UserGroup.bulkCreate(userGroups.map((r) => ({ user_id: r.user_id, group_id: r.group_id })), { transaction: t });
    console.log(`  role memberships: ${userGroups.length}`);

    await insert(
      Project,
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description || "",
        start_date: p.start_date || null,
        end_date: p.end_date || null,
        status: p.status,
        created_by_id: p.created_by_id,
        created_at: dt(p.created_at),
      })),
      t
    );
    await insert(
      ProjectList,
      lists.map((l) => ({ id: l.id, project_id: l.project_id, name: l.name, description: l.description || "", order: l.order })),
      t
    );
    await insert(
      Task,
      tasks.map((x) => ({
        id: x.id,
        project_list_id: x.project_list_id,
        title: x.title,
        description: x.description || "",
        assigned_to_id: x.assigned_to_id,
        created_by_id: x.created_by_id,
        priority: x.priority,
        status: x.status,
        start_date: x.start_date || null,
        due_date: x.due_date || null,
        created_at: dt(x.created_at),
        updated_at: dt(x.updated_at),
      })),
      t
    );
    await insert(
      Subtask,
      subtasks.map((s) => ({
        id: s.id,
        task_id: s.task_id,
        title: s.title,
        assigned_to_id: s.assigned_to_id,
        status: s.status,
        due_date: s.due_date || null,
        created_at: dt(s.created_at),
        updated_at: dt(s.updated_at),
      })),
      t
    );
    await insert(
      Comment,
      comments.map((c) => ({ id: c.id, task_id: c.task_id, user_id: c.user_id, comment: c.comment, created_at: dt(c.created_at) })),
      t
    );
    await insert(
      ActivityLog,
      logs.map((a) => ({
        id: a.id,
        task_id: a.task_id,
        user_id: a.user_id,
        action: a.action,
        details: a.details || "",
        created_at: dt(a.created_at),
      })),
      t
    );

    // PostgreSQL: move the id sequences past the imported ids
    if (dialect === "postgres") {
      for (const M of [Group, User, Project, ProjectList, Task, Subtask, Comment, ActivityLog]) {
        const table = M.getTableName();
        await sequelize.query(
          `SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), COALESCE((SELECT MAX(id) FROM "${table}"), 1))`,
          { transaction: t }
        );
      }
    }
  });

  console.log("\nImport finished. Users can log in with their existing passwords.");
  await source.close();
  await sequelize.close();
}

main().catch(async (err) => {
  console.error("Import failed:", err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
