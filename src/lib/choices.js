// Same choices as the Django models: [value, label] pairs.

const PROJECT_STATUS = [
  ["planning", "Planning"],
  ["active", "Active"],
  ["on_hold", "On Hold"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
];

const TASK_PRIORITY = [
  ["low", "Low"],
  ["normal", "Normal"],
  ["high", "High"],
  ["urgent", "Urgent"],
];

const TASK_STATUS = [
  ["todo", "To Do"],
  ["in_progress", "In Progress"],
  ["review", "Review"],
  ["completed", "Completed"],
  ["cancelled", "Cancelled"],
];

const SUBTASK_STATUS = [
  ["todo", "To Do"],
  ["in_progress", "In Progress"],
  ["completed", "Completed"],
];

// Role names (these were Django auth groups)
const ROLES = {
  ADMINISTRATOR: "Administrator",
  PROJECT_MANAGER: "Project Manager",
  TEAM_MEMBER: "Team Member",
  VIEWER: "Viewer",
};

function label(choices, value) {
  const found = choices.find(([v]) => v === value);
  return found ? found[1] : value;
}

module.exports = {
  PROJECT_STATUS,
  TASK_PRIORITY,
  TASK_STATUS,
  SUBTASK_STATUS,
  ROLES,
  label,
};
