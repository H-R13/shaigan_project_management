# Shaigan Project Management (Node.js + SQL)

A Node.js port of the Django project. Same pages, same URLs, same roles and
permission rules, now running on **Express + EJS + Sequelize** with a SQL
database (MySQL by default; PostgreSQL and SQL Server also work).

## Requirements

- Node.js 18 or newer
- MySQL 8 or MariaDB 10.6+ (e.g. from XAMPP, WAMP, or the MySQL installer)

## Setup (Windows, macOS or Linux)

```bash
npm install
copy .env.example .env        # macOS/Linux: cp .env.example .env
```

Open `.env` and set your database login:

```ini
DB_DIALECT=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=project_management
DB_USER=root
DB_PASSWORD=your_mysql_password
SESSION_SECRET=any-long-random-text
```

Create the database tables and the four roles (Administrator, Project
Manager, Team Member, Viewer). The database itself is created automatically
if it doesn't exist:

```bash
npm run db:init
```

Then either **bring over your old Django data**:

```bash
npm run import:django -- ..\ProjectManagement\db.sqlite3
```

or **start fresh** with a new admin account:

```bash
npm run createsuperuser
```

Start the app:

```bash
npm start          # or: npm run dev   (restarts on file changes)
```

Open <http://localhost:3000> and log in.

## Moving from Django

`npm run import:django` copies users, roles, permissions, projects, lists,
tasks, subtasks, comments and activity logs, keeping the same IDs. Passwords
use the same format as Django, so **everyone logs in with their existing
password**. Import into an empty database only (right after `db:init`).

### Command equivalents

| Django | Node.js |
| --- | --- |
| `python manage.py migrate` | `npm run db:init` |
| `python manage.py createsuperuser` | `npm run createsuperuser` |
| `python manage.py runserver` | `npm run dev` |
| `/admin/` (Django admin) | `/admin/` (built-in management area) |
| `python manage.py test` | `npm test` |

## Using a different database

Change `DB_DIALECT` in `.env` and install the driver:

| Database | `DB_DIALECT` | Install |
| --- | --- | --- |
| MySQL / MariaDB | `mysql` | included |
| PostgreSQL | `postgres` | `npm install pg pg-hstore` |
| SQL Server | `mssql` | `npm install tedious` |
| SQLite (local testing) | `sqlite` | included (optional) |

For PostgreSQL and SQL Server, create the empty database yourself first,
then run `npm run db:init`.

`database/schema.mysql.sql` contains the plain SQL for all tables, if you
prefer to look at or create the schema by hand.

## Project structure

```
src/
  server.js              start the server
  app.js                 Express setup, sessions, error pages
  config/database.js     database connection (reads .env)
  models/index.js        tables and relationships   (was models.py)
  lib/permissions.js     role and permission rules  (was permissions.py)
  lib/coreForms.js       task/subtask/comment forms (was forms.py)
  lib/forms.js           form validation helper
  lib/password.js        Django-compatible password hashing
  routes/core.js         dashboard, projects, tasks (was views.py + urls.py)
  routes/auth.js         login / logout
  routes/admin.js        management area           (was admin.py)
  views/                 EJS templates             (was templates/)
  public/style.css       styles from base.html
scripts/                 db:init, createsuperuser, import:django
database/                schema.mysql.sql
test/                    unit tests (npm test)
```

## Roles

| Role | Can see | Can edit | Can delete | Can assign |
| --- | --- | --- | --- | --- |
| Administrator / superuser | everything | everything | yes | yes |
| Project Manager | everything | all tasks and subtasks | yes | only with the `assign_task` / `assign_subtask` permission |
| Team Member | only tasks and subtasks assigned to them | their own tasks and subtasks | no | never |
| Viewer | everything | nothing | no | no |

Only administrators can open the management area at `/admin/`, where you
create projects, lists and tasks and manage users and roles.

## Differences from the Django version

- **Reassigning tasks** now follows the rule written in `permissions.py`:
  only administrators and users with `assign_task` see the "Assigned to"
  field. In Django every Project Manager could reassign. Your imported
  Project Manager role has no permissions, so if Project Managers should
  assign tasks and create subtasks, go to **Administration → Roles →
  Project Manager** and add `assign_task` and `assign_subtask`.
  (A fresh `db:init` without importing gives Project Managers these
  already.)
- **Activity log** is now filled in when tasks, subtasks and comments
  change. Django had the table but never wrote to it.
- **Task page** shows Edit, Delete and Add subtask buttons only to people
  allowed to use them, and the task/subtask pages now use the main layout.
- **Logout** works (it is a POST form; the Django link stopped working in
  Django 5).
- **Sessions** are stored in the database (`sessions` table), so logins
  survive server restarts.

## Going live

- Set `NODE_ENV=production` and a long random `SESSION_SECRET`.
- Serve it over HTTPS (secure cookies are switched on in production).
- Run it with a process manager such as PM2: `npx pm2 start src/server.js`.
