// Permission engine. All rules live in the database and are edited in
// Administration > Users & access — nothing here is tied to a role name.
//
//   Role permissions  : role x module x action -> "all" records or "own" records
//   Owner rules       : per module, what makes a record "your own"
//                       (a user field such as assigned_to_id, or "contains a
//                       child record that is your own", e.g. a task that has
//                       one of your subtasks)
//   Inheritance       : a module can borrow actions from its parent record
//                       (e.g. Subtask "read" from Task)
//   Sharing           : a subtask can be shared with a user as "Can edit" or
//                       "Read only" (subtask members)
//   Person            : Users & access sets what each role sees and what each
//                       person may do (see accessScopes)
//
// Superusers can do everything.
//
// Code asks questions like:
//   P.can(user, "task", "edit", task)            -> true/false (sync)
//   await P.where(user, "task", "read")          -> Sequelize where, or null
//   P.applyFieldRules(user, "task", fields, task) -> form fields for this user
//                                                    (status / assignee locks)

const { Op } = require("sequelize");

class PermissionDenied extends Error {
  constructor(message = "You do not have permission to perform this action.") {
    super(message);
    this.status = 403;
  }
}

class NotFound extends Error {
  constructor(message = "Not found.") {
    super(message);
    this.status = 404;
  }
}

// Models are required lazily (models -> nothing here, but routes load both)
let _models;
const M = () => _models || (_models = require("../models"));

// Field conventions the engine understands on any module
const ASSIGN_FIELD = "assigned_to_id"; // editable only with "assign"
const STATUS_FIELD = "status"; // editable only with "change_status"; locked
const COMPLETED = "completed"; //   when completed unless "edit_completed"

const split = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
const isAuthenticated = (user) => !!(user && user.id && user.is_active !== false);

// =========================================================
// CONFIG (cached briefly; cleared whenever rules are saved)
// =========================================================

const CONFIG_TTL_MS = 15000;
let configCache = null;

async function loadConfig() {
  if (configCache && Date.now() - configCache.at < CONFIG_TTL_MS) return configCache;
  const { MODULES } = require("./permissionSetup");
  const rolePerms = await M().RolePermission.findAll({ raw: true });
  configCache = {
    at: Date.now(),
    modules: new Map(
      Object.entries(MODULES).map(([key, m]) => [
        key,
        { key, ...m, inherit_from: m.inherit_from || "", ownerRules: split(m.owner_rules), inheritActions: split(m.inherit_actions) },
      ])
    ),
    rolePerms,
  };
  return configCache;
}

function invalidateConfig() {
  configCache = null;
}

// =========================================================
// MODULE <-> MODEL HELPERS (read from the Sequelize associations, so new
// models and fields show up automatically)
// =========================================================

function modelFor(key) {
  return Object.values(M().sequelize.models).find((m) => m.name.toLowerCase() === key) || null;
}

function fkOf(assoc) {
  return typeof assoc.foreignKey === "string" ? assoc.foreignKey : assoc.foreignKey.name;
}

// Fields linking a record to a user (assigned_to_id, created_by_id, user_id...)
function userLinkFields(key) {
  const model = modelFor(key);
  if (!model) return [];
  return Object.values(model.associations)
    .filter((a) => a.associationType === "BelongsTo" && a.target.name === "User")
    .map((a) => ({ field: fkOf(a), label: a.as.replace(/_/g, " ") }));
}

// Parent records (subtask -> task, task -> projectlist, ...)
function parentLinks(key) {
  const model = modelFor(key);
  if (!model) return [];
  return Object.values(model.associations)
    .filter((a) => a.associationType === "BelongsTo" && a.target.name !== "User")
    .map((a) => ({ parentKey: a.target.name.toLowerCase(), fk: fkOf(a), as: a.as, assoc: a }));
}

// Child records (task -> subtask, project -> projectlist, ...)
function childLinks(key) {
  const model = modelFor(key);
  if (!model) return [];
  const seen = new Set();
  return Object.values(model.associations)
    .filter((a) => a.associationType === "HasMany" && a.target.name !== "User")
    .map((a) => ({ childKey: a.target.name.toLowerCase(), fk: fkOf(a), model: a.target }))
    .filter((c) => !seen.has(c.childKey) && seen.add(c.childKey));
}


// =========================================================
// SHARING (record-level, per user)
// =========================================================

