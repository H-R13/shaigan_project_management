// Run with: npm test   (no database needed)
const test = require("node:test");
const assert = require("node:assert");
const P = require("../src/lib/permissions");
const { cleanForm } = require("../src/lib/forms");
const { hashPassword, verifyPassword } = require("../src/lib/password");

// Module config as it is stored in perm_modules
const MODULES = new Map(
  [
    { key: "task", ownerRules: ["assigned_to_id", "child:subtask"], inheritActions: [] },
    { key: "subtask", ownerRules: ["assigned_to_id"], inherit_from: "task", inheritActions: ["read", "comment"] },
    { key: "project", ownerRules: ["created_by_id", "child:projectlist"], inheritActions: [] },
  ].map((m) => [m.key, m])
);

// A user with a ready-made permission context (what buildUserContext makes)
function user(id, scopes = {}, extra = {}) {
  return {
    id,
    is_active: true,
    is_superuser: false,
    cfg: { modules: MODULES },
    permScopes: new Map(Object.entries(scopes)),
    ownIds: new Map(Object.entries(extra.ownIds || {}).map(([k, v]) => [k, new Set(v)])),
    inherited: new Map(Object.entries(extra.inherited || {})),
    subtaskAccess: new Map(extra.subtaskAccess || []),
  };
}

test("no rule means no access; 'all' allows every record", () => {
  const u = user(1, { "task:read": "all" });
  assert.ok(P.can(u, "task", "read", { id: 5, assigned_to_id: 99 }));
  assert.ok(!P.can(u, "task", "edit", { id: 5 }));
  assert.ok(!P.can(u, "task", "delete"));
});

test("'own' uses the module's owner rules (user fields and child records)", () => {
  const u = user(7, { "task:read": "own" }, { ownIds: { task: [20] } });
  assert.ok(P.can(u, "task", "read", { id: 1, assigned_to_id: 7 })); // assigned to me
  assert.ok(P.can(u, "task", "read", { id: 20, assigned_to_id: 3 })); // contains my subtask
  assert.ok(!P.can(u, "task", "read", { id: 21, assigned_to_id: 3 }));
  assert.ok(P.can(u, "task", "read")); // has some access (e.g. to show the menu)
});

test("subtasks inherit read/comment from their task", () => {
  const u = user(7, { "subtask:edit": "own" }, { inherited: { "task:read": { ids: new Set([1]) } } });
  assert.ok(P.can(u, "subtask", "read", { id: 9, task_id: 1, assigned_to_id: 3 }));
  assert.ok(!P.can(u, "subtask", "read", { id: 9, task_id: 2, assigned_to_id: 3 }));
  assert.ok(!P.can(u, "subtask", "edit", { id: 9, task_id: 1, assigned_to_id: 3 })); // not own
  assert.ok(P.can(u, "subtask", "edit", { id: 9, task_id: 1, assigned_to_id: 7 }));
});

test("subtask sharing: 'Can edit' members can edit, 'Read only' members can only read/comment", () => {
  const sub = { id: 50, task_id: 4, assigned_to_id: 99, status: "todo" };
  const editor = user(11, {}, { subtaskAccess: [[50, "edit"]] });
  const reader = user(12, {}, { subtaskAccess: [[50, "view"]] });
  const outsider = user(13);
  assert.ok(P.can(editor, "subtask", "read", sub) && P.can(editor, "subtask", "edit", sub));
  assert.ok(P.can(reader, "subtask", "read", sub) && P.can(reader, "subtask", "comment", sub));
  assert.ok(!P.can(reader, "subtask", "edit", sub));
  assert.ok(!P.can(outsider, "subtask", "read", sub));
});

test("several roles: 'all' beats 'own'", () => {
  const perms = [
    { group_id: 1, module_key: "task", action_key: "read", scope: "own" },
    { group_id: 2, module_key: "task", action_key: "read", scope: "all" },
    { group_id: 1, module_key: "task", action_key: "edit", scope: "own" },
  ];
  const scopes = P.scopesFor(perms, new Set([1, 2]));
  assert.strictEqual(scopes.get("task:read"), "all");
  assert.strictEqual(scopes.get("task:edit"), "own");
});

test("forms: Assigned to needs Assign, Status needs Change status", () => {
  const fields = ["title", "due_date", "assigned_to_id", "status"].map((name) => ({ name }));
  const u = user(1, { "task:edit": "all" });
  const onCreate = P.applyFieldRules(u, "task", fields, null);
  assert.deepStrictEqual(onCreate.map((f) => f.name), ["title", "due_date", "status"]); // no Assign
  const onEdit = P.applyFieldRules(u, "task", fields, { id: 1, status: "todo" });
  assert.ok(onEdit.find((f) => f.name === "status").readonly); // no Change status
  assert.ok(!onEdit.find((f) => f.name === "title").readonly);
  const pm = user(2, { "task:edit": "all", "task:assign": "all", "task:change_status": "all" });
  const pmEdit = P.applyFieldRules(pm, "task", fields, { id: 1, status: "todo" });
  assert.deepStrictEqual(pmEdit.filter((f) => f.readonly).map((f) => f.name), []);
});

