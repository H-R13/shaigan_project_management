// The document types people can be given rights on (Administration >
// Users & access). To cover a new document type, add a row here: it then
// appears in the grid, and code checks it with P.can(user, "<key>", ...).
//
// Ticks:  add -> create (+ assign), edit, status -> change status,
//         comment, delete

const ACCESS_ACTIONS = [
  ["add", "Add"],
  ["edit", "Edit"],
  ["status", "Status"],
  ["comment", "Comment"],
  ["delete", "Delete"],
];

const ACCESS_DOCS = [
  { key: "project", label: "Projects", actions: ["add", "edit", "delete"] },
  { key: "projectlist", label: "Project lists", actions: ["add", "edit", "delete"] },
  { key: "task", label: "Tasks", actions: ["add", "edit", "status", "comment", "delete"], assign: true },
  { key: "subtask", label: "Subtasks", actions: ["add", "edit", "status", "comment", "delete"], assign: true },
];

// tick -> permission-engine actions
function engineActions(doc, tick) {
  if (tick === "add") return doc.assign ? ["create", "assign"] : ["create"];
  if (tick === "status") return ["change_status"];
  return [tick];
}

const HELP = {
  add: "Create new ones (and assign them)",
  edit: "Change title, dates and details",
  status: "Update the status",
  comment: "Write comments",
  delete: "Delete them",
};

module.exports = { ACCESS_ACTIONS, ACCESS_DOCS, engineActions, HELP };
