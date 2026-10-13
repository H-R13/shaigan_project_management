// Quick actions used by the interactive pages (no full page reload):
//   POST /api/task/:id/status       { status }
//   POST /api/subtask/:id/status    { status }
//   POST /api/task/:id/assign       { assigned_to_id }   ("" = unassign)
//   POST /api/subtask/:id/assign    { assigned_to_id }
//   POST /api/task/:id/move         { project_list_id }  (board drag & drop)
//   POST /api/list/:listId/tasks    { title }            (board quick add)
//
// Every action goes through the same permission rules as the normal forms
// (Administration > Users & access), and is written to the activity log.
// Requests must send the CSRF token in the "X-CSRF-Token" header.

const express = require("express");
const { User, Project, ProjectList, Task, Subtask } = require("../models");
const { TASK_STATUS, SUBTASK_STATUS, label } = require("../lib/choices");
const { loginRequired } = require("../middleware/auth");
const { statusClass } = require("../middleware/locals");
const { logActivity } = require("../lib/activity");
const P = require("../lib/permissions");

const router = express.Router();
router.use(loginRequired);

const MODELS = { task: Task, subtask: Subtask };
const STATUSES = { task: TASK_STATUS, subtask: SUBTASK_STATUS };
const NAMES = { task: "Task", subtask: "Subtask" };

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Wraps a handler: JSON in, JSON out, errors as { ok: false, error }
const api = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, ...(await fn(req, res)) });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ ok: false, error: status >= 500 ? "Something went wrong. Please try again." : err.message });
  }
};

async function load(kind, id) {
  const n = Number(id);
  const obj = Number.isInteger(n) && n > 0 ? await MODELS[kind].findByPk(n) : null;
  if (!obj) throw new ApiError(404, `${NAMES[kind]} not found.`);
  return obj;
}

