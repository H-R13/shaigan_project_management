// Sequelize models: a direct port of core/models.py plus the parts
// of django.contrib.auth the app relies on (users, groups, permissions).
//
// Django's on_delete=PROTECT becomes onDelete "NO ACTION" (the database
// refuses to delete a user who still owns projects/tasks/comments).
// "NO ACTION" is used instead of "RESTRICT" because SQL Server does not
// support RESTRICT; for these tables the behaviour is the same.

const { DataTypes } = require("sequelize");
const sequelize = require("../config/database");
const {
  PROJECT_STATUS,
  TASK_PRIORITY,
  TASK_STATUS,
  SUBTASK_STATUS,
  label,
} = require("../lib/choices");

const values = (choices) => choices.map(([v]) => v);
const PROTECT = { onDelete: "NO ACTION", onUpdate: "NO ACTION" };
const CASCADE = { onDelete: "CASCADE", onUpdate: "NO ACTION" };

// =========================================================
// AUTH
// =========================================================

const User = sequelize.define(
  "User",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    username: { type: DataTypes.STRING(150), allowNull: false, unique: true },
    password: { type: DataTypes.STRING(128), allowNull: false },
    first_name: { type: DataTypes.STRING(150), allowNull: false, defaultValue: "" },
    last_name: { type: DataTypes.STRING(150), allowNull: false, defaultValue: "" },
    email: { type: DataTypes.STRING(254), allowNull: false, defaultValue: "" },
    is_superuser: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    is_active: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    last_login: { type: DataTypes.DATE, allowNull: true },
    date_joined: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    // Admin: full control, including Administration. Everything else a
    // person may do is in user_rights (Administration > Users & access);
    // what they can see comes from their role.
    can_manage: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
  },
  { tableName: "users", timestamps: false }
);

User.prototype.getFullName = function () {
  return `${this.first_name || ""} ${this.last_name || ""}`.trim();
};
User.prototype.displayName = function () {
  return this.getFullName() || this.username;
};
User.prototype.toString = function () {
  return this.username;
};

const Group = sequelize.define(
  "Group",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(150), allowNull: false, unique: true },
  },
  // "groups" is a reserved word in MySQL 8, so the table is auth_groups
  { tableName: "auth_groups", timestamps: false }
);

const UserGroup = sequelize.define(
  "UserGroup",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    user_id: { type: DataTypes.INTEGER, allowNull: false },
    group_id: { type: DataTypes.INTEGER, allowNull: false },
  },
  // belongsToMany (below) adds the unique (user_id, group_id) key
  { tableName: "user_groups", timestamps: false }
);

// =========================================================
// CORE
// =========================================================

const Project = sequelize.define(
  "Project",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    start_date: { type: DataTypes.DATEONLY, allowNull: true },
    end_date: { type: DataTypes.DATEONLY, allowNull: true },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "planning",
      validate: { isIn: [values(PROJECT_STATUS)] },
    },
  },
  { tableName: "projects", timestamps: true, createdAt: "created_at", updatedAt: false }
);
Project.prototype.getStatusDisplay = function () {
  return label(PROJECT_STATUS, this.status);
};
Project.prototype.toString = function () {
  return this.name;
};

const ProjectList = sequelize.define(
  "ProjectList",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    order: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 },
    },
  },
  { tableName: "project_lists", timestamps: false }
);
ProjectList.prototype.toString = function () {
  return this.project ? `${this.project.name} - ${this.name}` : this.name;
};

const Task = sequelize.define(
  "Task",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
    priority: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "normal",
      validate: { isIn: [values(TASK_PRIORITY)] },
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "todo",
      validate: { isIn: [values(TASK_STATUS)] },
    },
    start_date: { type: DataTypes.DATEONLY, allowNull: true },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    follow_up_date: { type: DataTypes.DATEONLY, allowNull: true },
  },
  { tableName: "tasks", timestamps: true, createdAt: "created_at", updatedAt: "updated_at" }
);
Task.prototype.getPriorityDisplay = function () {
  return label(TASK_PRIORITY, this.priority);
};
Task.prototype.getStatusDisplay = function () {
  return label(TASK_STATUS, this.status);
};
Task.prototype.toString = function () {
  return this.title;
};

const Subtask = sequelize.define(
  "Subtask",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING(255), allowNull: false },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: "todo",
      validate: { isIn: [values(SUBTASK_STATUS)] },
    },
    due_date: { type: DataTypes.DATEONLY, allowNull: true },
    follow_up_date: { type: DataTypes.DATEONLY, allowNull: true },
  },
  { tableName: "subtasks", timestamps: true, createdAt: "created_at", updatedAt: "updated_at" }
);
Subtask.prototype.getStatusDisplay = function () {
  return label(SUBTASK_STATUS, this.status);
};
Subtask.prototype.toString = function () {
  return this.title;
};