// Subtask members: "view" shares give read + comment, "edit" shares also
// give edit + change status.
const SHARES = {
  subtask(user, action) {
    const map = user.subtaskAccess || new Map();
    const needEdit = action === "edit" || action === "change_status";
    const viewOk = action === "read" || action === "comment";
    if (!needEdit && !viewOk) return new Set();
    return new Set([...map].filter(([, a]) => !needEdit || a === "edit").map(([id]) => id));
  },
};
const sharedIds = (user, key, action) => (SHARES[key] ? SHARES[key](user, action) : new Set());

// =========================================================
// PER-USER CONTEXT (built once per request by middleware/auth.js)
// =========================================================


// module:action -> "all" | "own" for a set of roles ("all" wins over "own")
function scopesFor(rolePerms, groupIds) {
  const scopes = new Map();
  for (const rp of rolePerms) {
    if (!groupIds.has(rp.group_id)) continue;
    const k = `${rp.module_key}:${rp.action_key}`;
    if (scopes.get(k) !== "all") scopes.set(k, rp.scope);
  }
  return scopes;
}

// ---------------------------------------------------------
// Simple access model (Administration > Users & access):
//   * the ROLE decides what a person can see: everything, only their own
//     work, or nothing (role "read" rules on projects/lists/tasks/subtasks)
//   * the PERSON's rights decide what they can do on what they can see:
//     one tick per document type and action (Add / Edit / Status /
//     Comment / Delete), stored in user_rights — see lib/accessDocs.js
//   * can_manage = Administration, full control, reopen completed work
// ---------------------------------------------------------
const { ACCESS_DOCS, engineActions } = require("./accessDocs");
const WORK_MODULES = ["project", "projectlist", "task", "subtask"];
const MANAGE_MODULES = ["project", "projectlist", "task", "subtask", "comment", "activitylog", "user", "group"];

// roleScopes: from the person's roles. person: { rights: Set("doc:tick"), can_manage }
function accessScopes(roleScopes, person = {}) {
  const rights = person.rights || new Set();
  const out = new Map();
  for (const m of [...WORK_MODULES, "activitylog"]) {
    const s = roleScopes.get(`${m}:read`);
    if (s) out.set(`${m}:read`, s);
  }
  // Per-person "See" choice (doc:see_all / see_own / see_none) replaces the role's
  const personal = new Map();
  for (const doc of ACCESS_DOCS) {
    for (const v of ["all", "own", "none"]) if (rights.has(`${doc.key}:see_${v}`)) personal.set(doc.key, v);
  }
  for (const [doc, v] of personal) {
    if (v === "none") out.delete(`${doc}:read`);
    else out.set(`${doc}:read`, v);
  }
  if (personal.size && ACCESS_DOCS.some((d) => out.has(`${d.key}:read`))) out.set("activitylog:read", out.get("activitylog:read") || "all");
  for (const doc of ACCESS_DOCS) {
    if (personal.get(doc.key) === "none") continue;
    const see = out.get(`${doc.key}:read`) || out.get("task:read") || null;
    if (!see) continue;
    for (const tick of doc.actions) {
      if (rights.has(`${doc.key}:${tick}`)) for (const a of engineActions(doc, tick)) out.set(`${doc.key}:${a}`, see);
    }
  }
  if (person.can_manage) {
    out.set("administration:read", "all");
    for (const m of MANAGE_MODULES) for (const a of ["read", "create", "edit", "delete"]) out.set(`${m}:${a}`, "all");
    for (const m of ["task", "subtask"]) for (const a of ["assign", "change_status", "edit_completed", "comment"]) out.set(`${m}:${a}`, "all");
  }
  return out;
}

async function buildUserContext(user) {
  const cfg = await loadConfig();
  user.cfg = cfg;
  user._memo = new Map();
  const groupIds = new Set((user.groups || []).map((g) => g.id));
  user.groupNames = (user.groups || []).map((g) => g.name);

  user.permScopes = accessScopes(scopesFor(cfg.rolePerms, groupIds), user);

  // "Own" record ids for modules whose owner rules need a lookup
  user.ownIds = new Map();
  for (const [key, mod] of cfg.modules) {
    if (!mod.ownerRules.some((r) => r.startsWith("child:"))) continue;
    if (![...user.permScopes].some(([k, s]) => s === "own" && k.startsWith(`${key}:`))) continue;
    const w = await ownWhere(user, key);
    user.ownIds.set(key, w ? await idsWhere(key, w) : new Set());
  }

  // Parent ids for inherited actions ({ all: true } or { ids: Set })
  user.inherited = new Map();
  for (const [key, mod] of cfg.modules) {
    if (!mod.inherit_from) continue;
    for (const action of mod.inheritActions) {
      if (user.permScopes.get(`${key}:${action}`) === "all") continue;
      const k = `${mod.inherit_from}:${action}`;
      if (!user.inherited.has(k)) user.inherited.set(k, await allowed(user, mod.inherit_from, action));
    }
  }
  return user;
}

