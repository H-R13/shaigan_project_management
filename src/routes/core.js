// Port of core/views.py and core/urls.py
const express = require("express");
const { Op } = require("sequelize");
const {
  sequelize,
  User,
  Project,
  ProjectList,
  Task,
  Subtask,
  Comment,
  SubtaskMember,
  SUBTASK_ACCESS,
  ActivityLog,
} = require("../models");
const { todayISO } = require("../middleware/locals");
const { TASK_STATUS, TASK_PRIORITY, SUBTASK_STATUS, PROJECT_STATUS } = require("../lib/choices");
const { loginRequired } = require("../middleware/auth");
const { cleanForm, initialValues, hasErrors } = require("../lib/forms");
const coreForms = require("../lib/coreForms");
const { logActivity } = require("../lib/activity");
const P = require("../lib/permissions");

const router = express.Router();
router.use(loginRequired);

// ============================================================
// HELPERS
// ============================================================

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new P.NotFound();
  return id;
}

async function getOr404(Model, id, options = {}) {
  const obj = await Model.findByPk(parseId(id), options);
  if (!obj) throw new P.NotFound(`No ${Model.name} matches the given query.`);
  return obj;
}

const userAttrs = ["id", "username", "first_name", "last_name"];

// Marks the named fields as read-only (shown, but never saved from the form)
function makeReadonly(fields, names) {
  return fields.map((f) => (names.includes(f.name) ? { ...f, readonly: true, required: false } : f));
}

// When a form is shown again after an error, read-only fields keep the
// value stored in the database
function keepReadonlyValues(fields, values, instance) {
  const ro = fields.filter((f) => f.readonly);
  return { ...values, ...initialValues(ro, instance) };
}

// ---- Subtask members (per-user access: "edit" or "view") ----

// Rows for the "Who can access this subtask" table on the subtask form
async function memberFormRows(subtask, submitted) {
  const users = await User.findAll({ where: { is_active: true }, attributes: userAttrs, order: [["username", "ASC"]] });
  let current = new Map();
  if (submitted) current = submitted;
  else if (subtask) {
    const rows = await SubtaskMember.findAll({ where: { subtask_id: subtask.id } });
    current = new Map(rows.map((m) => [m.user_id, m.access]));
  }
  return users.map((u) => ({ user: u, access: current.get(u.id) || "" }));
}

// Reads member_<userId> = "edit" | "view" | "" from the submitted form
function readMemberAccess(body) {
  const allowed = new Set(SUBTASK_ACCESS.map(([v]) => v));
  const map = new Map();
  for (const [key, val] of Object.entries(body || {})) {
    const m = /^member_(\d+)$/.exec(key);
    if (m && allowed.has(String(val))) map.set(Number(m[1]), String(val));
  }
  return map;
}

// Replaces the subtask's members with the given map (only real, active users)
async function saveMembers(subtask, accessMap) {
  const ids = [...accessMap.keys()];
  const valid = ids.length ? await User.findAll({ where: { id: ids, is_active: true }, attributes: ["id"] }) : [];
  await sequelize.transaction(async (t) => {
    await SubtaskMember.destroy({ where: { subtask_id: subtask.id }, transaction: t });
    if (valid.length) {
      await SubtaskMember.bulkCreate(
        valid.map((u) => ({ subtask_id: subtask.id, user_id: u.id, access: accessMap.get(u.id) })),
        { transaction: t }
      );
    }
  });
}

// What a user can see comes from the permission rules
// (Administration > Users & access): a Sequelize where for the module,
// {} for everything, or null for nothing.
const readable = (user, key) => P.where(user, key, "read");
const { TASK_FIELDS, SUBTASK_FIELDS } = coreForms;
const canEditTask = (user, t) => P.canEdit(user, "task", t, TASK_FIELDS);
const canEditSubtask = (user, s) => P.canEdit(user, "subtask", s, SUBTASK_FIELDS);

