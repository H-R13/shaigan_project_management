// Permission setup: the document types the engine knows, and the starting
// rules for the four built-in roles.
//
// What each role can SEE is stored in role_permissions ("read" rows) and
// edited in Administration > Users & access. What each person can DO is in
// user_rights.

const { sequelize, Group, RolePermission } = require("../models");

// Every action the engine understands
const ACTIONS = ["read", "create", "edit", "delete", "assign", "change_status", "edit_completed", "comment"];

// The document types (modules) and what makes a record "your own":
//   owner_rules     : a user field (assigned_to_id, ...) or "child:x" =
//                     contains an x that is your own
//   inherit_from    : a subtask borrows read/comment from its task
const MODULES = {
  administration: { label: "Administration area" },
  user: { label: "User" },
  group: { label: "Role" },
  project: { label: "Project", owner_rules: "created_by_id,child:projectlist" },
  projectlist: { label: "Project list", owner_rules: "child:task" },
  task: { label: "Task", owner_rules: "assigned_to_id,child:subtask" },
  subtask: { label: "Subtask", owner_rules: "assigned_to_id", inherit_from: "task", inherit_actions: "read,comment" },
  comment: { label: "Comment", owner_rules: "user_id" },
  activitylog: { label: "Activity log", owner_rules: "user_id" },
};

// role name -> { module: { action: scope } }
const ALL = "all";
const OWN = "own";
function every(actions, scope = ALL) {
  return Object.fromEntries(actions.map((a) => [a, scope]));
}
const DEFAULT_RULES = {
  // Everything, everywhere
  Administrator: "*",
  "Project Manager": {
    project: every(["read"]),
    projectlist: every(["read"]),
    task: every(["read", "edit", "delete", "assign", "change_status", "comment"]),
    subtask: every(["read", "create", "edit", "delete", "assign", "change_status", "comment"]),
    comment: every(["read"]),
    activitylog: every(["read"]),
  },
  "Team Member": {
    project: every(["read"], OWN),
    projectlist: every(["read"], OWN),
    task: every(["read", "comment"], OWN),
    subtask: every(["read", "edit", "change_status", "comment"], OWN),
    activitylog: every(["read"]),
  },
  Viewer: {
    project: every(["read"]),
    projectlist: every(["read"]),
    task: every(["read", "comment"]),
    subtask: every(["read", "comment"]),
    comment: every(["read"]),
    activitylog: every(["read"]),
  },
};
// Seeds the starting rules, only when no rules exist yet. (On upgrade, the
// migration turns these into each person's rights, then keeps only the
// "read" rows, which are what the roles grid shows.)
async function seedDefaultRules({ log = console.log } = {}) {
  if ((await RolePermission.count()) > 0) {
    log("  = permission rules already exist, left unchanged");
    return false;
  }
  await sequelize.transaction(async (t) => {
    for (const [roleName, rules] of Object.entries(DEFAULT_RULES)) {
      const group = await Group.findOne({ where: { name: roleName }, transaction: t });
      if (!group) continue;
      const rows = [];
      if (rules === "*") {
        for (const m of Object.keys(MODULES)) for (const a of ACTIONS) rows.push({ group_id: group.id, module_key: m, action_key: a, scope: ALL });
      } else {
        for (const [m, acts] of Object.entries(rules)) {
          for (const [a, scope] of Object.entries(acts)) rows.push({ group_id: group.id, module_key: m, action_key: a, scope });
        }
      }
      await RolePermission.bulkCreate(rows, { transaction: t });
      log(`  + starting rules for "${roleName}" (${rows.length})`);
    }
  });
  return true;
}

// Keeps only what the roles grid shows: "read" rows for the document types
// (and the activity log). Everything else a person may do is in user_rights.
const SEE_KEYS = ["project", "projectlist", "task", "subtask", "activitylog"];
async function pruneRoleRules() {
  const { Op } = require("sequelize");
  return RolePermission.destroy({
    where: { [Op.or]: [{ action_key: { [Op.ne]: "read" } }, { module_key: { [Op.notIn]: SEE_KEYS } }] },
  });
}

module.exports = { ACTIONS, MODULES, seedDefaultRules, pruneRoleRules, DEFAULT_RULES };
