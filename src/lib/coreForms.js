// Port of core/forms.py
const { User } = require("../models");
const { TASK_PRIORITY, TASK_STATUS, SUBTASK_STATUS } = require("./choices");

async function userChoices() {
  const users = await User.findAll({ order: [["username", "ASC"]] });
  return users.map((u) => [u.id, u.username]);
}

async function taskForm() {
  return [
    { name: "title", label: "Title", type: "text", required: true, maxLength: 255 },
    { name: "description", label: "Description", type: "textarea" },
    { name: "assigned_to_id", label: "Assigned to", type: "fk", choices: await userChoices() },
    { name: "priority", label: "Priority", type: "select", required: true, choices: TASK_PRIORITY },
    { name: "status", label: "Status", type: "select", required: true, choices: TASK_STATUS },
    { name: "start_date", label: "Start date", type: "date" },
    { name: "due_date", label: "Due date", type: "date" },
    { name: "follow_up_date", label: "Next follow-up date", type: "date" },
  ];
}

// Team Members: assigned_to is intentionally excluded.
async function teamMemberTaskForm() {
  return (await taskForm()).filter((f) => f.name !== "assigned_to_id");
}

async function subtaskForm() {
  return [
    { name: "title", label: "Title", type: "text", required: true, maxLength: 255 },
    { name: "assigned_to_id", label: "Assigned to", type: "fk", choices: await userChoices() },
    { name: "status", label: "Status", type: "select", required: true, choices: SUBTASK_STATUS },
    { name: "due_date", label: "Due date", type: "date" },
    { name: "follow_up_date", label: "Next follow-up date", type: "date" },
  ];
}

// Team Members: assigned_to is intentionally excluded.
async function teamMemberSubtaskForm() {
  return (await subtaskForm()).filter((f) => f.name !== "assigned_to_id");
}

function commentForm() {
  return [{ name: "comment", label: "Comment", type: "textarea", required: true, rows: 4, placeholder: "Write your comment..." }];
}

// Field names on the Edit Task / Edit Subtask pages (used to tell whether
// a user has anything left to change after field rules apply)
const TASK_FIELDS = ["title", "description", "assigned_to_id", "priority", "status", "start_date", "due_date", "follow_up_date"];
const SUBTASK_FIELDS = ["title", "assigned_to_id", "status", "due_date", "follow_up_date"];

module.exports = {
  TASK_FIELDS,
  SUBTASK_FIELDS,
  taskForm,
  teamMemberTaskForm,
  subtaskForm,
  teamMemberSubtaskForm,
  commentForm,
  userChoices,
};
