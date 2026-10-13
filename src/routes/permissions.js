// Administration > Users & access
//   /admin/permissions/              roles (what they see) and people (what they do)
//   POST /admin/permissions/roles/   save what each role can see, per document
//   POST /admin/permissions/person/:id/  save one person's role, See choices, ticks and Admin
//
// Needs: access to Administration + "Edit" on roles.

const express = require("express");
const { sequelize, Group, RolePermission } = require("../models");
const { ACCESS_DOCS, ACCESS_ACTIONS, HELP } = require("../lib/accessDocs");
const { adminRequired } = require("../middleware/auth");
const P = require("../lib/permissions");
const { PermissionDenied, NotFound } = P;

const router = express.Router();
router.use(adminRequired);
router.use((req, res, next) => {
  if (!P.canAll(req.user, "group", "edit")) {
    return next(new PermissionDenied("You do not have permission to manage permissions."));
  }
  next();
});

async function roles() {
  return Group.findAll({ order: [["name", "ASC"]] });
}

function done(req, res, message, url) {
  P.invalidateConfig();
  req.flash("success", message);
  res.redirect(url);
}

// =========================================================
// USERS & ACCESS — the one simple screen
//   Roles:  what people can SEE (View All / View Assigned / View None)
//   People: each person's role, and ticks for Add / Change / Delete / Admin
// =========================================================

const SEE_MODULES = ["project", "projectlist", "task", "subtask"];
const SEE_CHOICES = [
  ["all", "View All"],
  ["own", "View Assigned"],
  ["none", "View None"],
];

// role id -> Map(document -> "all" | "own"); a missing document = View None
async function roleSees() {
  const rows = await RolePermission.findAll({ where: { module_key: SEE_MODULES, action_key: "read" }, raw: true });
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r.group_id)) out.set(r.group_id, new Map());
    out.get(r.group_id).set(r.module_key, r.scope);
  }
  return out;
}

router.get("/", async (req, res) => {
  const { User, UserGroup, UserRight } = require("../models");
  const roleList = await roles();
  const sees = await roleSees();
  const links = await UserGroup.findAll({ raw: true });
  const users = await User.findAll({ order: [["is_active", "DESC"], ["username", "ASC"]] });
  const roleOf = new Map();
  for (const l of links) if (!roleOf.has(l.user_id)) roleOf.set(l.user_id, l.group_id);
  const counts = new Map();
  for (const l of links) counts.set(l.group_id, (counts.get(l.group_id) || 0) + 1);
  const person = users.find((u) => String(u.id) === String(req.query.person)) || users.find((u) => !u.is_superuser) || users[0] || null;
  const rights = person ? new Set((await UserRight.findAll({ where: { user_id: person.id }, raw: true })).map((r) => `${r.doc}:${r.action}`)) : new Set();
  const others = users.filter((u) => person && u.id !== person.id && !u.is_superuser);
  res.render("admin/permissions/access", {
    title: "Users & access",
    roleList,
    sees,
    counts,
    users,
    roleOf,
    person,
    rights,
    others,
    multi: new Set(links.map((l) => l.user_id).filter((id, i, a) => a.indexOf(id) !== i)),
    SEE_CHOICES,
    ACCESS_DOCS,
    ACCESS_ACTIONS,
    HELP,
  });
});

// Roles: what they can see, one choice per document type
router.post("/roles/", async (req, res) => {
  const roleList = await roles();
  await sequelize.transaction(async (t) => {
    for (const role of roleList) {
      const rows = [];
      let any = false;
      for (const doc of SEE_MODULES) {
        const choice = req.body[`see_${role.id}__${doc}`];
        if (!SEE_CHOICES.some(([v]) => v === choice)) continue; // not on the form: leave alone
        await RolePermission.destroy({ where: { group_id: role.id, action_key: "read", module_key: doc }, transaction: t });
        if (choice !== "none") rows.push({ group_id: role.id, module_key: doc, action_key: "read", scope: choice });
      }
      if (rows.length) await RolePermission.bulkCreate(rows, { transaction: t });
      // the activity log follows: visible when the role sees anything
      any = (await RolePermission.count({ where: { group_id: role.id, action_key: "read", module_key: SEE_MODULES }, transaction: t })) > 0;
      await RolePermission.destroy({ where: { group_id: role.id, action_key: "read", module_key: "activitylog" }, transaction: t });
      if (any) await RolePermission.create({ group_id: role.id, module_key: "activitylog", action_key: "read", scope: "all" }, { transaction: t });
    }
  });
  done(req, res, "Roles saved.", "/admin/permissions/");
});

// One person: role, Admin tick, and one tick per document type and action
router.post("/person/:id/", async (req, res) => {
  const { User, UserRight } = require("../models");
  const person = await User.findByPk(Number(req.params.id));
  if (!person) throw new NotFound("Person not found.");
  const back = `/admin/permissions/?person=${person.id}#person`;
  if (person.is_superuser) {
    req.flash("error", "Superusers can always do everything; there is nothing to set.");
    return res.redirect(back);
  }
  const roleIds = new Set((await roles()).map((g) => g.id));
  let manage = req.body.can_manage === "1";
  if (person.id === req.user.id && !req.user.is_superuser && person.can_manage && !manage) {
    manage = true;
    req.flash("error", "You can't remove your own Admin tick. Ask another admin to do it.");
  }
  // "Same as …": copy another person's rights
  let rows;
  const copyFrom = Number(req.body.copy_from) || 0;
  if (copyFrom) {
    const src = await UserRight.findAll({ where: { user_id: copyFrom }, raw: true });
    rows = src.map((r) => ({ user_id: person.id, doc: r.doc, action: r.action }));
  } else {
    rows = [];
    for (const doc of ACCESS_DOCS) {
      for (const tick of doc.actions) {
        if (req.body[`r__${doc.key}__${tick}`] === "1") rows.push({ user_id: person.id, doc: doc.key, action: tick });
      }
      const see = String(req.body[`see__${doc.key}`] || "");
      if (["all", "own", "none"].includes(see)) rows.push({ user_id: person.id, doc: doc.key, action: `see_${see}` });
    }
  }
  await sequelize.transaction(async (t) => {
    await person.update({ can_manage: manage }, { transaction: t });
    await UserRight.destroy({ where: { user_id: person.id }, transaction: t });
    if (rows.length) await UserRight.bulkCreate(rows, { transaction: t });
    const role = String(req.body.role || "");
    if (role !== String(req.body.orig_role || "")) {
      const gid = Number(role);
      await person.setGroups(roleIds.has(gid) ? [gid] : [], { transaction: t });
    }
  });
  done(req, res, `${person.username} saved.`, back);
});

module.exports = router;