const Comment = sequelize.define(
  "Comment",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    comment: { type: DataTypes.TEXT, allowNull: false },
  },
  { tableName: "comments", timestamps: true, createdAt: "created_at", updatedAt: false }
);
Comment.prototype.toString = function () {
  return `Comment by ${this.user ? this.user.username : "?"}`;
};

// Per-user access to a subtask: "edit" (can update it) or "view" (read only).
// The subtask's "Assigned to" user always has edit access on top of these.
const SUBTASK_ACCESS = [
  ["edit", "Can edit"],
  ["view", "Read only"],
];
const SubtaskMember = sequelize.define(
  "SubtaskMember",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    access: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: "view",
      validate: { isIn: [values(SUBTASK_ACCESS)] },
    },
  },
  {
    tableName: "subtask_members",
    timestamps: false,
    indexes: [{ unique: true, fields: ["subtask_id", "user_id"] }],
  }
);
SubtaskMember.prototype.getAccessDisplay = function () {
  return label(SUBTASK_ACCESS, this.access);
};

// =========================================================
// ACCESS (Administration > Users & access)
// =========================================================

// Role x document -> what the role can see: "all" records or only "own"
// records (action "read"). No row = cannot see it.
const PERM_SCOPES = [
  ["own", "Own"],
  ["all", "All"],
];
const RolePermission = sequelize.define(
  "RolePermission",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    module_key: { type: DataTypes.STRING(60), allowNull: false },
    action_key: { type: DataTypes.STRING(60), allowNull: false },
    scope: { type: DataTypes.STRING(10), allowNull: false, defaultValue: "all", validate: { isIn: [values(PERM_SCOPES)] } },
  },
  {
    tableName: "role_permissions",
    timestamps: false,
    indexes: [{ unique: true, fields: ["group_id", "module_key", "action_key"] }],
  }
);

// What one person may do on one document type: (user, doc, action),
// e.g. (ali, "task", "add"). See lib/accessDocs.js.
const UserRight = sequelize.define(
  "UserRight",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    doc: { type: DataTypes.STRING(60), allowNull: false },
    action: { type: DataTypes.STRING(30), allowNull: false },
  },
  {
    tableName: "user_rights",
    timestamps: false,
    indexes: [{ unique: true, fields: ["user_id", "doc", "action"] }],
  }
);

const ActivityLog = sequelize.define(
  "ActivityLog",
  {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
    action: { type: DataTypes.STRING(100), allowNull: false },
    details: { type: DataTypes.TEXT, allowNull: false, defaultValue: "" },
  },
  {
    tableName: "activity_logs",
    timestamps: true,
    createdAt: "created_at",
    updatedAt: false,
    defaultScope: { order: [["created_at", "DESC"]] },
  }
);
ActivityLog.prototype.toString = function () {
  return `${this.user ? this.user.username : "?"} - ${this.action}`;
};

// =========================================================
// RELATIONSHIPS
// =========================================================

// Users <-> Groups (many-to-many)
User.belongsToMany(Group, { through: UserGroup, as: "groups", foreignKey: "user_id", otherKey: "group_id" });
Group.belongsToMany(User, { through: UserGroup, as: "users", foreignKey: "group_id", otherKey: "user_id" });

// Project.created_by -> User (PROTECT)
Project.belongsTo(User, { as: "created_by", foreignKey: { name: "created_by_id", allowNull: false }, ...PROTECT });
User.hasMany(Project, { as: "created_projects", foreignKey: { name: "created_by_id", allowNull: false }, ...PROTECT });

// ProjectList.project -> Project (CASCADE)
ProjectList.belongsTo(Project, { as: "project", foreignKey: { name: "project_id", allowNull: false }, ...CASCADE });
Project.hasMany(ProjectList, { as: "lists", foreignKey: { name: "project_id", allowNull: false }, ...CASCADE });

// Task.project_list -> ProjectList (CASCADE)
Task.belongsTo(ProjectList, { as: "project_list", foreignKey: { name: "project_list_id", allowNull: false }, ...CASCADE });
ProjectList.hasMany(Task, { as: "tasks", foreignKey: { name: "project_list_id", allowNull: false }, ...CASCADE });