async function idsWhere(key, where) {
  const model = modelFor(key);
  if (!model) return new Set();
  const rows = await model.unscoped().findAll({ where, attributes: ["id"], raw: true });
  return new Set(rows.map((r) => r.id));
}

// =========================================================
// QUERY FILTERS (for lists)
// =========================================================

// Records that are the user's "own" for a module (Sequelize where), or null
async function ownWhere(user, key, depth = 0) {
  if (depth > 6) return null;
  const mod = user.cfg.modules.get(key);
  if (!mod) return null;
  const userFields = new Set(userLinkFields(key).map((f) => f.field));
  const ors = [];
  for (const rule of mod.ownerRules) {
    if (rule.startsWith("child:")) {
      const link = childLinks(key).find((c) => c.childKey === rule.slice(6));
      if (!link) continue;
      const childOwn = await ownWhere(user, link.childKey, depth + 1);
      const childShared = sharedIds(user, link.childKey, "read");
      const childOrs = [];
      if (childOwn) childOrs.push(childOwn);
      if (childShared.size) childOrs.push({ id: { [Op.in]: [...childShared] } });
      if (!childOrs.length) continue;
      const rows = await link.model.unscoped().findAll({ where: { [Op.or]: childOrs }, attributes: [link.fk], raw: true });
      const ids = [...new Set(rows.map((r) => r[link.fk]).filter((x) => x != null))];
      if (ids.length) ors.push({ id: { [Op.in]: ids } });
    } else if (userFields.has(rule)) {
      ors.push({ [rule]: user.id });
    }
  }
  return ors.length ? { [Op.or]: ors } : null;
}

// { all: true } when every record is allowed, otherwise { where } (where is
// null when nothing is allowed)
async function allowedWhere(user, key, action) {
  const memoKey = `w:${key}:${action}`;
  if (user._memo && user._memo.has(memoKey)) return user._memo.get(memoKey);

  let result;

  const scope = user.is_superuser ? "all" : user.permScopes.get(`${key}:${action}`);
  if (scope === "all") {
    result = { all: true };
  } else {
    const ors = [];
    if (scope === "own") {
      const w = await ownWhere(user, key);
      if (w) ors.push(w);
    }
    const mod = user.cfg.modules.get(key);
    if (mod && mod.inherit_from && mod.inheritActions.includes(action)) {
      const link = parentLinks(key).find((p) => p.parentKey === mod.inherit_from);
      if (link) {
        const parent = await allowed(user, mod.inherit_from, action);
        if (parent.all) ors.push({ [link.fk]: { [Op.ne]: null } });
        else if (parent.ids.size) ors.push({ [link.fk]: { [Op.in]: [...parent.ids] } });
      }
    }
    const shared = sharedIds(user, key, action);
    if (shared.size) ors.push({ id: { [Op.in]: [...shared] } });
    result = { where: ors.length ? { [Op.or]: ors } : null };
  }
  if (user._memo) user._memo.set(memoKey, result);
  return result;
}

// { all: true } or { ids: Set }
async function allowed(user, key, action) {
  const r = await allowedWhere(user, key, action);
  if (r.all) return { all: true };
  return { ids: r.where ? await idsWhere(key, r.where) : new Set() };
}

// Sequelize where for list queries: {} for everything, or null for nothing
async function where(user, key, action = "read") {
  if (!isAuthenticated(user)) return null;
  const r = await allowedWhere(user, key, action);
  return r.all ? {} : r.where;
}

// =========================================================
// RECORD CHECKS (sync)
// =========================================================

function isOwn(user, key, record) {
  const mod = user.cfg && user.cfg.modules.get(key);
  if (!mod || !record) return false;
  const userFields = new Set(userLinkFields(key).map((f) => f.field));
  for (const rule of mod.ownerRules) {
    if (rule.startsWith("child:")) {
      if (user.ownIds && user.ownIds.has(key) && user.ownIds.get(key).has(record.id)) return true;
    } else if (userFields.has(rule) && record[rule] != null && record[rule] === user.id) {
      return true;
    }
  }
  return false;
}