// Adds `listCount` to each project (replaces {{ project.lists.count }})
async function withListCounts(projects) {
  if (!projects.length) return projects;
  const rows = await ProjectList.findAll({
    attributes: ["project_id", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
    where: { project_id: projects.map((p) => p.id) },
    group: ["project_id"],
    raw: true,
  });
  const map = new Map(rows.map((r) => [Number(r.project_id), Number(r.n)]));
  projects.forEach((p) => (p.listCount = map.get(p.id) || 0));
  return projects;
}

// ============================================================
// DASHBOARD
// ============================================================

const DONE = ["completed", "cancelled"];
const isOpen = (o) => !DONE.includes(o.status);

// Days from today (Pakistan time) to an ISO date; negative = overdue
function daysUntil(isoDate, today) {
  const ms = new Date(`${isoDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

// Loads all subtasks of the given tasks (with assignee)
async function subtasksFor(tasks) {
  if (!tasks.length) return [];
  return Subtask.findAll({
    where: { task_id: tasks.map((t) => t.id) },
    include: [{ model: User, as: "assigned_to", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });
}

// Every subtask assigned to the user. Open ones first, then by due date.
async function mySubtasksFor(user) {
  const memberIds = [...(user.subtaskAccess ? user.subtaskAccess.keys() : [])];
  const rows = await Subtask.findAll({
    where: { [Op.or]: [{ assigned_to_id: user.id }, { id: { [Op.in]: [...memberIds, -1] } }] },
    include: [
      {
        model: Task,
        as: "task",
        attributes: ["id", "title"],
        include: [
          {
            model: ProjectList,
            as: "project_list",
            attributes: ["id", "project_id"],
            include: [{ model: Project, as: "project", attributes: ["id", "name"] }],
          },
        ],
      },
    ],
    order: [["id", "ASC"]],
  });
  const rank = (s) => (s.status === "completed" ? 1 : 0);
  return rows.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31")) ||
      a.id - b.id
  );
}

router.get("/", async (req, res) => {
  const user = req.user;
  const today = todayISO();
  const projectWhere = await readable(user, "project");
  const taskWhere = await readable(user, "task");

  let projects = [];
  let tasks = [];

  if (projectWhere) {
    projects = await Project.findAll({ where: projectWhere, order: [["id", "ASC"]] });
  }
  if (taskWhere) {
    tasks = await Task.findAll({
      where: taskWhere,
      include: [
        { model: ProjectList, as: "project_list", include: [{ model: Project, as: "project" }] },
        { model: User, as: "assigned_to", attributes: userAttrs },
      ],
      order: [["id", "ASC"]],
    });
  }

  await withListCounts(projects);

  // Subtasks (for the dropdown under each task)
  const subtasks = await subtasksFor(tasks);
  for (const task of tasks) {
    task.subtaskList = subtasks.filter((s) => s.task_id === task.id);
  }

  const mySubtasks = await mySubtasksFor(user);

  // ---- Summary numbers ----
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const overdueTasks = tasks.filter((t) => isOpen(t) && t.due_date && t.due_date < today);
  const stats = {
    totalProjects: projects.length,
    activeProjects: projects.filter((p) => p.status === "active").length,
    totalTasks: tasks.length,
    openTasks: tasks.filter(isOpen).length,
    completedTasks,
    completionRate: tasks.length ? Math.round((completedTasks / tasks.length) * 100) : 0,
    overdueTasks: overdueTasks.length,
    myOpenSubtasks: mySubtasks.filter(isOpen).length,
  };

  // ---- Tasks by status ----
  const statusBreakdown = TASK_STATUS.map(([value, label]) => {
    const count = tasks.filter((t) => t.status === value).length;
    return { value, label, count, percent: tasks.length ? Math.round((count / tasks.length) * 100) : 0 };
  });

  // ---- Upcoming deadlines: open tasks + my open subtasks, overdue or due within 7 days ----
  const deadlines = [];
  for (const t of tasks) {
    if (isOpen(t) && t.due_date && daysUntil(t.due_date, today) <= 7) {
      deadlines.push({ kind: "Task", title: t.title, url: `/task/${t.id}/`, due: t.due_date, days: daysUntil(t.due_date, today), project: t.project_list.project.name });
    }
  }
  for (const s of mySubtasks) {
    if (isOpen(s) && s.due_date && daysUntil(s.due_date, today) <= 7) {
      deadlines.push({ kind: "Subtask", title: s.title, url: `/task/${s.task.id}/`, due: s.due_date, days: daysUntil(s.due_date, today), project: s.task.project_list.project.name });
    }
  }

  // Follow-ups (open tasks + my open subtasks) missed or within 7 days
  for (const t of tasks) {
    if (isOpen(t) && t.follow_up_date && daysUntil(t.follow_up_date, today) <= 7) {
      deadlines.push({ kind: "Task follow-up", title: t.title, url: `/task/${t.id}/`, due: t.follow_up_date, days: daysUntil(t.follow_up_date, today), project: t.project_list.project.name,               followUp: true });
    }
  }
  for (const s of mySubtasks) {
    if (isOpen(s) && s.follow_up_date && daysUntil(s.follow_up_date, today) <= 7) {
      deadlines.push({ kind: "Subtask follow-up", title: s.title, url: `/task/${s.task.id}/`, due: s.follow_up_date, days: daysUntil(s.follow_up_date, today), project: s.task.project_list.project.name, followUp: true });
    }
  }

  deadlines.sort((a, b) => a.due.localeCompare(b.due));

  // ---- Recent activity on tasks this user can see ----
  const activityRead = await P.where(user, "activitylog", "read");
  const activityWhere = !activityRead || !taskWhere
    ? { id: -1 }
    : { [Op.and]: [activityRead, Object.keys(taskWhere).length ? { task_id: tasks.map((t) => t.id).concat(-1) } : {}] };
  const activity = await ActivityLog.unscoped().findAll({
    where: activityWhere,
    include: [
      { model: User, as: "user", attributes: userAttrs },
      { model: Task, as: "task", attributes: ["id", "title"] },
    ],
    order: [["created_at", "DESC"], ["id", "DESC"]],
    limit: 6,
  });

  // ---- Project progress (completed / total visible tasks) ----
  for (const p of projects) {
    const pt = tasks.filter((t) => t.project_list.project_id === p.id);
    p.taskCount = pt.length;
    p.doneCount = pt.filter((t) => t.status === "completed").length;
    p.progress = pt.length ? Math.round((p.doneCount / pt.length) * 100) : 0;
  }

  // ---- Most recently updated tasks ----
  const recentTasks = [...tasks]
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at) || b.id - a.id)
    .slice(0, 8);

  const hour = Number(new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Asia/Karachi" }));
  const greeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  res.render("core/dashboard", {
    title: "Dashboard",
    greeting,
    todayLabel: new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "Asia/Karachi" }),
    today,
    stats,
    statusBreakdown,
    deadlines: deadlines.slice(0, 6),
    activity,
    projects,
    recentTasks,
    mySubtasks,
    canEditSubtask: (s) => canEditSubtask(user, s),
    canAddTask: P.can(user, "task", "create"),
  });
});

// ============================================================
// TASKS PAGE (all tasks the user can see, with filters)
// ============================================================

router.get("/tasks/", async (req, res) => {
  const user = req.user;
  const projectWhere = await readable(user, "project");
  const taskWhere = await readable(user, "task");
  const today = todayISO();
  const q = String(req.query.q || "").trim();
  const f = {
    project: String(req.query.project || ""),
    status: String(req.query.status || ""),
    priority: String(req.query.priority || ""),
    mine: req.query.mine === "1",
  };

  let tasks = [];
  let projects = [];
  if (taskWhere) {
    projects = projectWhere
      ? await Project.findAll({ where: projectWhere, order: [["name", "ASC"]], attributes: ["id", "name"] })
      : [];

    const and = [taskWhere];
    if (TASK_STATUS.some(([v]) => v === f.status)) and.push({ status: f.status });
    if (TASK_PRIORITY.some(([v]) => v === f.priority)) and.push({ priority: f.priority });
    if (f.mine) and.push({ assigned_to_id: user.id });
    if (q) and.push({ [Op.or]: [{ title: { [Op.like]: `%${q}%` } }, { description: { [Op.like]: `%${q}%` } }] });

    const projectFilter = projects.some((p) => String(p.id) === f.project) ? { project_id: Number(f.project) } : undefined;

    tasks = await Task.findAll({
      where: { [Op.and]: and },
      include: [
        {
          model: ProjectList,
          as: "project_list",
          where: projectFilter,
          include: [{ model: Project, as: "project", attributes: ["id", "name"] }],
        },
        { model: User, as: "assigned_to", attributes: userAttrs },
      ],
      order: [["due_date", "ASC"], ["id", "ASC"]],
    });
    // Tasks without a due date go last
    tasks.sort((a, b) => (a.due_date ? 0 : 1) - (b.due_date ? 0 : 1));
  }

  const subtasks = await subtasksFor(tasks);
  for (const t of tasks) {
    const subs = subtasks.filter((s) => s.task_id === t.id);
    t.subtaskList = subs; // for the subtask list inside each card
    t.subtaskTotal = subs.length;
    t.subtaskDone = subs.filter((s) => s.status === "completed").length;
    t.isOverdue = isOpen(t) && t.due_date && t.due_date < today;
  }

  res.render("core/tasks/task_list", {
    title: "Tasks",
    tasks,
    projects,
    q,
    f,
    filtered: !!(q || f.project || f.status || f.priority || f.mine),
    TASK_STATUS,
    TASK_PRIORITY,
    canEditSubtask: (s) => canEditSubtask(user, s),
  });
});

// ============================================================
// NEW TASK (opens as a popup from the "New task" buttons)
// ============================================================

// Lists the user may add tasks to: lists of projects they can read
async function listChoicesFor(user) {
  const projectWhere = await readable(user, "project");
  if (!projectWhere) return [];
  const lists = await ProjectList.findAll({
    include: [{ model: Project, as: "project", where: projectWhere, attributes: ["id", "name"] }],
    order: [[{ model: Project, as: "project" }, "name", "ASC"], ["order", "ASC"], ["id", "ASC"]],
  });
  return lists.map((l) => [l.id, `${l.project.name} › ${l.name}`]);
}

async function newTaskFields(user) {
  const listField = { name: "project_list_id", label: "Project and list", type: "fk", required: true, choices: await listChoicesFor(user) };
  return [listField, ...P.applyFieldRules(user, "task", await coreForms.taskForm(), null)];
}

router.get("/tasks/new/", async (req, res) => {
  P.require(req.user, "task", "create");
  const fields = await newTaskFields(req.user);
  res.render("core/task_new", {
    title: "New task",
    fields,
    values: initialValues(fields, { status: "todo", priority: "normal", project_list_id: req.query.list || "" }),
    errors: {},
  });
});

router.post("/tasks/new/", async (req, res) => {
  P.require(req.user, "task", "create");
  const fields = await newTaskFields(req.user);
  const { data, errors, values } = cleanForm(fields, req.body);
  if (hasErrors(errors)) {
    return res.status(400).render("core/task_new", { title: "New task", fields, values, errors });
  }
  const task = await Task.create({ status: "todo", priority: "normal", ...data, created_by_id: req.user.id });
  await logActivity({ user: req.user, task, action: "Task created", details: task.title });
  req.flash("success", `Task "${task.title}" created.`);
  res.redirect(`/task/${task.id}/`);
});

// ============================================================
// SUBTASKS PAGE
//   Team Members: only subtasks assigned to them
//   Others with access: all subtasks of tasks they can see
// ============================================================

router.get("/subtasks/", async (req, res) => {
  const user = req.user;
  const projectWhere = await readable(user, "project");
  const subtaskWhere = await readable(user, "subtask");
  const today = todayISO();
  // Users who cannot read every subtask see only their own ("My Subtasks")
  const isTM = !P.canAll(user, "subtask", "read");
  const q = String(req.query.q || "").trim();
  const f = {
    project: String(req.query.project || ""),
    status: String(req.query.status || ""),
    mine: isTM || req.query.mine === "1",
  };

  let subtasks = [];
  let projects = [];
  if (subtaskWhere) {
    projects = projectWhere
      ? await Project.findAll({ where: projectWhere, order: [["name", "ASC"]], attributes: ["id", "name"] })
      : [];

    const and = [subtaskWhere];
    if (f.mine) {
      const memberIds = [...(user.subtaskAccess ? user.subtaskAccess.keys() : [])];
      and.push({ [Op.or]: [{ assigned_to_id: user.id }, { id: { [Op.in]: [...memberIds, -1] } }] });
    }
    if (SUBTASK_STATUS.some(([v]) => v === f.status)) and.push({ status: f.status });
    if (q) and.push({ title: { [Op.like]: `%${q}%` } });

    const projectFilter = projects.some((p) => String(p.id) === f.project) ? { project_id: Number(f.project) } : undefined;

    subtasks = await Subtask.findAll({
      where: { [Op.and]: and },
      include: [
        { model: User, as: "assigned_to", attributes: userAttrs },
        {
          model: Task,
          as: "task",
          attributes: ["id", "title"],
          required: true,
          include: [
            {
              model: ProjectList,
              as: "project_list",
              attributes: ["id", "project_id"],
              required: true,
              where: projectFilter,
              include: [{ model: Project, as: "project", attributes: ["id", "name"] }],
            },
          ],
        },
      ],
      order: [["id", "ASC"]],
    });

    const rank = (s) => (s.status === "completed" ? 1 : 0);
    subtasks.sort(
      (a, b) =>
        rank(a) - rank(b) ||
        String(a.due_date || "9999-12-31").localeCompare(String(b.due_date || "9999-12-31")) ||
        a.id - b.id
    );
    for (const s of subtasks) s.isOverdue = isOpen(s) && s.due_date && s.due_date < today;

    // Comments on each subtask: count + the latest one, shown in the list
    const ids = subtasks.map((s) => s.id);
    for (const s of subtasks) {
      s.commentCount = 0;
      s.latestComment = null;
    }
    if (ids.length) try {
      const countRows = await Comment.findAll({
        attributes: ["subtask_id", [sequelize.fn("COUNT", sequelize.col("id")), "n"], [sequelize.fn("MAX", sequelize.col("id")), "last_id"]],
        where: { subtask_id: ids },
        group: ["subtask_id"],
        raw: true,
      });
      const lastIds = countRows.map((r) => Number(r.last_id));
      const latest = lastIds.length
        ? await Comment.findAll({
            where: { id: lastIds },
            include: [{ model: User, as: "user", attributes: userAttrs }],
          })
        : [];
      const counts = new Map(countRows.map((r) => [Number(r.subtask_id), Number(r.n)]));
      const latestBySubtask = new Map(latest.map((c) => [Number(c.subtask_id), c]));
      for (const s of subtasks) {
        s.commentCount = counts.get(s.id) || 0;
        s.latestComment = latestBySubtask.get(s.id) || null;
      }
    } catch (err) {
      // Don't break the whole page if comments can't be loaded; log the real reason
      const detail = err.parent && err.parent.errors ? err.parent.errors.map((e) => e.message).join(" | ") : err.message;
      console.error("Could not load subtask comments:", detail);
    }
  }

  res.render("core/subtasks/subtask_list", {
    title: "Subtasks",
    subtasks,
    projects,
    q,
    f,
    isTM,
    filtered: !!(q || f.project || f.status || (!isTM && f.mine)),
    SUBTASK_STATUS,
    canEditSubtask: (s) => canEditSubtask(user, s),
    accessOf: (s) => P.subtaskAccess(user, s),
  });
});

// ============================================================
// PROJECT LIST
// ============================================================

router.get("/projects/", async (req, res) => {
  const projectWhere = await readable(req.user, "project");
  const projects = projectWhere ? await Project.findAll({ where: projectWhere, order: [["id", "ASC"]] }) : [];

  await withListCounts(projects);
  res.render("core/projects/project_list", { title: "Projects", projects });
});

// ============================================================
// PROJECT DETAIL / BOARD
// ============================================================

// ============================================================
// NEW / EDIT / DELETE PROJECT (popups from the Projects page and board)
//   Needs the Projects: Add / Edit / Delete ticks (Users & access).
// ============================================================

const projectFields = () => [
  { name: "name", label: "Name", type: "text", required: true, maxLength: 200 },
  { name: "description", label: "Description", type: "textarea", rows: 3 },
  { name: "status", label: "Status", type: "select", required: true, choices: PROJECT_STATUS },
  { name: "start_date", label: "Start date", type: "date" },
  { name: "end_date", label: "End date", type: "date" },
];

router.get("/projects/new/", async (req, res) => {
  P.require(req.user, "project", "create");
  const fields = projectFields();
  res.render("core/projects/project_form", { title: "New project", project: null, fields, values: initialValues(fields, { status: "planning" }), errors: {} });
});

router.post("/projects/new/", async (req, res) => {
  P.require(req.user, "project", "create");
  const fields = projectFields();
  const { data, errors, values } = cleanForm(fields, req.body);
  if (hasErrors(errors)) return res.status(400).render("core/projects/project_form", { title: "New project", project: null, fields, values, errors });
  const project = await Project.create({ ...data, created_by_id: req.user.id });
  // every project starts with a first list so tasks can be added straight away
  await ProjectList.create({ project_id: project.id, name: "To do", order: 0 });
  req.flash("success", `Project "${project.name}" created.`);
  res.redirect(`/projects/${project.id}/`);
});

router.get("/projects/:projectId/edit/", async (req, res) => {
  const project = await getOr404(Project, req.params.projectId);
  P.require(req.user, "project", "edit", project);
  const fields = projectFields();
  res.render("core/projects/project_form", { title: "Edit project", project, fields, values: initialValues(fields, project), errors: {} });
});

router.post("/projects/:projectId/edit/", async (req, res) => {
  const project = await getOr404(Project, req.params.projectId);
  P.require(req.user, "project", "edit", project);
  const fields = projectFields();
  const { data, errors, values } = cleanForm(fields, req.body);
  if (hasErrors(errors)) return res.status(400).render("core/projects/project_form", { title: "Edit project", project, fields, values, errors });
  await project.update(data);
  req.flash("success", "Project saved.");
  res.redirect(`/projects/${project.id}/`);
});

router.get("/projects/:projectId/delete/", async (req, res) => {
  const project = await getOr404(Project, req.params.projectId);
  P.require(req.user, "project", "delete", project);
  const taskCount = await Task.count({ include: [{ model: ProjectList, as: "project_list", where: { project_id: project.id } }] });
  res.render("core/projects/project_confirm_delete", { title: "Delete project", project, taskCount });
});

router.post("/projects/:projectId/delete/", async (req, res) => {
  const project = await getOr404(Project, req.params.projectId);
  P.require(req.user, "project", "delete", project);
  const name = project.name;
  await project.destroy();
  req.flash("success", `Project "${name}" deleted.`);
  res.redirect("/projects/");
});

router.get("/projects/:projectId/", async (req, res) => {
  const project = await getOr404(Project, req.params.projectId);
  const user = req.user;

  P.require(user, "project", "read", project);

  // Board: only the tasks this user can read
  const taskWhere = (await readable(user, "task")) || { id: -1 };
  const lists = await ProjectList.findAll({
    where: { project_id: project.id },
    order: [["order", "ASC"], ["id", "ASC"]],
  });

  const tasks = await Task.findAll({
    where: { ...taskWhere, project_list_id: lists.map((l) => l.id).concat(-1) },
    include: [{ model: User, as: "assigned_to", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });

  for (const list of lists) {
    list.board_tasks = tasks.filter((t) => t.project_list_id === list.id);
  }

  res.render("core/projects/project_detail", { title: project.name, project, lists });
});

// ============================================================
// TASK DETAIL
// ============================================================

router.get("/task/:taskId/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId, {
    include: [
      { model: User, as: "assigned_to", attributes: userAttrs },
      { model: User, as: "created_by", attributes: userAttrs },
      { model: ProjectList, as: "project_list", include: [{ model: Project, as: "project" }] },
    ],
  });

  P.require(req.user, "task", "read", task);

  const subtasks = await Subtask.findAll({
    where: { task_id: task.id },
    include: [{ model: User, as: "assigned_to", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });

  // Task-level comments only (subtask comments are shown on each subtask's page)
  const comments = await Comment.findAll({
    where: { task_id: task.id, subtask_id: null },
    include: [{ model: User, as: "user", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });

  // Number of comments on each subtask, shown in the subtask list
  const countRows = subtasks.length
    ? await Comment.findAll({
        attributes: ["subtask_id", [sequelize.fn("COUNT", sequelize.col("id")), "n"]],
        where: { subtask_id: subtasks.map((x) => x.id) },
        group: ["subtask_id"],
        raw: true,
      })
    : [];
  const commentCounts = new Map(countRows.map((r) => [Number(r.subtask_id), Number(r.n)]));
  subtasks.forEach((x) => (x.commentCount = commentCounts.get(x.id) || 0));

  res.render("core/task_detail", {
    title: task.title,
    task,
    subtasks,
    comments,
    commentValues: { comment: "" },
    perm: {
      editTask: canEditTask(req.user, task),
      deleteTask: P.can(req.user, "task", "delete", task),
      createSubtask: P.can(req.user, "subtask", "create"),
      editSubtask: (s) => canEditSubtask(req.user, s),
      deleteSubtask: (s) => P.can(req.user, "subtask", "delete", s),
      comment: P.can(req.user, "task", "comment", task),
    },
  });
});

// ============================================================
// EDIT TASK
// ============================================================

// The form follows the field rules for the user's roles (hidden /
// read-only fields), "Assigned to" needs the Assign permission, and
// Status needs Change status (and Change completed once it is completed).
async function taskFormFor(user, task) {
  return P.applyFieldRules(user, "task", await coreForms.taskForm(), task);
}

router.get("/task/:taskId/edit/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.requireEdit(req.user, "task", task, TASK_FIELDS);

  const fields = await taskFormFor(req.user, task);
  res.render("core/task_form", {
    title: "Edit Task",
    task,
    fields,
    values: initialValues(fields, task),
    errors: {},
  });
});

router.post("/task/:taskId/edit/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.requireEdit(req.user, "task", task, TASK_FIELDS);

  const fields = await taskFormFor(req.user, task);
  const { data, errors, values } = cleanForm(fields, req.body);

  if (hasErrors(errors)) {
    return res.status(400).render("core/task_form", {
      title: "Edit Task",
      task,
      fields,
      values: keepReadonlyValues(fields, values, task),
      errors,
    });
  }

  // Fields the user may not change never reach `data` (see applyFieldRules)

  const changed = Object.keys(data).filter((k) => String(task[k] ?? "") !== String(data[k] ?? ""));
  await task.update(data);

  if (changed.length) {
    await logActivity({ user: req.user, task, action: "Task updated", details: `Changed: ${changed.join(", ")}` });
  }

  req.flash("success", "Task saved.");
  res.redirect(`/task/${task.id}/`);
});

// ============================================================
// DELETE TASK
// ============================================================

router.get("/task/:taskId/delete/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.require(req.user, "task", "delete", task);
  res.render("core/task_confirm_delete", { title: "Delete Task", task });
});

router.post("/task/:taskId/delete/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.require(req.user, "task", "delete", task);

  const title = task.title;
  await sequelize.transaction(async (t) => {
    await task.destroy({ transaction: t });
    // task_id is null because the task no longer exists
    await logActivity({ user: req.user, action: "Task deleted", details: `Deleted task "${title}"` }, { transaction: t });
  });

  req.flash("success", `Task "${title}" deleted.`);
  res.redirect("/");
});

// ============================================================
// CREATE SUBTASK
// ============================================================

router.get("/task/:taskId/subtask/create/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.require(req.user, "task", "read", task);
  P.require(req.user, "subtask", "create");

  const fields = P.applyFieldRules(req.user, "subtask", await coreForms.subtaskForm(), null);
  res.render("core/subtask_form", {
    title: "Create Subtask",
    task,
    subtask: null,
    fields,
    values: initialValues(fields, { status: "todo" }),
    errors: {},
    memberRows: P.can(req.user, "subtask", "assign") ? await memberFormRows(null) : null,
    SUBTASK_ACCESS,
  });
});

router.post("/task/:taskId/subtask/create/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.require(req.user, "task", "read", task);
  P.require(req.user, "subtask", "create");

  const fields = P.applyFieldRules(req.user, "subtask", await coreForms.subtaskForm(), null);
  const { data, errors, values } = cleanForm(fields, req.body);
  const canManage = P.can(req.user, "subtask", "assign");

  const accessMap = readMemberAccess(req.body);

  if (hasErrors(errors)) {
    return res.status(400).render("core/subtask_form", {
      title: "Create Subtask",
      task,
      subtask: null,
      fields,
      values,
      errors,
      memberRows: canManage ? await memberFormRows(null, accessMap) : null,
      SUBTASK_ACCESS,
    });
  }

  const subtask = await Subtask.create({ ...data, task_id: task.id });
  if (canManage) await saveMembers(subtask, accessMap);
  await logActivity({ user: req.user, task, action: "Subtask created", details: subtask.title });

  req.flash("success", "Subtask created.");
  res.redirect(`/task/${task.id}/`);
});

// ============================================================
// SUBTASK DETAIL
//   Anyone who can see the parent task can open its subtasks.
// ============================================================

router.get("/subtask/:subtaskId/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId, {
    include: [
      { model: User, as: "assigned_to", attributes: userAttrs },
      {
        model: Task,
        as: "task",
        include: [
          { model: User, as: "assigned_to", attributes: userAttrs },
          { model: ProjectList, as: "project_list", include: [{ model: Project, as: "project" }] },
        ],
      },
    ],
  });

  P.require(req.user, "subtask", "read", subtask);

  // Other subtasks of the same task (that this user can read)
  const siblingRows = await Subtask.findAll({
    where: { task_id: subtask.task_id },
    include: [{ model: User, as: "assigned_to", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });

  const siblings = siblingRows.filter((x) => P.can(req.user, "subtask", "read", x));

  const comments = await Comment.findAll({
    where: { subtask_id: subtask.id },
    include: [{ model: User, as: "user", attributes: userAttrs }],
    order: [["id", "ASC"]],
  });

  const members = await SubtaskMember.findAll({
    where: { subtask_id: subtask.id },
    include: [{ model: User, as: "user", attributes: userAttrs }],
    order: [["access", "ASC"], ["id", "ASC"]],
  });

  res.render("core/subtask_detail", {
    title: subtask.title,
    subtask,
    task: subtask.task,
    siblings,
    comments,
    isOverdue: isOpen(subtask) && subtask.due_date && subtask.due_date < todayISO(),
    members,
    myAccess: P.subtaskAccess(req.user, subtask),
    canOpenTask: P.can(req.user, "task", "read", subtask.task),
    perm: {
      edit: canEditSubtask(req.user, subtask),
      delete: P.can(req.user, "subtask", "delete", subtask),
      manageMembers: P.can(req.user, "subtask", "assign", subtask),
      comment: P.can(req.user, "subtask", "comment", subtask),
    },
  });
});

// ============================================================
// ADD SUBTASK COMMENT
//   Anyone who can see the parent task can comment on its subtasks.
// ============================================================

router.post("/subtask/:subtaskId/comment/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId, {
    include: [{ model: Task, as: "task" }],
  });
  P.require(req.user, "subtask", "comment", subtask);

  const { data, errors } = cleanForm(coreForms.commentForm(), req.body);

  if (!hasErrors(errors)) {
    await Comment.create({
      comment: data.comment,
      task_id: subtask.task_id,
      subtask_id: subtask.id,
      user_id: req.user.id,
    });
    await logActivity({ user: req.user, task: subtask.task, action: "Subtask comment added", details: subtask.title });
  } else {
    req.flash("error", "Comment cannot be empty.");
  }

  res.redirect(`/subtask/${subtask.id}/#comments`);
});

router.get("/subtask/:subtaskId/comment/", () => {
  throw new P.PermissionDenied("Invalid request.");
});

// ============================================================
// EDIT SUBTASK
// ============================================================

// The form follows the field rules for the user's roles; "Assigned to" and
// the access table need the Assign permission.
async function subtaskFormFor(user, subtask) {
  return P.applyFieldRules(user, "subtask", await coreForms.subtaskForm(), subtask);
}

router.get("/subtask/:subtaskId/edit/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId);
  P.requireEdit(req.user, "subtask", subtask, SUBTASK_FIELDS);

  const fields = await subtaskFormFor(req.user, subtask);
  res.render("core/subtask_form", {
    title: "Edit Subtask",
    task: null,
    subtask,
    fields,
    values: initialValues(fields, subtask),
    errors: {},
    memberRows: P.can(req.user, "subtask", "assign", subtask) ? await memberFormRows(subtask) : null,
    SUBTASK_ACCESS,
  });
});

