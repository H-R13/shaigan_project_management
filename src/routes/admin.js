// Management area — replacement for the Django admin (core/admin.py).
// Each "resource" below describes one table: its form fields, list
// columns, filters and search fields. The generic routes at the bottom
// turn that into list / add / edit / delete pages.

const express = require("express");
const { Op, UniqueConstraintError, ForeignKeyConstraintError, ValidationError } = require("sequelize");
const {
  sequelize,
  User,
  Group,
  Project,
  ProjectList,
  Task,
  Subtask,
  Comment,
  ActivityLog,
  RolePermission,
} = require("../models");
const { adminRequired } = require("../middleware/auth");
const { cleanForm, initialValues, hasErrors } = require("../lib/forms");
const { hashPassword } = require("../lib/password");
const { formatDate, formatDateTime, truncate } = require("../middleware/locals");
const {
  PROJECT_STATUS,
  TASK_PRIORITY,
  TASK_STATUS,
  SUBTASK_STATUS,
  label,
} = require("../lib/choices");
const P = require("../lib/permissions");
const { NotFound, PermissionDenied } = P;

const router = express.Router();
router.use(adminRequired);

const PAGE_SIZE = 50;

// ---------------------------------------------------------
// Choice loaders for foreign keys
// ---------------------------------------------------------
const userChoices = async () =>
  (await User.findAll({ order: [["username", "ASC"]] })).map((u) => [u.id, u.username]);
const projectChoices = async () =>
  (await Project.findAll({ order: [["name", "ASC"]] })).map((p) => [p.id, p.name]);
const listChoices = async () =>
  (
    await ProjectList.findAll({
      include: [{ model: Project, as: "project" }],
      order: [["project_id", "ASC"], ["order", "ASC"], ["id", "ASC"]],
    })
  ).map((l) => [l.id, `${l.project.name} - ${l.name}`]);
const taskChoices = async () =>
  (await Task.findAll({ order: [["title", "ASC"]] })).map((t) => [t.id, t.title]);
const subtaskChoices = async () =>
  (
    await Subtask.findAll({ include: [{ model: Task, as: "task", attributes: ["title"] }], order: [["task_id", "ASC"], ["id", "ASC"]] })
  ).map((x) => [x.id, `${x.task ? x.task.title : "?"} - ${x.title}`]);
const groupChoices = async () =>
  (await Group.findAll({ order: [["name", "ASC"]] })).map((g) => [g.id, g.name]);

const name = (obj) => (obj ? obj.username || obj.name || obj.title : "-");

