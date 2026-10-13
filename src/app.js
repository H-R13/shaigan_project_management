require("dotenv").config({ quiet: true });
const path = require("path");
const express = require("express");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const SequelizeStore = require("connect-session-sequelize")(session.Store);

const { sequelize } = require("./models");
const { loadUser } = require("./middleware/auth");
const { csrf, locals, shellData } = require("./middleware/locals");

const app = express();
const isProd = process.env.NODE_ENV === "production";

if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === "change-this-in-production")) {
  throw new Error("Set a strong SESSION_SECRET in .env before running in production.");
}

// ---------------------------------------------------------
// Views (EJS, with a shared layout like Django's base.html)
// ---------------------------------------------------------
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(expressLayouts);
app.set("layout", "layout");

app.disable("x-powered-by");
if (isProd) app.set("trust proxy", 1);

// Security headers (similar to Django's SecurityMiddleware / XFrameOptions)
app.use((req, res, next) => {
  res.set("X-Frame-Options", "DENY");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Referrer-Policy", "same-origin");
  next();
});

app.get("/favicon.ico", (req, res) => res.sendFile(path.join(__dirname, "public", "favicon.ico")));
app.use("/static", express.static(path.join(__dirname, "public"), { maxAge: isProd ? "7d" : 0 }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// ---------------------------------------------------------
// Sessions stored in the SQL database (table: sessions)
// ---------------------------------------------------------
const sessionStore = new SequelizeStore({ db: sequelize, tableName: "sessions" });
app.locals.sessionStore = sessionStore;

app.use(
  session({
    name: "pm.sid",
    secret: process.env.SESSION_SECRET || "dev-secret-change-me",
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 14, // 2 weeks, Django's default
    },
  })
);

app.use(loadUser);
app.use(locals); // before csrf so error pages always have user/role info
app.use(csrf);
app.use(shellData);

// ---------------------------------------------------------
// Routes (same URLs as the Django project)
// ---------------------------------------------------------
app.use("/", require("./routes/auth"));
app.use("/api", require("./routes/quick"));
app.use("/admin/permissions", require("./routes/permissions"));
app.use("/admin", require("./routes/admin"));
app.use("/", require("./routes/core"));

// 404
app.use((req, res) => {
  res.status(404).render("error", {
    title: "Page not found",
    status: 404,
    message: "The page you requested does not exist.",
    layout: req.user ? "layout" : "layout-plain",
  });
});

// Errors (PermissionDenied -> 403, NotFound -> 404)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.locals.user = req.user;
  res.locals.csrfToken = res.locals.csrfToken || (req.session && req.session.csrfToken) || "";
  res.status(status).render("error", {
    title: status === 403 ? "Permission denied" : status === 404 ? "Page not found" : "Server error",
    status,
    message: status >= 500 && isProd ? "Something went wrong. Please try again." : err.message,
    layout: req.user ? "layout" : "layout-plain",
  });
});

module.exports = app;
