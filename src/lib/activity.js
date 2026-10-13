const { ActivityLog } = require("../models");

// Records an entry in the activity_logs table.
// (The Django app had the ActivityLog model but never wrote to it.)
async function logActivity({ user, task = null, action, details = "" }, options = {}) {
  try {
    await ActivityLog.create(
      {
        user_id: user.id,
        task_id: task ? task.id : null,
        action: String(action).slice(0, 100),
        details,
      },
      options
    );
  } catch (err) {
    // Logging must never break the actual request
    console.error("Activity log failed:", err.message);
  }
}

module.exports = { logActivity };