// ---------------------------------------------------------
// Resources
// ---------------------------------------------------------
const resources = {
  projects: {
    module: "project",
    model: Project,
    label: "Project",
    plural: "Projects",
    display: (o) => o.name,
    fields: async () => [
      { name: "name", label: "Name", type: "text", required: true, maxLength: 200 },
      { name: "description", label: "Description", type: "textarea" },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "end_date", label: "End date", type: "date" },
      { name: "status", label: "Status", type: "select", required: true, choices: PROJECT_STATUS },
      { name: "created_by_id", label: "Created by", type: "fk", required: true, choices: await userChoices() },
    ],
    defaults: (req) => ({ status: "planning", created_by_id: req.user.id }),
    include: [{ model: User, as: "created_by" }],
    columns: [
      ["Name", (o) => o.name],
      ["Status", (o) => label(PROJECT_STATUS, o.status)],
      ["Start date", (o) => formatDate(o.start_date)],
      ["End date", (o) => formatDate(o.end_date)],
      ["Created by", (o) => name(o.created_by)],
    ],
    filters: [{ field: "status", label: "Status", choices: async () => PROJECT_STATUS }],
    search: ["name"],
  },

  lists: {
    module: "projectlist",
    model: ProjectList,
    label: "Project list",
    plural: "Project lists",
    display: (o) => o.name,
    fields: async () => [
      { name: "project_id", label: "Project", type: "fk", required: true, choices: await projectChoices() },
      { name: "name", label: "Name", type: "text", required: true, maxLength: 200 },
      { name: "description", label: "Description", type: "textarea" },
      { name: "order", label: "Order", type: "number", required: true, min: 0 },
    ],
    defaults: () => ({ order: 0 }),
    include: [{ model: Project, as: "project" }],
    columns: [
      ["Name", (o) => o.name],
      ["Project", (o) => name(o.project)],
      ["Order", (o) => o.order],
    ],
    filters: [{ field: "project_id", label: "Project", choices: projectChoices }],
    search: ["name"],
    order: [["project_id", "ASC"], ["order", "ASC"], ["id", "ASC"]],
  },

  tasks: {
    module: "task",
    model: Task,
    label: "Task",
    plural: "Tasks",
    display: (o) => o.title,
    fields: async () => [
      { name: "project_list_id", label: "Project list", type: "fk", required: true, choices: await listChoices() },
      { name: "title", label: "Title", type: "text", required: true, maxLength: 255 },
      { name: "description", label: "Description", type: "textarea" },
      { name: "assigned_to_id", label: "Assigned to", type: "fk", choices: await userChoices() },
      { name: "created_by_id", label: "Created by", type: "fk", required: true, choices: await userChoices() },
      { name: "priority", label: "Priority", type: "select", required: true, choices: TASK_PRIORITY },
      { name: "status", label: "Status", type: "select", required: true, choices: TASK_STATUS },
      { name: "start_date", label: "Start date", type: "date" },
      { name: "due_date", label: "Due date", type: "date" },
      { name: "follow_up_date", label: "Next follow-up date", type: "date" },
    ],
    defaults: (req) => ({ priority: "normal", status: "todo", created_by_id: req.user.id }),
    include: [
      { model: ProjectList, as: "project_list", include: [{ model: Project, as: "project" }] },
      { model: User, as: "assigned_to" },
    ],
    columns: [
      ["Title", (o) => o.title],
      ["Project list", (o) => (o.project_list ? `${o.project_list.project.name} - ${o.project_list.name}` : "-")],
      ["Assigned to", (o) => name(o.assigned_to)],
      ["Priority", (o) => label(TASK_PRIORITY, o.priority)],
      ["Status", (o) => label(TASK_STATUS, o.status)],
      ["Due date", (o) => formatDate(o.due_date)],
      ["Follow-up", (o) => formatDate(o.follow_up_date)],
    ],
    filters: [
      { field: "priority", label: "Priority", choices: async () => TASK_PRIORITY },
      { field: "status", label: "Status", choices: async () => TASK_STATUS },
      { field: "project_list_id", label: "Project list", choices: listChoices },
    ],
    search: ["title", "description"],
  },

  subtasks: {
    module: "subtask",
    model: Subtask,
    label: "Subtask",
    plural: "Subtasks",
    display: (o) => o.title,
    fields: async () => [
      { name: "task_id", label: "Task", type: "fk", required: true, choices: await taskChoices() },
      { name: "title", label: "Title", type: "text", required: true, maxLength: 255 },
      { name: "assigned_to_id", label: "Assigned to", type: "fk", choices: await userChoices() },
      { name: "status", label: "Status", type: "select", required: true, choices: SUBTASK_STATUS },
      { name: "due_date", label: "Due date", type: "date" },
      { name: "follow_up_date", label: "Next follow-up date", type: "date" },
    ],
    defaults: () => ({ status: "todo" }),
    include: [{ model: Task, as: "task" }, { model: User, as: "assigned_to" }],
    columns: [
      ["Title", (o) => o.title],
      ["Task", (o) => name(o.task)],
      ["Assigned to", (o) => name(o.assigned_to)],
      ["Status", (o) => label(SUBTASK_STATUS, o.status)],
      ["Due date", (o) => formatDate(o.due_date)],
      ["Follow-up", (o) => formatDate(o.follow_up_date)],
    ],
    filters: [{ field: "status", label: "Status", choices: async () => SUBTASK_STATUS }],
    search: ["title"],
  },

  comments: {
    module: "comment",
    model: Comment,
    label: "Comment",
    plural: "Comments",
    display: (o) => `Comment by ${name(o.user)}`,
    fields: async () => [
      { name: "task_id", label: "Task", type: "fk", required: true, choices: await taskChoices() },
      {
        name: "subtask_id", label: "Subtask", type: "fk", choices: await subtaskChoices(),
        help: "Leave empty for a comment on the task itself. If a subtask is chosen, the task is set to that subtask's task.",
      },
      { name: "user_id", label: "User", type: "fk", required: true, choices: await userChoices() },
      { name: "comment", label: "Comment", type: "textarea", required: true },
    ],
    defaults: (req) => ({ user_id: req.user.id }),
    // A subtask comment always belongs to that subtask's task
    save: async (obj, data, t) => {
      if (data.subtask_id) {
        const sub = await Subtask.findByPk(data.subtask_id, { transaction: t });
        if (sub) data.task_id = sub.task_id;
      }
      if (obj) await obj.update(data, { transaction: t });
      else obj = await Comment.create(data, { transaction: t });
      return obj;
    },
    include: [{ model: Task, as: "task" }, { model: Subtask, as: "subtask" }, { model: User, as: "user" }],
    columns: [
      ["Task", (o) => name(o.task)],
      ["Subtask", (o) => (o.subtask ? o.subtask.title : "-")],
      ["User", (o) => name(o.user)],
      ["Comment", (o) => truncate(o.comment, 60)],
      ["Created at", (o) => formatDateTime(o.created_at)],
    ],
    filters: [],
    search: ["comment"],
  },

  activity: {
    module: "activitylog",
    model: ActivityLog,
    label: "Activity log",
    plural: "Activity logs",
    display: (o) => `${name(o.user)} - ${o.action}`,
    fields: async () => [
      { name: "task_id", label: "Task", type: "fk", choices: await taskChoices() },
      { name: "user_id", label: "User", type: "fk", required: true, choices: await userChoices() },
      { name: "action", label: "Action", type: "text", required: true, maxLength: 100 },
      { name: "details", label: "Details", type: "textarea" },
    ],
    defaults: (req) => ({ user_id: req.user.id }),
    include: [{ model: Task, as: "task" }, { model: User, as: "user" }],
    columns: [
      ["Task", (o) => name(o.task)],
      ["User", (o) => name(o.user)],
      ["Action", (o) => o.action],
      ["Created at", (o) => formatDateTime(o.created_at)],
    ],
    filters: [
      {
        field: "action",
        label: "Action",
        choices: async () =>
          (await ActivityLog.unscoped().findAll({ attributes: ["action"], group: ["action"], raw: true })).map((r) => [
            r.action,
            r.action,
          ]),
      },
    ],
    search: ["details"],
    order: [["created_at", "DESC"], ["id", "DESC"]],
  },

  // ---------------- Users (custom save for password + groups) ----------------
  users: {
    module: "user",
    model: User,
    label: "User",
    plural: "Users",
    display: (o) => o.username,
    fields: async (obj) => [
      { name: "username", label: "Username", type: "text", required: true, maxLength: 150 },
      {
        name: "password",
        label: obj ? "New password" : "Password",
        type: "password",
        required: !obj,
        help: obj ? "Leave blank to keep the current password." : "",
      },
      { name: "first_name", label: "First name", type: "text", maxLength: 150 },
      { name: "last_name", label: "Last name", type: "text", maxLength: 150 },
      { name: "email", label: "Email address", type: "text", maxLength: 254 },
      { name: "is_active", label: "Active", type: "checkbox" },
      {
        name: "is_superuser",
        label: "Superuser status",
        type: "checkbox",
        help: "Has all permissions without explicitly assigning them.",
      },
      {
        name: "can_manage", label: "Admin (full control, including Administration)", type: "checkbox",
        help: "Everything else this person may do is set in Users & access.",
      },
      {
        name: "group_ids",
        label: "Role",
        type: "multiselect",
        choices: await groupChoices(),
        help: "The role decides what this person can see (Users & access).",
      },
    ],
    defaults: () => ({ is_active: true }),
    load: async (obj) => {
      const groups = await obj.getGroups();
      return { ...obj.get(), password: "", group_ids: groups.map((g) => g.id) };
    },
    save: async (obj, data, t) => {
      const { group_ids, password, ...fields } = data;
      if (password) fields.password = await hashPassword(password);
      if (obj) await obj.update(fields, { transaction: t });
      else obj = await User.create(fields, { transaction: t });
      await obj.setGroups(group_ids.map(Number), { transaction: t });
      return obj;
    },
    include: [{ model: Group, as: "groups", through: { attributes: [] } }],
    columns: [
      ["Username", (o) => o.username],
      ["Email", (o) => o.email || "-"],
      ["Name", (o) => o.getFullName() || "-"],
      ["Roles", (o) => o.groups.map((g) => g.name).join(", ") || "-"],
      ["Superuser", (o) => (o.is_superuser ? "Yes" : "No")],
      ["Active", (o) => (o.is_active ? "Yes" : "No")],
    ],
    filters: [],
    search: ["username", "first_name", "last_name", "email"],
    order: [["username", "ASC"]],
  },

  // ---------------- Groups / roles ----------------
  groups: {
    module: "group",
    model: Group,
    label: "Role",
    plural: "Roles (groups)",
    display: (o) => o.name,
    fields: async () => [
      {
        name: "name", label: "Name", type: "text", required: true, maxLength: 150,
        help: "After saving, set what this role can see in Administration > Users & access.",
      },
    ],
    defaults: () => ({}),
    afterSave: () => P.invalidateConfig(),
    include: [{ model: RolePermission, as: "rolePermissions", attributes: ["id"] }],
    columns: [
      ["Name", (o) => o.name],
      ["Permission rules", (o) => String(o.rolePermissions.length)],
    ],
    filters: [],
    search: ["name"],
    order: [["name", "ASC"]],
  },
};