function inheritedOk(user, key, action, record) {
  const mod = user.cfg && user.cfg.modules.get(key);
  if (!mod || !mod.inherit_from || !mod.inheritActions.includes(action)) return false;
  const parent = user.inherited && user.inherited.get(`${mod.inherit_from}:${action}`);
  if (!parent) return false;
  if (!record) return parent.all || parent.ids.size > 0;
  const link = parentLinks(key).find((p) => p.parentKey === mod.inherit_from);
  if (!link || record[link.fk] == null) return false;
  return parent.all || parent.ids.has(record[link.fk]);
}

// Can the user do `action` on `module`? With a record: on that record.
// Without a record: on at least some records (e.g. "may create").
function can(user, key, action, record) {
  if (!isAuthenticated(user)) return false;
  if (user.is_superuser) return true;
  if (!user.permScopes) return false;

  const scope = user.permScopes.get(`${key}:${action}`);
  if (!record) return !!scope || inheritedOk(user, key, action, null) || sharedIds(user, key, action).size > 0;
  if (scope === "all") return true;
  if (scope === "own" && isOwn(user, key, record)) return true;
  if (inheritedOk(user, key, action, record)) return true;
  return sharedIds(user, key, action).has(record.id);
}

// Can the user do `action` on every record (used by the Administration area)?
function canAll(user, key, action) {
  if (!isAuthenticated(user)) return false;
  if (user.is_superuser) return true;
  return !!user.permScopes && user.permScopes.get(`${key}:${action}`) === "all";
}

// =========================================================
// FORM FIELDS
// =========================================================

// Form fields for this user. `record` is null when creating.
// Assigned to needs Assign; Status needs Change status (and Change
// completed once the record is completed).
function applyFieldRules(user, key, fields, record = null) {
  const out = [];
  for (const f of fields) {
    if (f.name === ASSIGN_FIELD && !can(user, key, "assign", record || undefined)) continue;
    let readonly = !!f.readonly;
    if (f.name === STATUS_FIELD && record) {
      if (!can(user, key, "change_status", record)) readonly = true;
      if (record.status === COMPLETED && !can(user, key, "edit_completed", record)) readonly = true;
    }
    out.push(readonly ? { ...f, readonly: true, required: false } : f);
  }
  return out;
}

// Edit allowed AND at least one field is left to change
function canEdit(user, key, record, fieldNames) {
  if (!can(user, key, "edit", record)) return false;
  if (!fieldNames) return true;
  return applyFieldRules(user, key, fieldNames.map((name) => ({ name })), record).some((f) => !f.readonly);
}

// Can the user change one field of a record right now (inline edits)?
// Needs read access, and the field must be editable after field rules
// (status needs Change status, assigned_to_id needs Assign).
function canSetField(user, key, field, record) {
  if (!can(user, key, "read", record)) return false;
  return applyFieldRules(user, key, [{ name: field }], record).some((f) => !f.readonly);
}

// Can the user drag a task to another list?
function canMoveTask(user, task) {
  return can(user, "task", "edit", task) && canSetField(user, "task", "project_list_id", task);
}

// Access a user was given on a subtask through sharing: "edit", "view" or null
const subtaskAccess = (user, subtask) => (user.subtaskAccess && user.subtaskAccess.get(subtask.id)) || null;

// =========================================================
// ENFORCEMENT
// =========================================================

const NOUNS = { read: "view", create: "create", edit: "edit", delete: "delete", assign: "assign", comment: "comment on" };

function require_(user, key, action, record, message) {
  if (can(user, key, action, record)) return;
  const label = (user && user.cfg && user.cfg.modules.get(key) && user.cfg.modules.get(key).label) || key;
  throw new PermissionDenied(
    message || `You do not have permission to ${NOUNS[action] || action.replace(/_/g, " ")} this ${label.toLowerCase()}.`
  );
}

function requireEdit(user, key, record, fieldNames) {
  require_(user, key, "edit", record);
  if (!canEdit(user, key, record, fieldNames)) {
    if (record && record.status === COMPLETED && !can(user, key, "edit_completed", record)) {
      throw new PermissionDenied(`This ${key} is completed. You are not allowed to change it.`);
    }
    throw new PermissionDenied(`There is nothing on this ${key} you are allowed to change.`);
  }
}

module.exports = {
  PermissionDenied,
  NotFound,
  // config
  loadConfig,
  invalidateConfig,
  buildUserContext,
  scopesFor,
  accessScopes,
  // model helpers (used by the Permission Manager)
  modelFor,
  parentLinks,
  userLinkFields,
  // checks
  can,
  canAll,
  canEdit,
  where,
  allowed,
  isOwn,
  applyFieldRules,
  canSetField,
  canMoveTask,
  subtaskAccess,
  require: require_,
  requireEdit,
};