router.post("/subtask/:subtaskId/edit/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId);
  P.requireEdit(req.user, "subtask", subtask, SUBTASK_FIELDS);

  const fields = await subtaskFormFor(req.user, subtask);
  const { data, errors, values } = cleanForm(fields, req.body);
  const canManage = P.can(req.user, "subtask", "assign", subtask);
  const accessMap = readMemberAccess(req.body);

  if (hasErrors(errors)) {
    return res
      .status(400)
      .render("core/subtask_form", {
        title: "Edit Subtask",
        task: null,
        subtask,
        fields,
        values: keepReadonlyValues(fields, values, subtask),
        errors,
        memberRows: canManage ? await memberFormRows(subtask, accessMap) : null,
        SUBTASK_ACCESS,
      });
  }

  await subtask.update(data);
  if (canManage) await saveMembers(subtask, accessMap);
  await logActivity({ user: req.user, task: { id: subtask.task_id }, action: "Subtask updated", details: subtask.title });

  req.flash("success", "Subtask saved.");
  res.redirect(`/task/${subtask.task_id}/`);
});

// ============================================================
// DELETE SUBTASK
// ============================================================

router.get("/subtask/:subtaskId/delete/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId);
  P.require(req.user, "subtask", "delete", subtask);
  res.render("core/subtask_confirm_delete", { title: "Delete Subtask", subtask });
});

router.post("/subtask/:subtaskId/delete/", async (req, res) => {
  const subtask = await getOr404(Subtask, req.params.subtaskId);
  P.require(req.user, "subtask", "delete", subtask);

  const taskId = subtask.task_id;
  const title = subtask.title;
  await subtask.destroy();
  await logActivity({ user: req.user, task: { id: taskId }, action: "Subtask deleted", details: title });

  req.flash("success", "Subtask deleted.");
  res.redirect(`/task/${taskId}/`);
});

// ============================================================
// ADD COMMENT
// ============================================================

router.post("/task/:taskId/comment/", async (req, res) => {
  const task = await getOr404(Task, req.params.taskId);
  P.require(req.user, "task", "comment", task);

  const { data, errors } = cleanForm(coreForms.commentForm(), req.body);

  if (!hasErrors(errors)) {
    await Comment.create({ comment: data.comment, task_id: task.id, user_id: req.user.id });
    await logActivity({ user: req.user, task, action: "Comment added" });
  } else {
    req.flash("error", "Comment cannot be empty.");
  }

  res.redirect(`/task/${task.id}/`);
});

router.get("/task/:taskId/comment/", () => {
  throw new P.PermissionDenied("Invalid request.");
});

module.exports = router;