const SECTIONS = [
  { title: "Authentication", keys: ["users", "groups"] },
  { title: "Projects", keys: ["projects", "lists", "tasks", "subtasks", "comments", "activity"] },
];

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------
function getResource(key) {
  const r = resources[key];
  if (!r) throw new NotFound("Unknown section.");
  return r;
}

// Each section needs the matching permission (on all records) for its module
const ACTION_WORDS = { read: "view", create: "add", edit: "change", delete: "delete" };
function requireResource(req, r, action) {
  if (!P.canAll(req.user, r.module, action)) {
    throw new PermissionDenied(`You do not have permission to ${ACTION_WORDS[action]} ${r.plural.toLowerCase()}.`);
  }
}
const resourcePerms = (user, r) => ({
  read: P.canAll(user, r.module, "read"),
  create: P.canAll(user, r.module, "create"),
  edit: P.canAll(user, r.module, "edit"),
  delete: P.canAll(user, r.module, "delete"),
});

async function findOr404(r, id) {
  const n = Number(id);
  const obj = Number.isInteger(n) && n > 0 ? await r.model.unscoped().findByPk(n, { include: r.include }) : null;
  if (!obj) throw new NotFound(`${r.label} not found.`);
  return obj;
}

function translateDbError(err, errors) {
  if (err instanceof UniqueConstraintError) {
    const field = (err.errors && err.errors[0] && err.errors[0].path) || "__all__";
    errors[field] = "A record with this value already exists.";
    return true;
  }
  if (err instanceof ValidationError) {
    for (const e of err.errors) errors[e.path || "__all__"] = e.message;
    return true;
  }
  if (err instanceof ForeignKeyConstraintError) {
    errors.__all__ = "A related record does not exist.";
    return true;
  }
  return false;
}

