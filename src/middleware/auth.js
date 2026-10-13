const { User, Group, SubtaskMember, UserRight } = require("../models");
const P = require("../lib/permissions");
const { PermissionDenied } = P;

// Load the logged-in user (with roles and permission context) on every
// request, like Django's AuthenticationMiddleware.
async function loadUser(req, res, next) {
  req.user = null;
  try {
    if (req.session && req.session.userId) {
      const user = await User.findByPk(req.session.userId, {
        include: [{ model: Group, as: "groups", through: { attributes: [] } }],
      });

      if (user && user.is_active) {
        // Subtasks shared with this user (subtask id -> "edit" | "view")
        const memberships = await SubtaskMember.findAll({ where: { user_id: user.id }, raw: true });
        user.subtaskAccess = new Map(memberships.map((m) => [m.subtask_id, m.access]));
        // What this person may do (Users & access)
        const rights = await UserRight.findAll({ where: { user_id: user.id }, raw: true });
        user.rights = new Set(rights.map((r) => `${r.doc}:${r.action}`));

        await P.buildUserContext(user);
        req.user = user;
      } else {
        delete req.session.userId;
      }
    }
    next();
  } catch (err) {
    next(err);
  }
}

// Equivalent of @login_required
function loginRequired(req, res, next) {
  if (req.user) return next();
  const nextUrl = encodeURIComponent(req.originalUrl);
  return res.redirect(`/login/?next=${nextUrl}`);
}

// Access to the management area (replacement for Django admin)
function adminRequired(req, res, next) {
  if (!req.user) return loginRequired(req, res, next);
  if (!P.can(req.user, "administration", "read")) {
    return next(new PermissionDenied("You do not have access to the Administration area."));
  }
  next();
}

module.exports = { loadUser, loginRequired, adminRequired };