const taskOf = async (kind, obj) => (kind === "task" ? obj : { id: obj.task_id });
const nameOf = (u) => (u ? [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username : "");

// ---- status ----
for (const kind of ["task", "subtask"]) {
  router.post(`/${kind}/:id/status`, api(async (req) => {
    const obj = await load(kind, req.params.id);
    if (!P.canSetField(req.user, kind, "status", obj)) {
      throw new ApiError(403, obj.status === "completed"
        ? `This ${kind} is completed. You are not allowed to change its status.`
        : `You are not allowed to change the status of this ${kind}.`);
    }
    const value = String(req.body.status || "");
    if (!STATUSES[kind].some(([v]) => v === value)) throw new ApiError(400, "Choose a valid status.");
    const before = obj.status;
    if (before !== value) {
      await obj.update({ status: value });
      await logActivity({
        user: req.user,
        task: await taskOf(kind, obj),
        action: `${NAMES[kind]} status changed`,
        details: `${obj.title}: ${label(STATUSES[kind], before)} → ${label(STATUSES[kind], value)}`,
      });
    }
    return {
      status: value,
      label: label(STATUSES[kind], value),
      className: statusClass(value),
      // the user may have just locked themselves out (completed)
      editable: P.canSetField(req.user, kind, "status", obj),
    };
  }));

  router.post(`/${kind}/:id/assign`, api(async (req) => {
    const obj = await load(kind, req.params.id);
    if (!P.canSetField(req.user, kind, "assigned_to_id", obj)) {
      throw new ApiError(403, `You are not allowed to change who this ${kind} is assigned to.`);
    }
    const raw = String(req.body.assigned_to_id || "");
    let assignee = null;
    if (raw) {
      assignee = await User.findOne({ where: { id: Number(raw), is_active: true } });
      if (!assignee) throw new ApiError(400, "Choose an active user.");
    }
    if ((obj.assigned_to_id || null) !== (assignee ? assignee.id : null)) {
      await obj.update({ assigned_to_id: assignee ? assignee.id : null });
      await logActivity({
        user: req.user,
        task: await taskOf(kind, obj),
        action: `${NAMES[kind]} assigned`,
        details: `${obj.title}: ${assignee ? assignee.username : "unassigned"}`,
      });
    }
    return {
      assigned_to_id: assignee ? assignee.id : null,
      username: assignee ? assignee.username : "",
      name: nameOf(assignee),
    };
  }));
}

// ---- move a task to another list of the same project (board) ----
router.post("/task/:id/move", api(async (req) => {
  const task = await load("task", req.params.id);
  if (!P.canMoveTask(req.user, task)) throw new ApiError(403, "You are not allowed to move this task.");
  const [from, to] = await Promise.all([
    ProjectList.findByPk(task.project_list_id),
    ProjectList.findByPk(Number(req.body.project_list_id) || 0),
  ]);
  if (!to || !from || to.project_id !== from.project_id) throw new ApiError(400, "Choose a list in the same project.");
  if (to.id !== from.id) {
    await task.update({ project_list_id: to.id });
    await logActivity({ user: req.user, task, action: "Task moved", details: `${task.title}: ${from.name} → ${to.name}` });
  }
  return { project_list_id: to.id, list: to.name };
}));

// ---- quick add a task to a list (board) ----
router.post("/list/:listId/tasks", api(async (req) => {
  const list = await ProjectList.findByPk(Number(req.params.listId) || 0, {
    include: [{ model: Project, as: "project" }],
  });
  if (!list) throw new ApiError(404, "List not found.");
  if (!P.can(req.user, "project", "read", list.project) || !P.can(req.user, "task", "create")) {
    throw new ApiError(403, "You are not allowed to add tasks here.");
  }
  const title = String(req.body.title || "").trim();
  if (!title) throw new ApiError(400, "Type a task title first.");
  if (title.length > 255) throw new ApiError(400, "Keep the title under 255 characters.");
  const task = await Task.create({
    title,
    project_list_id: list.id,
    created_by_id: req.user.id,
    status: "todo",
    priority: "normal",
  });
  await logActivity({ user: req.user, task, action: "Task created", details: `${title} (in ${list.name})` });
  return {
    id: task.id,
    title: task.title,
    url: `/task/${task.id}/`,
    priority: task.priority,
    priorityLabel: task.getPriorityDisplay(),
    status: task.status,
    statusLabel: task.getStatusDisplay(),
    canMove: P.canMoveTask(req.user, task),
  };
}));

// ---- lists on the project board ----
router.post("/project/:id/lists", api(async (req) => {
  const project = await Project.findByPk(Number(req.params.id) || 0);
  if (!project) throw new ApiError(404, "Project not found.");
  if (!P.can(req.user, "project", "read", project) || !P.can(req.user, "projectlist", "create")) {
    throw new ApiError(403, "You are not allowed to add lists here.");
  }
  const name = String(req.body.name || "").trim();
  if (!name) throw new ApiError(400, "Type a name for the list.");
  if (name.length > 200) throw new ApiError(400, "Keep the name under 200 characters.");
  const last = await ProjectList.max("order", { where: { project_id: project.id } });
  const list = await ProjectList.create({ project_id: project.id, name, order: (Number(last) || 0) + 1 });
  return { id: list.id, name: list.name };
}));

router.post("/list/:id/rename", api(async (req) => {
  const list = await ProjectList.findByPk(Number(req.params.id) || 0);
  if (!list) throw new ApiError(404, "List not found.");
  if (!P.can(req.user, "projectlist", "edit", list)) throw new ApiError(403, "You are not allowed to rename this list.");
  const name = String(req.body.name || "").trim();
  if (!name) throw new ApiError(400, "Type a name for the list.");
  await list.update({ name: name.slice(0, 200) });
  return { name: list.name };
}));

router.post("/list/:id/delete", api(async (req) => {
  const list = await ProjectList.findByPk(Number(req.params.id) || 0);
  if (!list) throw new ApiError(404, "List not found.");
  if (!P.can(req.user, "projectlist", "delete", list)) throw new ApiError(403, "You are not allowed to delete this list.");
  const tasks = await Task.count({ where: { project_list_id: list.id } });
  if (tasks) throw new ApiError(400, `Move or delete the ${tasks} ${tasks === 1 ? "task" : "tasks"} in "${list.name}" first.`);
  await list.destroy();
  return {};
}));

module.exports = router;