test("status needs Change status, and Change completed once completed", () => {
  const fields = [{ name: "status" }];
  const pm = user(1, { "task:edit": "all", "task:change_status": "all" });
  const admin = user(2, { "task:edit": "all", "task:change_status": "all", "task:edit_completed": "all" });
  const done = { id: 1, status: "completed" };
  assert.ok(P.applyFieldRules(pm, "task", fields, done)[0].readonly);
  assert.ok(!P.applyFieldRules(admin, "task", fields, done)[0].readonly);
  assert.ok(P.applyFieldRules(user(3, { "task:edit": "all" }), "task", fields, { id: 1, status: "todo" })[0].readonly);
});

test("no Edit button when nothing is left to change", () => {
  const u = user(1, { "subtask:edit": "all" });
  assert.ok(P.canEdit(u, "subtask", { id: 1, status: "todo" }, ["title", "status"]));
  assert.ok(!P.canEdit(u, "subtask", { id: 1, status: "todo" }, ["status"])); // status needs Change status
  assert.throws(() => P.requireEdit(u, "subtask", { id: 1, status: "todo" }, ["status"]), P.PermissionDenied);
});

test("simple access: the role decides what you see, the person's rights what they do", () => {
  const roleSees = (scope) => new Map(["project", "projectlist", "task", "subtask"].map((m) => [`${m}:read`, scope]));
  const rights = (...r) => ({ rights: new Set(r) });
  // Can add tasks but not subtasks
  let s = P.accessScopes(roleSees("all"), rights("task:add"));
  assert.strictEqual(s.get("task:create"), "all");
  assert.strictEqual(s.get("task:assign"), "all");
  assert.ok(!s.has("subtask:create") && !s.has("subtask:assign"));
  // Team member: own work, subtask status only
  s = P.accessScopes(roleSees("own"), rights("subtask:status"));
  assert.strictEqual(s.get("subtask:change_status"), "own");
  assert.ok(!s.has("subtask:edit") && !s.has("task:change_status"));
  assert.ok(!s.has("task:comment")); // no Comment right
  s = P.accessScopes(roleSees("own"), rights("task:comment"));
  assert.strictEqual(s.get("task:comment"), "own");
  assert.ok(!s.has("subtask:comment"));
  // Projects and lists have their own rights
  s = P.accessScopes(roleSees("all"), rights("project:add", "projectlist:edit"));
  assert.strictEqual(s.get("project:create"), "all");
  assert.strictEqual(s.get("projectlist:edit"), "all");
  assert.ok(!s.has("project:delete") && !s.has("projectlist:create") && !s.has("task:create"));
  // Role sees nothing: rights give nothing
  s = P.accessScopes(new Map(), rights("task:add", "subtask:edit"));
  assert.strictEqual(s.size, 0);
  // Admin: full control
  s = P.accessScopes(new Map(), { can_manage: true });
  assert.strictEqual(s.get("administration:read"), "all");
  assert.strictEqual(s.get("task:edit_completed"), "all");
});

test("a person's own See choice replaces the role's for that document", () => {
  const role = new Map(["project", "projectlist", "task", "subtask"].map((m) => [`${m}:read`, "own"]));
  let s = P.accessScopes(role, { rights: new Set(["project:see_none", "project:edit", "task:see_all", "task:add"]) });
  assert.ok(!s.has("project:read") && !s.has("project:edit")); // hidden: ticks give nothing
  assert.strictEqual(s.get("task:read"), "all");
  assert.strictEqual(s.get("task:create"), "all");
  assert.strictEqual(s.get("subtask:read"), "own"); // unchanged: as role
  s = P.accessScopes(new Map(), { rights: new Set(["task:see_own", "task:comment"]) });
  assert.strictEqual(s.get("task:read"), "own");
  assert.strictEqual(s.get("task:comment"), "own");
});

test("require throws PermissionDenied (403)", () => {
  try {
    P.require(user(1), "task", "delete", { id: 1 });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof P.PermissionDenied);
    assert.strictEqual(e.status, 403);
  }
});

test("form validation", () => {
  const fields = [
    { name: "title", type: "text", required: true, maxLength: 5 },
    { name: "status", type: "select", required: true, choices: [["todo", "To Do"]] },
    { name: "due", type: "date" },
    { name: "user", type: "fk", choices: [[1, "a"]] },
  ];
  let r = cleanForm(fields, { title: "  ok ", status: "todo", due: "2026-02-28", user: "1" });
  assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.data, { title: "ok", status: "todo", due: "2026-02-28", user: 1 });

  r = cleanForm(fields, { title: "toolong", status: "x", due: "2026-02-30", user: "2" });
  assert.deepStrictEqual(Object.keys(r.errors).sort(), ["due", "status", "title", "user"]);
});

test("read-only fields are never taken from the submitted form", () => {
  const fields = [
    { name: "title", type: "text", readonly: true },
    { name: "status", type: "select", required: true, choices: [["todo", "To Do"], ["completed", "Completed"]] },
  ];
  const r = cleanForm(fields, { title: "Hacked", status: "todo" });
  assert.deepStrictEqual(r.errors, {});
  assert.deepStrictEqual(r.data, { status: "todo" }); // title ignored
});

test("passwords use Django's pbkdf2_sha256 format", async () => {
  const h = await hashPassword("secret", 1000);
  assert.match(h, /^pbkdf2_sha256\$1000\$/);
  assert.ok(await verifyPassword("secret", h));
  assert.ok(!(await verifyPassword("wrong", h)));
});