function render(res, view, locals) {
  const user = res.locals.user;
  const rperm = Object.fromEntries(Object.entries(resources).map(([k, r]) => [k, resourcePerms(user, r)]));
  res.render(view, { sections: SECTIONS, resources, rperm, ...locals });
}

// ---------------------------------------------------------
// Index
// ---------------------------------------------------------
router.get("/", async (req, res) => {
  const counts = {};
  for (const [key, r] of Object.entries(resources)) {
    if (P.canAll(req.user, r.module, "read")) counts[key] = await r.model.unscoped().count();
  }
  render(res, "admin/index", {
    title: "Administration",
    counts,
    canManagePermissions: P.canAll(req.user, "group", "edit"),
  });
});

// ---------------------------------------------------------
// List
// ---------------------------------------------------------
router.get("/:resource/", async (req, res) => {
  const key = req.params.resource;
  const r = getResource(key);
  requireResource(req, r, "read");
  const q = (req.query.q || "").trim();
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const where = {};
  const activeFilters = {};
  const filters = [];
  for (const f of r.filters) {
    const choices = await f.choices();
    filters.push({ ...f, choices });
    const val = req.query[f.field];
    if (val !== undefined && val !== "" && choices.some(([v]) => String(v) === val)) {
      where[f.field] = val;
      activeFilters[f.field] = val;
    }
  }
  if (q && r.search.length) {
    where[Op.or] = r.search.map((field) => ({ [field]: { [Op.like]: `%${q}%` } }));
  }

  const { rows, count } = await r.model.unscoped().findAndCountAll({
    where,
    include: r.include,
    order: r.order || [["id", "DESC"]],
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
    distinct: true,
  });

  render(res, "admin/list", {
    title: r.plural,
    key,
    r,
    rows,
    count,
    q,
    filters,
    activeFilters,
    page,
    pages: Math.max(1, Math.ceil(count / PAGE_SIZE)),
  });
});