// Task.assigned_to / created_by -> User (PROTECT)
Task.belongsTo(User, { as: "assigned_to", foreignKey: { name: "assigned_to_id", allowNull: true }, ...PROTECT });
User.hasMany(Task, { as: "assigned_tasks", foreignKey: { name: "assigned_to_id", allowNull: true }, ...PROTECT });
Task.belongsTo(User, { as: "created_by", foreignKey: { name: "created_by_id", allowNull: false }, ...PROTECT });
User.hasMany(Task, { as: "created_tasks", foreignKey: { name: "created_by_id", allowNull: false }, ...PROTECT });

// Subtask.task -> Task (CASCADE), Subtask.assigned_to -> User (PROTECT)
Subtask.belongsTo(Task, { as: "task", foreignKey: { name: "task_id", allowNull: false }, ...CASCADE });
Task.hasMany(Subtask, { as: "subtasks", foreignKey: { name: "task_id", allowNull: false }, ...CASCADE });
Subtask.belongsTo(User, { as: "assigned_to", foreignKey: { name: "assigned_to_id", allowNull: true }, ...PROTECT });
User.hasMany(Subtask, { as: "assigned_subtasks", foreignKey: { name: "assigned_to_id", allowNull: true }, ...PROTECT });

// Comment.task -> Task (CASCADE), Comment.user -> User (PROTECT)
Comment.belongsTo(Task, { as: "task", foreignKey: { name: "task_id", allowNull: false }, ...CASCADE });
Task.hasMany(Comment, { as: "comments", foreignKey: { name: "task_id", allowNull: false }, ...CASCADE });
Comment.belongsTo(User, { as: "user", foreignKey: { name: "user_id", allowNull: false }, ...PROTECT });


// Comment.subtask -> Subtask (optional). A comment with subtask_id belongs to
// that subtask; without it, it belongs to the task. No database constraint on
// purpose (SQL Server does not allow two cascade paths into one table):
// task/project deletes still remove these comments through task_id, and
// deleting a single subtask removes its comments with the hook below.
Comment.belongsTo(Subtask, { as: "subtask", foreignKey: { name: "subtask_id", allowNull: true }, constraints: false });
Subtask.hasMany(Comment, { as: "comments", foreignKey: { name: "subtask_id", allowNull: true }, constraints: false });
Subtask.addHook("beforeDestroy", async (subtask, options) => {
  await Comment.destroy({ where: { subtask_id: subtask.id }, transaction: options.transaction });
});

// SubtaskMember.subtask -> Subtask (CASCADE), SubtaskMember.user -> User (CASCADE)
SubtaskMember.belongsTo(Subtask, { as: "subtask", foreignKey: { name: "subtask_id", allowNull: false }, ...CASCADE });
Subtask.hasMany(SubtaskMember, { as: "members", foreignKey: { name: "subtask_id", allowNull: false }, ...CASCADE });
SubtaskMember.belongsTo(User, { as: "user", foreignKey: { name: "user_id", allowNull: false }, ...CASCADE });
User.hasMany(SubtaskMember, { as: "subtaskMemberships", foreignKey: { name: "user_id", allowNull: false }, ...CASCADE });
Subtask.addHook("beforeDestroy", async (subtask, options) => {
  await SubtaskMember.destroy({ where: { subtask_id: subtask.id }, transaction: options.transaction });
});

// Access rows belong to a role (group) or a person; removed with them
RolePermission.belongsTo(Group, { as: "group", foreignKey: { name: "group_id", allowNull: false }, ...CASCADE });
Group.hasMany(RolePermission, { as: "rolePermissions", foreignKey: { name: "group_id", allowNull: false }, ...CASCADE });
UserRight.belongsTo(User, { as: "user", foreignKey: { name: "user_id", allowNull: false }, ...CASCADE });
User.hasMany(UserRight, { as: "rights", foreignKey: { name: "user_id", allowNull: false }, ...CASCADE });

// ActivityLog.task -> Task (CASCADE, nullable), ActivityLog.user -> User (PROTECT)
ActivityLog.belongsTo(Task, { as: "task", foreignKey: { name: "task_id", allowNull: true }, ...CASCADE });
Task.hasMany(ActivityLog, { as: "activity_logs", foreignKey: { name: "task_id", allowNull: true }, ...CASCADE });
ActivityLog.belongsTo(User, { as: "user", foreignKey: { name: "user_id", allowNull: false }, ...PROTECT });

module.exports = {
  sequelize,
  User,
  Group,
  UserGroup,
  Project,
  ProjectList,
  Task,
  Subtask,
  Comment,
  SubtaskMember,
  SUBTASK_ACCESS,
  ActivityLog,
  RolePermission,
  UserRight,
  PERM_SCOPES,
};
