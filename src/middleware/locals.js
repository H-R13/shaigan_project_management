const crypto = require("crypto");
const P = require("../lib/permissions");
const { TASK_STATUS, SUBTASK_STATUS } = require("../lib/choices");
const { PermissionDenied } = P;

// ---------------------------------------------------------
// CSRF protection (replacement for {% csrf_token %})
// Every form includes <input type="hidden" name="_csrf" value="...">
// ---------------------------------------------------------
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const sent = (req.body && req.body._csrf) || req.get("x-csrf-token") || "";
    const a = Buffer.from(String(sent));
    const b = Buffer.from(req.session.csrfToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return next(new PermissionDenied("CSRF verification failed. Reload the page and try again."));
    }
  }
  next();
}

// ---------------------------------------------------------
// Template helpers (replacement for Django template filters)
// ---------------------------------------------------------
const TZ = "Asia/Karachi";

// Like Django's |date — "Oct. 2, 2026"
function formatDate(value) {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value;
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: typeof value === "string" ? "UTC" : TZ,
  });
}

// Like Django's datetime display — "Oct 2, 2026, 10:30 AM"
function formatDateTime(value) {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: TZ,
  });
}

// Like Django's |truncatechars
function truncate(str, n) {
  if (!str) return "";
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
}

// Coloured badge classes for statuses and priorities
function statusClass(value) {
  return `badge status-${String(value || "").replace(/[^a-z_]/g, "")}`;
}
function priorityClass(value) {
  return `badge priority-${String(value || "").replace(/[^a-z_]/g, "")}`;
}

// Today's date (YYYY-MM-DD) in Pakistan time
function todayISO() {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ });
}

// Simple line icons (inline SVG, no external files)
const ICONS = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
  projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2"/>',
  subtasks: '<path d="M5 4v12a2 2 0 0 0 2 2h4"/><path d="M5 9h6"/><rect x="13" y="6" width="8" height="6" rx="1.5"/><rect x="13" y="15" width="8" height="6" rx="1.5"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
};
function icon(name, size = 18) {
  const body = ICONS[name] || "";
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// Shown under the user's name in the sidebar: their role(s)
function roleName(user) {
  if (!user) return "";
  const names = user.groupNames || [];
  if (names.length) return names.join(", ");
  return user.is_superuser ? "Superuser" : "No role";
}

function locals(req, res, next) {
  const user = req.user;
  res.locals.user = user;
  res.locals.request = req;
  res.locals.currentPath = req.path;

  // Permission checks for templates: can('task', 'create'), can('task', 'edit', task)
  res.locals.can = (moduleKey, action, record) => !!user && P.can(user, moduleKey, action, record);
  // Inline editing: can this user change one field here / drag this task?
  res.locals.canSet = (moduleKey, field, record) => !!user && P.canSetField(user, moduleKey, field, record);
  res.locals.canMove = (task) => !!user && P.canMoveTask(user, task);
  res.locals.projectColor = projectColor;
  res.locals.TASK_STATUS_CHOICES = TASK_STATUS;
  res.locals.SUBTASK_STATUS_CHOICES = SUBTASK_STATUS;

  res.locals.formatDate = formatDate;
  res.locals.formatDateTime = formatDateTime;
  res.locals.truncate = truncate;
  res.locals.statusClass = statusClass;
  res.locals.priorityClass = priorityClass;
  res.locals.icon = icon;
  res.locals.todayISO = todayISO;
  res.locals.roleName = roleName(user);

  // One-time flash messages
  res.locals.messages = req.session.messages || [];
  req.session.messages = [];
  req.flash = (type, text) => {
    req.session.messages = req.session.messages || [];
    req.session.messages.push({ type, text });
  };

  next();
}

// Each project gets a stable colour (sidebar dot, board, task chips)
const PROJECT_COLORS = ["#0d6fae", "#0e9f6e", "#e8730c", "#7c3aed", "#d6409f", "#0f9fb0", "#c2410c", "#5145cd"];
function projectColor(id) {
  const n = Number(id) || 0;
  return PROJECT_COLORS[((n % PROJECT_COLORS.length) + PROJECT_COLORS.length) % PROJECT_COLORS.length];
}

// Data for the app shell: the user's projects (sidebar) and active people
// (assignee pickers). Loaded for logged-in page views only.
async function shellData(req, res, next) {
  try {
    const user = req.user;
    res.locals.sidebarProjects = [];
    res.locals.people = [];
    if (user && req.method === "GET" && !req.path.startsWith("/api/") && !req.path.startsWith("/static/")) {
      const { Project, User } = require("../models");
      const where = await P.where(user, "project", "read");
      if (where) {
        res.locals.sidebarProjects = await Project.findAll({
          where: { ...where, status: ["planning", "active", "on_hold"] },
          attributes: ["id", "name", "status"],
          order: [["name", "ASC"]],
          limit: 15,
        });
      }
      res.locals.people = await User.findAll({
        where: { is_active: true },
        attributes: ["id", "username", "first_name", "last_name"],
        order: [["username", "ASC"]],
      });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { csrf, locals, shellData, formatDate, formatDateTime, truncate, todayISO, statusClass, priorityClass, projectColor };