// ---------------------------------------------------------
// Add / Edit
// ---------------------------------------------------------
async function showForm(req, res, key, obj) {
  const r = getResource(key);
  requireResource(req, r, obj ? "edit" : "create");
  const fields = await r.fields(obj);
  const source = obj ? (r.load ? await r.load(obj) : obj) : r.defaults(req);
  render(res, "admin/form", {
    title: obj ? `Change ${r.label.toLowerCase()}` : `Add ${r.label.toLowerCase()}`,
    key,
    r,
    obj,
    fields,
    values: initialValues(fields, source),
    errors: {},
  });
}

async function saveForm(req, res, key, obj) {
  const r = getResource(key);
  requireResource(req, r, obj ? "edit" : "create");
  const fields = await r.fields(obj);
  const { data, errors, values } = cleanForm(fields, req.body);

  if (!hasErrors(errors)) {
    try {
      await sequelize.transaction(async (t) => {
        if (r.save) obj = await r.save(obj, data, t);
        else if (obj) await obj.update(data, { transaction: t });
        else obj = await r.model.create(data, { transaction: t });
      });
      if (r.afterSave) r.afterSave(obj);
    } catch (err) {
      if (!translateDbError(err, errors)) throw err;
    }
  }

  if (hasErrors(errors)) {
    return render(res.status(400), "admin/form", {
      title: obj ? `Change ${r.label.toLowerCase()}` : `Add ${r.label.toLowerCase()}`,
      key,
      r,
      obj,
      fields,
      values,
      errors,
    });
  }

  req.flash("success", `The ${r.label.toLowerCase()} "${r.display(obj)}" was saved.`);
  if (req.body._addanother) return res.redirect(`/admin/${key}/add/`);
  res.redirect(`/admin/${key}/`);
}

router.get("/:resource/add/", (req, res) => showForm(req, res, req.params.resource, null));
router.post("/:resource/add/", (req, res) => saveForm(req, res, req.params.resource, null));

router.get("/:resource/:id/", async (req, res) => {
  const r = getResource(req.params.resource);
  await showForm(req, res, req.params.resource, await findOr404(r, req.params.id));
});
router.post("/:resource/:id/", async (req, res) => {
  const r = getResource(req.params.resource);
  await saveForm(req, res, req.params.resource, await findOr404(r, req.params.id));
});

// ---------------------------------------------------------
// Delete
// ---------------------------------------------------------
router.get("/:resource/:id/delete/", async (req, res) => {
  const key = req.params.resource;
  const r = getResource(key);
  requireResource(req, r, "delete");
  const obj = await findOr404(r, req.params.id);
  render(res, "admin/delete", { title: `Delete ${r.label.toLowerCase()}`, key, r, obj, error: null });
});

router.post("/:resource/:id/delete/", async (req, res) => {
  const key = req.params.resource;
  const r = getResource(key);
  requireResource(req, r, "delete");
  const obj = await findOr404(r, req.params.id);

  if (key === "users" && obj.id === req.user.id) {
    return render(res.status(400), "admin/delete", {
      title: `Delete ${r.label.toLowerCase()}`, key, r, obj,
      error: "You cannot delete your own account while logged in.",
    });
  }

  try {
    await obj.destroy();
  } catch (err) {
    if (err instanceof ForeignKeyConstraintError) {
      // Same as Django's on_delete=PROTECT
      return render(res.status(400), "admin/delete", {
        title: `Delete ${r.label.toLowerCase()}`, key, r, obj,
        error: `Cannot delete "${r.display(obj)}" because other records (projects, tasks, subtasks, comments or activity logs) still refer to it. Reassign or delete those first.`,
      });
    }
    throw err;
  }

  if (r.afterSave) r.afterSave(obj);
  req.flash("success", `The ${r.label.toLowerCase()} "${r.display(obj)}" was deleted.`);
  res.redirect(`/admin/${key}/`);
});

module.exports = router;