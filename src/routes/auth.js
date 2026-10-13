// Replacement for django.contrib.auth LoginView / LogoutView
const express = require("express");
const { User } = require("../models");
const { verifyPassword } = require("../lib/password");

const router = express.Router();

// Only allow redirects to paths on this site
function safeNext(next) {
  if (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\")) {
    return next;
  }
  return "/";
}

router.get("/login/", (req, res) => {
  if (req.user) return res.redirect(safeNext(req.query.next));
  res.render("registration/login", { layout: false, error: false, next: req.query.next || "", username: "", remember: false });
});

router.post("/login/", async (req, res, next) => {
  const username = (req.body.username || "").trim();
  const password = req.body.password || "";
  const nextUrl = req.body.next || "";
  const remember = req.body.remember === "1";

  const user = username ? await User.findOne({ where: { username } }) : null;
  const ok = user && user.is_active && (await verifyPassword(password, user.password));

  if (!ok) {
    return res
      .status(200)
      .render("registration/login", { layout: false, error: true, next: nextUrl, username, remember });
  }

  // Prevent session fixation: new session id on login
  req.session.regenerate(async (err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    // "Remember me": stay signed in for 30 days; otherwise until the browser closes
    if (remember) req.session.cookie.maxAge = 1000 * 60 * 60 * 24 * 30;
    else req.session.cookie.expires = false;
    user.last_login = new Date();
    await user.save({ fields: ["last_login"] });
    req.session.save(() => res.redirect(safeNext(nextUrl)));
  });
});

// Logout is POST-only (same as Django 5+)
router.post("/logout/", (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie("pm.sid");
    res.redirect("/login/");
  });
});

module.exports = router;
